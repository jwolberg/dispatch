import type { Express } from "express";
import type { AddressInfo } from "node:net";
import { getDb } from "../db/migrate.js";

// Shared test scaffolding (T0-4 / T0-5).
//
// DISPATCH_DB_PATH is set in vitest.config.ts and read at module load by
// db/migrate.ts, so every suite shares one on-disk database under the gitignored
// data/ directory. vitest runs with fileParallelism:false, so resetDb() between
// tests is sufficient isolation.

/** Truncate every table, child-first (foreign keys are ON). */
export function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM activity;
    DELETE FROM status_cache;
    DELETE FROM tickets;
    DELETE FROM chats;
    DELETE FROM repos;
  `);
}

/**
 * Bind an Express app to an ephemeral port, run `fn` against its base URL, then
 * close it. Uses Node's global fetch — no supertest dependency needed.
 */
export async function withServer<T>(app: Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
