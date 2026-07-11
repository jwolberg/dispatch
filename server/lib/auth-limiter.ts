// #32 — an in-memory per-IP failed-auth limiter.
//
// The password gate is the ONLY control on the public Cloud Run service, and
// nothing throttled inbound guesses. This bounds them: an IP that fails auth
// `max` times inside `windowMs` is blocked until its failures age out. Kept
// dependency-free and in-memory on purpose — the service runs `--max-instances 1`,
// so a shared store buys nothing, and a small Map is enough.
//
// Caveat (documented, not solved here): behind Cloud Run the client IP comes
// from `X-Forwarded-For`, whose leftmost hop a client can spoof, so a determined
// attacker can rotate the key. This raises the cost of brute force; it is not the
// durable fix — that is OIDC (#16).

export interface FailureLimiter {
  isBlocked(ip: string): boolean;
  recordFailure(ip: string): void;
  reset(ip: string): void;
}

export interface FailureLimiterOptions {
  max: number;
  windowMs: number;
  now: () => number;
}

export function createFailureLimiter({ max, windowMs, now }: FailureLimiterOptions): FailureLimiter {
  // IP → timestamps of recent failures, pruned to the window on every touch.
  const failures = new Map<string, number[]>();

  function recent(ip: string): number[] {
    const cutoff = now() - windowMs;
    const kept = (failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) failures.delete(ip);
    else failures.set(ip, kept);
    return kept;
  }

  return {
    isBlocked(ip) {
      return recent(ip).length >= max;
    },
    recordFailure(ip) {
      const kept = recent(ip);
      kept.push(now());
      failures.set(ip, kept);
    },
    reset(ip) {
      failures.delete(ip);
    },
  };
}
