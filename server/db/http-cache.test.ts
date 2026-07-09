import { describe, it, expect, beforeEach } from "vitest";
import {
  loadHttpCache,
  putHttpCache,
  clearHttpCache,
  sqliteCondCacheStore,
  MAX_PERSISTED_BODY_BYTES,
} from "./http-cache.js";
import { getDb } from "./migrate.js";

// T0-9 — durable backing for the conditional-request cache. The load path must
// never yield an entry without a body (see cond-cache.ts's invariant), so a
// corrupt row is dropped rather than surfaced.

const NOW = "2026-07-09T00:00:00.000Z";

describe("http_cache", () => {
  beforeEach(() => clearHttpCache());

  it("round-trips an entry", () => {
    putHttpCache("pulls.list:a/b", { etag: 'W/"x"', data: [{ number: 7 }] }, NOW);
    expect(loadHttpCache()).toEqual([["pulls.list:a/b", { etag: 'W/"x"', data: [{ number: 7 }] }]]);
  });

  it("upserts on the same key rather than duplicating", () => {
    putHttpCache("k", { etag: 'W/"1"', data: "old" }, NOW);
    putHttpCache("k", { etag: 'W/"2"', data: "new" }, NOW);
    expect(loadHttpCache()).toEqual([["k", { etag: 'W/"2"', data: "new" }]]);
  });

  it("preserves falsy bodies that are still valid JSON", () => {
    putHttpCache("empty-list", { etag: 'W/"e"', data: [] }, NOW);
    putHttpCache("zero", { etag: 'W/"z"', data: 0 }, NOW);
    const loaded = new Map(loadHttpCache());
    expect(loaded.get("empty-list")?.data).toEqual([]);
    expect(loaded.get("zero")?.data).toBe(0);
  });

  it("drops a corrupt row instead of yielding an entry with no body", () => {
    putHttpCache("good", { etag: 'W/"g"', data: { ok: true } }, NOW);
    getDb()
      .prepare("INSERT INTO http_cache (key, etag, body_json, updated_at) VALUES (?,?,?,?)")
      .run("corrupt", 'W/"c"', "{not json", NOW);

    const loaded = loadHttpCache();
    expect(loaded.map(([k]) => k)).toEqual(["good"]);
  });

  it("does not persist an oversized body (in-process cache still holds it)", () => {
    const huge = "x".repeat(MAX_PERSISTED_BODY_BYTES + 1);
    putHttpCache("huge", { etag: 'W/"h"', data: huge }, NOW);
    expect(loadHttpCache()).toEqual([]);
  });

  it("does not persist an unserializable body", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => putHttpCache("circ", { etag: 'W/"c"', data: circular }, NOW)).not.toThrow();
    expect(loadHttpCache()).toEqual([]);
  });

  it("does not persist an undefined body", () => {
    putHttpCache("undef", { etag: 'W/"u"', data: undefined }, NOW);
    expect(loadHttpCache()).toEqual([]);
  });

  it("exposes a CondCacheStore that reads and writes the table", () => {
    sqliteCondCacheStore.save("k", { etag: 'W/"s"', data: { a: 1 } });
    expect([...sqliteCondCacheStore.load()]).toEqual([["k", { etag: 'W/"s"', data: { a: 1 } }]]);
  });

  it("is disposable — clearing costs only a re-fetch", () => {
    putHttpCache("k", { etag: 'W/"x"', data: 1 }, NOW);
    clearHttpCache();
    expect(loadHttpCache()).toEqual([]);
  });
});
