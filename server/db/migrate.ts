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

  db = conn;
  return db;
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
