import { httpStatus } from "./errors.js";

// Shared rate-limit gauge (S3). The poller updates it each cycle; the health
// route exposes it; polling pauses when the remaining budget is low.
export const LOW_WATERMARK = 100;

interface Gauge {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
  paused: boolean;
  reason: string | null;
}

const gauge: Gauge = { limit: null, remaining: null, reset: null, paused: false, reason: null };

interface RateLimitLike {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
}

/**
 * The binding constraint across several credentials (#21).
 *
 * Two GitHub App installations have two independent rate-limit budgets, and the
 * banner shows one number. The honest reduction is the smallest *remaining* — the
 * budget that will run out first, and therefore the one that will pause polling.
 * Its `limit` and `reset` travel with it; mixing one account's remaining with
 * another's reset would describe a budget that does not exist.
 *
 * Entries whose `remaining` is unknown are skipped rather than treated as zero,
 * which would pause the poller over a credential that never reported.
 */
export function leastRemaining(entries: RateLimitLike[]): RateLimitLike | null {
  let lowest: RateLimitLike | null = null;
  for (const entry of entries) {
    if (entry.remaining == null) continue;
    if (lowest == null || entry.remaining < lowest.remaining!) lowest = entry;
  }
  return lowest;
}

export function updateRateLimit(rl: { limit: number | null; remaining: number | null; reset: string | null }): void {
  gauge.limit = rl.limit;
  gauge.remaining = rl.remaining;
  gauge.reset = rl.reset;
  if (rl.remaining != null && rl.remaining < LOW_WATERMARK) {
    gauge.paused = true;
    gauge.reason = `Rate limit low (${rl.remaining} remaining) — polling paused`;
  } else {
    gauge.paused = false;
    gauge.reason = null;
  }
}

/** Mark paused due to a 429/secondary-limit response, honoring Retry-After. */
export function markRateLimited(retryAfterSeconds: number | null): void {
  gauge.paused = true;
  gauge.reason = retryAfterSeconds
    ? `Rate limited — backing off ${retryAfterSeconds}s`
    : "Rate limited — backing off";
}

export function isPaused(): boolean {
  return gauge.paused;
}

export function getGauge(): Gauge {
  return { ...gauge };
}

/**
 * If `err` is a genuine rate-limit response, return the backoff (seconds);
 * otherwise null. A 429 is always a throttle. A 403 is only a throttle when it
 * carries rate-limit signals (a `retry-after` header, exhausted
 * `x-ratelimit-remaining`, or a "rate limit" message) — GitHub also returns 403
 * for *permission* errors ("Resource not accessible by personal access token"),
 * which must NOT pause polling (otherwise a missing PAT scope masquerades as
 * rate limiting and stalls the poller).
 */
export function retryAfter(err: unknown): number | null {
  const status = httpStatus(err);
  if (status !== 429 && status !== 403) return null;

  const headers = (err as { response?: { headers?: Record<string, string> } })?.response?.headers ?? {};
  const retryAfterHeader = headers["retry-after"];
  const remaining = headers["x-ratelimit-remaining"];
  const message = (err as { message?: string })?.message ?? "";

  const isRateLimited =
    status === 429 ||
    retryAfterHeader != null ||
    remaining === "0" ||
    /rate limit/i.test(message);
  if (!isRateLimited) return null; // e.g. a permission 403 — a normal failure, not a throttle

  if (retryAfterHeader) {
    const n = Number(retryAfterHeader);
    if (Number.isFinite(n)) return n;
  }
  return 60; // throttled but no explicit Retry-After (secondary limit)
}
