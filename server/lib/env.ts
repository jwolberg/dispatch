import dotenv from "dotenv";
import { statSync } from "node:fs";
import { dirname } from "node:path";

dotenv.config();

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface AppConfig {
  port: number;
  host: string;
}

/**
 * Resolve runtime configuration and enforce the localhost bind guard (S1).
 *
 * The backend binds to 127.0.0.1 by default. Binding to any non-local
 * interface requires ALLOW_NONLOCAL=1; otherwise startup is refused.
 */
export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const host = process.env.HOST?.trim() || "127.0.0.1";
  const allowNonLocal = process.env.ALLOW_NONLOCAL === "1";

  if (!LOCAL_HOSTS.has(host) && !allowNonLocal) {
    throw new Error(
      `Refusing to bind to non-local host "${host}". ` +
        `Dispatch is local-first and binds to 127.0.0.1 by default. ` +
        `Set ALLOW_NONLOCAL=1 to override.`
    );
  }

  return { port, host };
}

/**
 * True when `dir` is a filesystem mount point — its device id differs from its
 * parent's. This is how we tell a mounted volume (durable) from a path on the
 * container's own writable layer (wiped on redeploy).
 */
export function isMountPoint(dir: string): boolean {
  const parent = dirname(dir);
  if (parent === dir) return true; // "/" is a mount point
  try {
    return statSync(dir).dev !== statSync(parent).dev;
  } catch {
    return false; // can't stat → assume not mounted, and warn
  }
}

export interface EphemeralDbProbe {
  allowNonLocal: boolean;
  isMountPoint: (dir: string) => boolean;
  /** A GCS snapshot makes the DB durable without a mounted volume (#20). */
  snapshotEnabled?: boolean;
}

/**
 * Warn when the SQLite file lives on storage that will not survive a redeploy
 * (T0-10, DEPLOY.md §4).
 *
 * Only fires in container mode (ALLOW_NONLOCAL=1). Locally, `data/` on the
 * developer's disk is exactly right and needs no warning. In a container, the
 * DB directory must be a mounted volume or the repo registry and filed tickets
 * are lost on the next revision — a failure mode worth announcing at boot
 * rather than discovering afterwards.
 *
 * Returns the warning text, or null when the path is durable.
 */
export function ephemeralDbWarning(dbPath: string, probe: EphemeralDbProbe): string | null {
  if (!probe.allowNonLocal) return null;
  if (probe.snapshotEnabled) return null; // durable via GCS snapshot, no volume needed
  const dir = dirname(dbPath);
  if (probe.isMountPoint(dir)) return null;
  return (
    `[dispatch] WARNING: ${dbPath} is not on a mounted volume and no GCS snapshot ` +
    `is configured. In a container this file is lost on redeploy or instance ` +
    `recycle, taking the repo registry and filed tickets with it. Derived state ` +
    `rebuilds from the provider, but tracked repos do not. Set DISPATCH_GCS_BUCKET, ` +
    `or mount a volume at ${dir} — see DEPLOY.md §4.`
  );
}

/** Emit the ephemeral-DB warning to stderr, if applicable. */
export function warnIfEphemeralDb(dbPath: string, snapshotOn = false): void {
  const warning = ephemeralDbWarning(dbPath, {
    allowNonLocal: process.env.ALLOW_NONLOCAL === "1",
    isMountPoint,
    snapshotEnabled: snapshotOn,
  });
  if (warning) console.warn(warning);
}
