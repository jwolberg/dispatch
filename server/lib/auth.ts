import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Optional shared-password gate (HTTP Basic Auth). Active only when
// DISPATCH_PASSWORD is set — so localhost/dev stays open and the gate is added
// only for an internet-reachable deployment. Any username is accepted; the
// password is compared in constant time. This is a deliberately simple gate in
// front of a credential-holding app — pair it with a HIGH-ENTROPY password and
// HTTPS (Cloud Run terminates TLS).

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function basicAuthGate(req: Request, res: Response, next: NextFunction): void {
  const password = process.env.DISPATCH_PASSWORD;
  if (!password) {
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const supplied = sep >= 0 ? decoded.slice(sep + 1) : "";
    if (safeEqual(supplied, password)) {
      next();
      return;
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Dispatch", charset="UTF-8"');
  res.status(401).json({ error: "Authentication required" });
}
