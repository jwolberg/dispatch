import { getDb } from "./migrate.js";
import type { CondCacheStore, CondEntry } from "../providers/cond-cache.js";

// Durable backing for the providers' conditional-request cache (T0-9).
// Disposable by contract: wiping http_cache costs exactly one full re-fetch.

/**
 * Bodies above this are not persisted. They still cache in-process for the life
 * of the process; they just don't survive a restart. Keeps the SQLite file from
 * growing without bound on repos with large payloads.
 */
export const MAX_PERSISTED_BODY_BYTES = 512 * 1024;

interface Row {
  key: string;
  etag: string;
  body_json: string;
}

/**
 * Load every usable entry. A row whose body fails to parse is DROPPED, never
 * surfaced with an undefined body — see the invariant in cond-cache.ts.
 */
export function loadHttpCache(): [string, CondEntry][] {
  const rows = getDb().prepare("SELECT key, etag, body_json FROM http_cache").all() as Row[];
  const entries: [string, CondEntry][] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.body_json) as unknown;
      if (data === undefined) continue;
      entries.push([row.key, { etag: row.etag, data }]);
    } catch {
      /* corrupt row → drop it; the next request re-fetches and overwrites */
    }
  }
  return entries;
}

/** Upsert one entry. Silently skips bodies that are oversized or unserializable. */
export function putHttpCache(key: string, entry: CondEntry, nowIso: string): void {
  let bodyJson: string;
  try {
    bodyJson = JSON.stringify(entry.data);
  } catch {
    return; // circular / unserializable → in-process cache only
  }
  if (bodyJson === undefined || bodyJson.length > MAX_PERSISTED_BODY_BYTES) return;

  getDb()
    .prepare(
      `INSERT INTO http_cache (key, etag, body_json, updated_at)
       VALUES (@key, @etag, @body, @updated_at)
       ON CONFLICT(key) DO UPDATE SET
         etag = @etag, body_json = @body, updated_at = @updated_at`
    )
    .run({ key, etag: entry.etag, body: bodyJson, updated_at: nowIso });
}

export function clearHttpCache(): void {
  getDb().exec("DELETE FROM http_cache");
}

/** The store handed to the provider adapters at boot (server/index.ts). */
export const sqliteCondCacheStore: CondCacheStore = {
  load: () => loadHttpCache(),
  save: (key, entry) => putHttpCache(key, entry, new Date().toISOString()),
};
