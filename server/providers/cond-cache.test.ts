import { describe, it, expect, vi } from "vitest";
import { CondCache, type CondCacheStore, type CondEntry } from "./cond-cache.js";

// T0-9 — the conditional-request cache. The invariant under test: a 304 carries
// no body, so an entry is only usable when it holds BOTH etag and body. The
// original T0-9 plan (persist etags only) would have made cond() return
// undefined on the first cold-start 304; the last describe block is the
// regression test for exactly that.

function memStore(seed: [string, CondEntry][] = []): CondCacheStore & { saved: Map<string, CondEntry> } {
  const saved = new Map(seed);
  return { saved, load: () => seed, save: (k, e) => void saved.set(k, e) };
}

type Headers = Record<string, string>;

const ok =
  <T>(data: T, etag?: string) =>
  async (_headers: Headers) => ({
    status: 200,
    headers: etag ? { etag } : {},
    data,
  });

const notModified = async (_headers: Headers) => ({
  status: 304,
  headers: {},
  data: undefined as never,
});

describe("CondCache.run", () => {
  it("fetches on a cold miss and sends no If-None-Match", async () => {
    const cache = new CondCache();
    const call = vi.fn(ok([1, 2, 3], 'W/"a"'));
    expect(await cache.run("k", call)).toEqual([1, 2, 3]);
    expect(call.mock.calls[0][0]).toEqual({});
  });

  it("sends If-None-Match once an ETag is known", async () => {
    const cache = new CondCache();
    await cache.run("k", ok("v1", 'W/"a"'));
    const call = vi.fn(ok("v2", 'W/"b"'));
    await cache.run("k", call);
    expect(call.mock.calls[0][0]).toEqual({ "if-none-match": 'W/"a"' });
  });

  it("replays the cached body on a 304", async () => {
    const cache = new CondCache();
    await cache.run("k", ok({ n: 1 }, 'W/"a"'));
    expect(await cache.run("k", notModified)).toEqual({ n: 1 });
  });

  it("replays the cached body when a 304 arrives as a thrown error", async () => {
    const cache = new CondCache();
    await cache.run("k", ok({ n: 1 }, 'W/"a"'));
    const thrown = Object.assign(new Error("Not modified"), { status: 304 });
    expect(
      await cache.run("k", () => {
        throw thrown;
      })
    ).toEqual({ n: 1 });
  });

  it("propagates non-304 errors unchanged", async () => {
    const cache = new CondCache();
    const boom = Object.assign(new Error("not found"), { status: 404 });
    await expect(
      cache.run("k", () => {
        throw boom;
      })
    ).rejects.toThrow("not found");
  });

  it("does not cache a response that carries no ETag", async () => {
    const cache = new CondCache();
    await cache.run("k", ok("v", undefined));
    expect(cache.size()).toBe(0);
  });

  it("keeps entries separate per key", async () => {
    const cache = new CondCache();
    await cache.run("a", ok("A", 'W/"1"'));
    await cache.run("b", ok("B", 'W/"2"'));
    expect(await cache.run("a", notModified)).toBe("A");
    expect(await cache.run("b", notModified)).toBe("B");
  });
});

describe("CondCache with a store", () => {
  it("writes etag AND body through on a 200", async () => {
    const store = memStore();
    await new CondCache(store).run("k", ok({ n: 7 }, 'W/"a"'));
    expect(store.saved.get("k")).toEqual({ etag: 'W/"a"', data: { n: 7 } });
  });

  it("hydrates from the store, so a cold start replays a 304 without re-fetching", async () => {
    const store = memStore([["k", { etag: 'W/"a"', data: { n: 7 } }]]);
    const cache = new CondCache(store);

    const call = vi.fn(notModified);
    expect(await cache.run("k", call)).toEqual({ n: 7 });
    expect(call.mock.calls[0][0]).toEqual({ "if-none-match": 'W/"a"' });
  });

  // The regression this whole ticket was blocked on.
  describe("refuses to hydrate an entry that has no body", () => {
    it("ignores a persisted entry whose data is undefined", async () => {
      const store = memStore([["k", { etag: 'W/"a"', data: undefined }]]);
      const cache = new CondCache(store);

      // The bad entry must not be adopted...
      expect(cache.size()).toBe(0);

      // ...so no If-None-Match is sent, the server returns a real 200 body, and
      // nothing downstream ever sees `undefined`.
      const call = vi.fn(ok(["real", "body"], 'W/"a"'));
      expect(await cache.run("k", call)).toEqual(["real", "body"]);
      expect(call.mock.calls[0][0]).toEqual({});
    });

    it("ignores a persisted entry with a non-string etag", async () => {
      const store = memStore([["k", { etag: undefined as unknown as string, data: { n: 1 } }]]);
      expect(new CondCache(store).size()).toBe(0);
    });
  });

  it("never persists a 200 whose body is undefined", async () => {
    const store = memStore();
    await new CondCache(store).run("k", async () => ({
      status: 200,
      headers: { etag: 'W/"a"' },
      data: undefined as never,
    }));
    expect(store.saved.size).toBe(0);
  });
});
