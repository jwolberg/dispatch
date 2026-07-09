import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { withServer } from "../test/helpers.js";
import {
  snapshotConfig,
  downloadUrl,
  uploadUrl,
  markDirty,
  isDirty,
  clearDirty,
  restoreIfMissing,
  flush,
  snapshotMiddleware,
} from "./snapshot.js";

// T1-8 follow-up (#20) — durable state without Filestore.
//
// Production runs SQLite on Cloud Run's ephemeral disk, so every redeploy wipes
// the repo registry, chats and the spend ledger. Filestore's floor is 1 TiB
// (~$164/mo) to protect ~4 KB; GCS FUSE is disqualified by Google's own docs
// ("does not support file locking", "shouldn't be used as the backend for
// storing a database"); Litestream needs CPU outside requests, which this
// service does not have (request-based billing).
//
// So: snapshot the DB to a GCS object during a request, restore it on boot.

const BUCKET = "dispatch-state";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("snapshotConfig", () => {
  it("is null when no bucket is configured — local dev stays untouched", () => {
    withEnv({ DISPATCH_GCS_BUCKET: undefined }, () => {
      expect(snapshotConfig()).toBeNull();
    });
  });

  it("defaults the object name when only a bucket is given", () => {
    withEnv({ DISPATCH_GCS_BUCKET: BUCKET, DISPATCH_GCS_OBJECT: undefined }, () => {
      expect(snapshotConfig()).toEqual({ bucket: BUCKET, object: "dispatch.db" });
    });
  });

  it("honors an explicit object name", () => {
    withEnv({ DISPATCH_GCS_BUCKET: BUCKET, DISPATCH_GCS_OBJECT: "prod/dispatch.db" }, () => {
      expect(snapshotConfig()).toEqual({ bucket: BUCKET, object: "prod/dispatch.db" });
    });
  });
});

// GCS's JSON API takes the object name as a single path segment on download and
// as a query param on upload. A `/` in the name must be percent-encoded in the
// download path or the request 404s against a bucket that plainly has the object.
describe("url building", () => {
  it("percent-encodes slashes in the object name on download", () => {
    expect(downloadUrl(BUCKET, "prod/dispatch.db")).toBe(
      "https://storage.googleapis.com/storage/v1/b/dispatch-state/o/prod%2Fdispatch.db?alt=media"
    );
  });

  it("encodes the object name on upload", () => {
    expect(uploadUrl(BUCKET, "prod/dispatch.db")).toBe(
      "https://storage.googleapis.com/upload/storage/v1/b/dispatch-state/o?uploadType=media&name=prod%2Fdispatch.db"
    );
  });
});

describe("restoreIfMissing", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snap-"));
    dbPath = join(dir, "dispatch.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does nothing when the db file already exists — never clobbers live data", async () => {
    writeFileSync(dbPath, "local");
    const fetchImpl = vi.fn();
    await restoreIfMissing(dbPath, {
      config: { bucket: BUCKET, object: "dispatch.db" },
      fetchImpl,
      getToken: async () => "t",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(dbPath, "utf8")).toBe("local");
  });

  it("does nothing when snapshots are not configured", async () => {
    const fetchImpl = vi.fn();
    await restoreIfMissing(dbPath, { config: null, fetchImpl, getToken: async () => "t" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(dbPath)).toBe(false);
  });

  it("writes the object to disk when it exists", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("sqlite-bytes").buffer,
    });
    await restoreIfMissing(dbPath, {
      config: { bucket: BUCKET, object: "dispatch.db" },
      fetchImpl,
      getToken: async () => "tok",
    });
    expect(readFileSync(dbPath, "utf8")).toBe("sqlite-bytes");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(downloadUrl(BUCKET, "dispatch.db"));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  // First boot against a fresh bucket. Not an error — there is simply nothing
  // to restore yet, and the schema will create an empty DB.
  it("treats 404 as an empty first boot, not a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(
      restoreIfMissing(dbPath, {
        config: { bucket: BUCKET, object: "dispatch.db" },
        fetchImpl,
        getToken: async () => "t",
      })
    ).resolves.toBeUndefined();
    expect(existsSync(dbPath)).toBe(false);
  });

  // The dangerous case: a transient 500 must NOT be mistaken for "no snapshot",
  // because booting with an empty DB would then overwrite the good snapshot on
  // the next write. Fail loudly instead.
  it("throws on a non-404 error rather than silently starting empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(
      restoreIfMissing(dbPath, {
        config: { bucket: BUCKET, object: "dispatch.db" },
        fetchImpl,
        getToken: async () => "t",
      })
    ).rejects.toThrow(/503/);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("flush", () => {
  beforeEach(() => clearDirty());

  it("uploads the snapshot bytes and clears the dirty flag", async () => {
    markDirty();
    expect(isDirty()).toBe(true);

    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await flush({
      config: { bucket: BUCKET, object: "dispatch.db" },
      fetchImpl,
      getToken: async () => "tok",
      snapshotBytes: () => Buffer.from("db-bytes"),
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(uploadUrl(BUCKET, "dispatch.db"));
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe("db-bytes");
    expect(isDirty()).toBe(false);
  });

  it("does nothing when not dirty — a poll cycle must not cost an upload", async () => {
    const fetchImpl = vi.fn();
    await flush({
      config: { bucket: BUCKET, object: "dispatch.db" },
      fetchImpl,
      getToken: async () => "t",
      snapshotBytes: () => Buffer.from("x"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing when snapshots are not configured", async () => {
    markDirty();
    const fetchImpl = vi.fn();
    await flush({
      config: null,
      fetchImpl,
      getToken: async () => "t",
      snapshotBytes: () => Buffer.from("x"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // If the upload fails the data is still only on ephemeral disk. Staying dirty
  // means the next mutating request retries rather than declaring victory.
  it("stays dirty when the upload fails, so the next write retries", async () => {
    markDirty();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(
      flush({
        config: { bucket: BUCKET, object: "dispatch.db" },
        fetchImpl,
        getToken: async () => "t",
        snapshotBytes: () => Buffer.from("x"),
      })
    ).rejects.toThrow(/500/);
    expect(isDirty()).toBe(true);
  });
});

// The ordering guarantee is the point of the middleware: under request-based
// billing, CPU stops when the response is returned, so the upload must complete
// BEFORE the ack. A fire-and-forget upload can be frozen and the instance killed.
describe("snapshotMiddleware", () => {
  let prevBucket: string | undefined;

  beforeEach(() => {
    prevBucket = process.env.DISPATCH_GCS_BUCKET;
    process.env.DISPATCH_GCS_BUCKET = BUCKET;
    clearDirty();
  });
  afterEach(() => {
    if (prevBucket === undefined) delete process.env.DISPATCH_GCS_BUCKET;
    else process.env.DISPATCH_GCS_BUCKET = prevBucket;
  });

  /** Drive one request through the middleware, recording flush/ack ordering. */
  async function run(method: "GET" | "POST", dirtyIt: boolean, flushFn: () => Promise<void>) {
    const order: string[] = [];
    const app = express();
    app.use(
      snapshotMiddleware(async () => {
        await flushFn();
        order.push("flush");
      })
    );
    app.all("/x", (_req, res) => {
      if (dirtyIt) markDirty();
      res.json({ ok: true });
    });
    const status = await withServer(app, async (base) => {
      const res = await fetch(`${base}/x`, { method });
      order.push("ack");
      return res.status;
    });
    return { order, status };
  }

  it("flushes before acking a write", async () => {
    let uploaded = false;
    const { order, status } = await run("POST", true, async () => {
      uploaded = true;
    });
    expect(status).toBe(200);
    expect(uploaded).toBe(true);
    expect(order).toEqual(["flush", "ack"]);
  });

  it("does not flush on a GET", async () => {
    const { order } = await run("GET", true, async () => undefined);
    expect(order).toEqual(["ack"]);
  });

  it("does not flush a write that changed nothing irreplaceable", async () => {
    const { order } = await run("POST", false, async () => undefined);
    expect(order).toEqual(["ack"]);
  });

  // A failed upload must not fail the user's write: the row is committed locally
  // either way, and staying dirty means the next write retries.
  it("still responds when the upload fails, and stays dirty", async () => {
    const { status } = await run("POST", true, async () => {
      throw new Error("boom");
    });
    expect(status).toBe(200);
    expect(isDirty()).toBe(true);
  });
});
