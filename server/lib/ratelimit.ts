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

/** Pull Retry-After (seconds) from a provider error, if present. */
export function retryAfter(err: unknown): number | null {
  if (httpStatus(err) === 429 || httpStatus(err) === 403) {
    const headers = (err as { response?: { headers?: Record<string, string> } })?.response?.headers;
    const ra = headers?.["retry-after"];
    if (ra) {
      const n = Number(ra);
      if (Number.isFinite(n)) return n;
    }
    return 60; // default backoff for secondary limits without a header
  }
  return null;
}
