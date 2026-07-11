import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { withServer } from "../test/helpers.js";
import { healthRouter } from "./health.js";
import { basicAuthGate } from "../lib/auth.js";

// #32 AC4 — GET /api/health must be reachable without the password (so external
// uptime checks can watch the public service), while every other /api/* route
// stays behind the gate. This mirrors the mount order in server/index.ts.

function app() {
  const a = express();
  a.set("trust proxy", true);
  a.use("/api/health", healthRouter); // ungated, ahead of the gate
  a.use(basicAuthGate);
  const api = express.Router();
  api.get("/secret", (_req, res) => res.json({ ok: true }));
  a.use("/api", api);
  return a;
}

describe("health is ungated; everything else is gated (#32)", () => {
  beforeEach(() => (process.env.DISPATCH_PASSWORD = "s3cret-password-value"));
  afterEach(() => delete process.env.DISPATCH_PASSWORD);

  it("serves GET /api/health with no credentials", async () => {
    await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(200);
    });
  });

  it("still gates other /api routes with no credentials", async () => {
    await withServer(app(), async (base) => {
      const res = await fetch(`${base}/api/secret`);
      expect(res.status).toBe(401);
    });
  });

  it("lets a correct password through to a gated route", async () => {
    await withServer(app(), async (base) => {
      const auth = "Basic " + Buffer.from("x:s3cret-password-value", "utf8").toString("base64");
      const res = await fetch(`${base}/api/secret`, { headers: { authorization: auth } });
      expect(res.status).toBe(200);
    });
  });
});
