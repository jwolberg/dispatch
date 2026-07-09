import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { RequestHandler, Response } from "express";
import { getDb, DB_PATH } from "./migrate.js";
import { safeMessage } from "../lib/redaction.js";

/**
 * Durable state on Cloud Run without a mounted volume (#20).
 *
 * The SQLite file lives on the container's ephemeral disk, so every redeploy
 * wipes it. The three options that look obvious are all wrong here:
 *
 *  - **Filestore (what DEPLOY.md §4 suggests)** has a 1 TiB minimum, ~$164/mo,
 *    to protect a file measured in kilobytes. It also needs a VPC and Direct
 *    VPC egress.
 *  - **GCS FUSE** is disqualified by Google's own docs: it "does not support
 *    file locking", is "not POSIX compliant", and "shouldn't be used as the
 *    backend for storing a database." SQLite would corrupt silently.
 *  - **Litestream** replicates on a background ticker, and this service runs
 *    request-based billing — CPU is throttled outside requests, so the ticker
 *    would not reliably fire. Fixing that means instance-based billing, where
 *    you are "charged for the entire lifecycle of the instance", all month.
 *
 * What is actually at risk is small and rarely written. `schema.sql` states the
 * provider is the source of truth: every `*_cache` table is disposable, and
 * `poller/discover.ts` re-adopts open issues into `tickets`. Only `repos`,
 * `chats`, `spend` — and the record of already-shipped tickets — cannot be
 * rebuilt.
 *
 * So: mark the DB dirty when one of those tables is written, and upload a
 * consistent snapshot to a GCS object *before the response is sent* (CPU is
 * allocated during a request). Restore it on boot when the local file is
 * missing. No new dependency, no billing change, no infrastructure but a bucket.
 *
 * Disabled entirely unless `DISPATCH_GCS_BUCKET` is set, so local development —
 * where `data/` on the developer's disk is exactly right — is untouched.
 */

export interface SnapshotConfig {
  bucket: string;
  object: string;
}

export interface SnapshotDeps {
  config: SnapshotConfig | null;
  fetchImpl: typeof fetch;
  getToken: () => Promise<string>;
}

export interface FlushDeps extends SnapshotDeps {
  /** A consistent copy of the DB. Defaults to `VACUUM INTO` a temp file. */
  snapshotBytes: () => Buffer;
}

const GCS = "https://storage.googleapis.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export function snapshotConfig(): SnapshotConfig | null {
  const bucket = process.env.DISPATCH_GCS_BUCKET;
  if (!bucket) return null;
  return { bucket, object: process.env.DISPATCH_GCS_OBJECT || "dispatch.db" };
}

/** GCS takes the object name as one path segment — a `/` must be encoded. */
export function downloadUrl(bucket: string, object: string): string {
  return `${GCS}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
}

export function uploadUrl(bucket: string, object: string): string {
  return `${GCS}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
}

/**
 * An access token from the Cloud Run metadata server. No SDK, no key file — the
 * runtime service account is already attached to the instance.
 */
export async function metadataToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata token request failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("metadata token response had no access_token");
  return body.access_token;
}

// Only the tables the provider cannot rebuild set this. A poll cycle writes
// status_cache/http_cache and must not cost an upload.
let dirty = false;
export function markDirty(): void {
  dirty = true;
}
export function isDirty(): boolean {
  return dirty;
}
export function clearDirty(): void {
  dirty = false;
}

/** `VACUUM INTO` yields a consistent copy even with WAL mode and open readers. */
function vacuumInto(): Buffer {
  const tmp = join(tmpdir(), `dispatch-snapshot-${process.pid}-${Date.now()}.db`);
  rmSync(tmp, { force: true }); // VACUUM INTO refuses to overwrite an existing file
  try {
    getDb().prepare("VACUUM INTO ?").run(tmp);
    return readFileSync(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Pull the snapshot down when the local DB is absent. Called before the schema
 * is applied, so a restored file keeps its rows.
 *
 * A 404 means "first boot against a fresh bucket" and is fine. Any other error
 * throws: booting with an empty DB after a transient 503 would overwrite the
 * good snapshot on the very next write.
 */
export async function restoreIfMissing(
  dbPath: string = DB_PATH,
  deps: SnapshotDeps = defaultDeps()
): Promise<void> {
  const { config, fetchImpl, getToken } = deps;
  if (!config) return;
  if (existsSync(dbPath)) return;

  const res = await fetchImpl(downloadUrl(config.bucket, config.object), {
    headers: { Authorization: `Bearer ${await getToken()}` },
  });
  if (res.status === 404) {
    console.log(`[dispatch] no snapshot at gs://${config.bucket}/${config.object} — first boot`);
    return;
  }
  if (!res.ok) throw new Error(`snapshot restore failed: ${res.status}`);

  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, Buffer.from(await res.arrayBuffer()));
  console.log(`[dispatch] restored snapshot from gs://${config.bucket}/${config.object}`);
}

/**
 * Upload a snapshot if anything irreplaceable changed. Stays dirty on failure so
 * the next mutating request retries rather than declaring victory.
 */
export async function flush(deps: FlushDeps = defaultFlushDeps()): Promise<void> {
  const { config, fetchImpl, getToken, snapshotBytes } = deps;
  if (!config || !dirty) return;

  const body = snapshotBytes();
  const res = await fetchImpl(uploadUrl(config.bucket, config.object), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  if (!res.ok) throw new Error(`snapshot upload failed: ${res.status}`);
  dirty = false;
}

function defaultDeps(): SnapshotDeps {
  return { config: snapshotConfig(), fetchImpl: fetch, getToken: () => metadataToken() };
}

function defaultFlushDeps(): FlushDeps {
  return { ...defaultDeps(), snapshotBytes: vacuumInto };
}

/** True when a GCS snapshot is configured — the DB survives a redeploy. */
export function snapshotEnabled(): boolean {
  return snapshotConfig() !== null;
}

/**
 * Upload the snapshot before the response is sent, on any request that dirtied
 * an irreplaceable table.
 *
 * Deliberately *before* the ack rather than in `res.on("finish")`: this service
 * runs request-based billing, so CPU is throttled the moment the response is
 * returned. A fire-and-forget upload could be frozen mid-flight and the instance
 * shut down ("idle instances, including those kept warm using minimum instances,
 * can be shut down at any time"). The cost is ~50ms on writes, which are rare.
 *
 * An upload failure does not fail the user's write — the row is committed
 * locally either way. It stays dirty, so the next mutating request retries.
 */
export function snapshotMiddleware(flushFn: () => Promise<void> = () => flush()): RequestHandler {
  return (req, res, next) => {
    if (!snapshotEnabled() || req.method === "GET" || req.method === "HEAD") return next();

    const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
    let flushing = false;
    res.end = ((...args: unknown[]) => {
      if (flushing || !isDirty()) return originalEnd(...args);
      flushing = true;
      void flushFn()
        .catch((err) => console.warn(`[dispatch] snapshot upload failed: ${safeMessage(err)}`))
        .finally(() => originalEnd(...args));
      return res;
    }) as typeof res.end;

    next();
  };
}
