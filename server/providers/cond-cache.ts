import { httpStatus } from "../lib/errors.js";

// Conditional-request cache (PRD F4.2 / S3, T0-9).
//
// Sends If-None-Match from a cached ETag; on a 304 replays the cached body.
// GitHub does not charge a 304 against the rate-limit budget, so an unchanged
// resource costs nothing.
//
// THE INVARIANT: a 304 response carries NO BODY. An entry is therefore only
// usable when it holds BOTH the etag and the body it came with. Never insert an
// entry with a missing/undefined body — cond() would return undefined on the
// next 304, and the caller (reconcile) would throw a TypeError that
// safeReconcile silently swallows, freezing the ticket forever.

export interface CondEntry {
  etag: string;
  data: unknown;
}

/**
 * Durable backing for the cache. `load()` must only yield entries whose body was
 * successfully recovered; anything unparseable must be dropped, not surfaced
 * with an undefined body (see the invariant above).
 */
export interface CondCacheStore {
  load(): Iterable<[string, CondEntry]>;
  save(key: string, entry: CondEntry): void;
}

export interface ConditionalResponse<T> {
  status: number;
  headers: { etag?: string };
  data: T;
}

export class CondCache {
  private readonly mem = new Map<string, CondEntry>();

  /** Hydrates from `store` (a cold start otherwise re-fetches everything). */
  constructor(private readonly store?: CondCacheStore) {
    if (!store) return;
    for (const [key, entry] of store.load()) {
      if (entry && typeof entry.etag === "string" && entry.data !== undefined) {
        this.mem.set(key, entry);
      }
    }
  }

  size(): number {
    return this.mem.size;
  }

  /**
   * Run one conditional GET. On 304 returns the cached body; on 200 with an
   * ETag, records body+etag (in memory and, if present, in the store).
   * Non-304 errors propagate so existing handlers behave unchanged.
   */
  async run<T>(
    key: string,
    call: (headers: Record<string, string>) => Promise<ConditionalResponse<T>>
  ): Promise<T> {
    const cached = this.mem.get(key);
    const headers: Record<string, string> = cached ? { "if-none-match": cached.etag } : {};
    try {
      const res = await call(headers);
      if (res.status === 304 && cached) return cached.data as T;
      if (res.headers.etag && res.data !== undefined) {
        const entry: CondEntry = { etag: res.headers.etag, data: res.data };
        this.mem.set(key, entry);
        this.store?.save(key, entry);
      }
      return res.data;
    } catch (err) {
      // Octokit surfaces 304 as a thrown error on some paths.
      if (httpStatus(err) === 304 && cached) return cached.data as T;
      throw err;
    }
  }
}
