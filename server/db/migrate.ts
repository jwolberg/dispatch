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

  db = conn;
  return db;
}

/** For tests/teardown. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
