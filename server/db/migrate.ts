import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.DISPATCH_DB_PATH
  ? resolve(process.env.DISPATCH_DB_PATH)
  : resolve(process.cwd(), "data", "dispatch.db");

let db: Database.Database | null = null;

/**
 * Open (creating if needed) the SQLite database and apply the schema.
 * Idempotent — schema.sql uses CREATE TABLE IF NOT EXISTS, so calling this on
 * every boot is safe and rebuilds the file if it was deleted (ARCH §6).
 */
export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });

  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");

  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  conn.exec(schema);
  dropLegacyEtagColumn(conn);
  migrateRepoIdentity(conn);

  db = conn;
  return db;
}

/**
 * #23: `repos` declares `UNIQUE (provider, host, path)`, but SQLite treats every
 * NULL as distinct inside a UNIQUE index — and GitHub repos always carry
 * `host = NULL`. The constraint therefore never fired for them, and each click of
 * Track appended another row. GitLab repos (non-null host) were always deduped,
 * which is why this hid.
 *
 * `COALESCE(host, '')` folds NULL into a comparable value. The table constraint
 * stays (SQLite has no DROP CONSTRAINT, and it still guards GitLab); this index
 * is what actually enforces identity.
 *
 * Duplicates already on disk must be collapsed before the index can be created,
 * so this runs on every boot and is idempotent. Exported for the test that
 * manufactures a pre-#23 database.
 */
export function migrateRepoIdentity(conn: Database.Database): void {
  conn.transaction(() => {
    const dupes = conn
      .prepare(
        `SELECT provider, COALESCE(host, '') AS host_key, path, MIN(id) AS keep
           FROM repos
          GROUP BY provider, COALESCE(host, ''), path
         HAVING COUNT(*) > 1`
      )
      .all() as { provider: string; host_key: string; path: string; keep: number }[];

    const losers = conn.prepare(
      `SELECT id FROM repos
        WHERE provider = ? AND COALESCE(host, '') = ? AND path = ? AND id <> ?`
    );
    // `tickets` is UNIQUE (repo_id, issue_number): if the survivor already holds
    // that issue, the loser's row cannot move. OR IGNORE leaves it behind, and
    // the cascade below deletes it — the survivor's copy is the one we want.
    const moveTickets = conn.prepare("UPDATE OR IGNORE tickets SET repo_id = ? WHERE repo_id = ?");
    const moveChats = conn.prepare("UPDATE chats SET repo_id = ? WHERE repo_id = ?");
    const dropRepo = conn.prepare("DELETE FROM repos WHERE id = ?");

    for (const d of dupes) {
      for (const { id } of losers.all(d.provider, d.host_key, d.path, d.keep) as { id: number }[]) {
        moveTickets.run(d.keep, id);
        moveChats.run(d.keep, id);
        dropRepo.run(id); // ON DELETE CASCADE sweeps anything that could not move
      }
    }

    conn.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_identity
         ON repos (provider, COALESCE(host, ''), path)`
    );
  })();
}

/**
 * T0-9: status_cache.etag_map_json was always '{}' — ETags are per-repo/resource,
 * not per-ticket, and now live in http_cache. Drop the column from databases
 * created before that. Idempotent; the table is disposable either way.
 */
function dropLegacyEtagColumn(conn: Database.Database): void {
  const columns = conn.pragma("table_info(status_cache)") as { name: string }[];
  if (!columns.some((c) => c.name === "etag_map_json")) return;
  conn.exec("ALTER TABLE status_cache DROP COLUMN etag_map_json");
}

/** For tests/teardown. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
