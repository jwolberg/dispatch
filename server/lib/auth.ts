import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createFailureLimiter, type FailureLimiter } from "./auth-limiter.js";

// Optional shared-password gate (HTTP Basic Auth). Active only when
// DISPATCH_PASSWORD is set — so localhost/dev stays open and the gate is added
// only for an internet-reachable deployment. Any username is accepted.
//
// This is a deliberately simple gate in front of a credential-holding app — pair
// it with a HIGH-ENTROPY password and HTTPS (Cloud Run terminates TLS). It is the
// ONLY control on the public service, so failed guesses are rate-limited (#32)
// and the durable fix is OIDC (#16).

/**
 * Compare in constant time. Both sides are hashed to a fixed 32-byte digest
 * first, so `timingSafeEqual` (which throws on unequal-length buffers) always
 * gets equal lengths — and, critically, the response time does not vary with the
 * supplied value's length. A raw length check would leak the real password's
 * length through timing (#32).
 */
export function safeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a, "utf8").digest();
  const bh = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ah, bh);
}

// After this many failed guesses from one IP within the window, the IP is locked
// out for the remainder of the window. Generous enough for a fat-fingered human;
// tight enough to make online brute force impractical against a strong password.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;

export function makeBasicAuthGate(limiter: FailureLimiter) {
  return function basicAuthGate(req: Request, res: Response, next: NextFunction): void {
    const password = process.env.DISPATCH_PASSWORD;
    if (!password) {
      next();
      return;
    }

    const ip = req.ip ?? "unknown";

    // Block first: once an IP is over the cap, stop even checking its guesses.
    if (limiter.isBlocked(ip)) {
      tooMany(res);
      return;
    }

    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");

    // A credential-less request (a browser's first hit, before it prompts) is not
    // a failed guess — counting it would lock out ordinary page loads. Only an
    // actually-supplied, wrong Basic credential counts against the limit.
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      const supplied = sep >= 0 ? decoded.slice(sep + 1) : "";
      if (safeEqual(supplied, password)) {
        limiter.reset(ip);
        next();
        return;
      }
      // A real wrong guess — count it, and lock out if this tips over the cap.
      limiter.recordFailure(ip);
      if (limiter.isBlocked(ip)) {
        tooMany(res);
        return;
      }
    }

    // Generic 401 for both a missing header and a wrong password — no oracle.
    res.set("WWW-Authenticate", 'Basic realm="Dispatch", charset="UTF-8"');
    res.status(401).json({ error: "Authentication required" });
  };
}

function tooMany(res: Response): void {
  res.status(429).json({ error: "Too many failed attempts. Try again later." });
}

/** The process-wide gate: a real clock, mounted first in server/index.ts. */
export const basicAuthGate = makeBasicAuthGate(
  createFailureLimiter({ max: MAX_FAILURES, windowMs: WINDOW_MS, now: () => Date.now() })
);
