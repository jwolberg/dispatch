import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { safeEqual, makeBasicAuthGate } from "./auth.js";
import { createFailureLimiter } from "./auth-limiter.js";

// #32 — the shared-password gate. Two defects: no throttling of failed guesses,
// and safeEqual leaks the password's length by returning before the constant-time
// compare. These pin the fixes.

const PW = "correct horse battery staple";
const basic = (pass: string, user = "x") =>
  "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");

function mockRes() {
  const res = {
    set: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { set: any; status: any; json: any };
}

function call(gate: (r: Request, s: Response, n: NextFunction) => void, req: Partial<Request>) {
  const res = mockRes();
  const next = vi.fn();
  gate({ headers: {}, ip: "9.9.9.9", ...req } as Request, res, next);
  return { res, next };
}

describe("safeEqual", () => {
  it("accepts the exact value and rejects wrong values of equal and unequal length", () => {
    expect(safeEqual(PW, PW)).toBe(true);
    expect(safeEqual("correct horse battery staplX", PW)).toBe(false); // same length, wrong
    expect(safeEqual("short", PW)).toBe(false); // shorter — must not throw
    expect(safeEqual(PW + " extra", PW)).toBe(false); // longer — must not throw
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("basicAuthGate", () => {
  beforeEach(() => (process.env.DISPATCH_PASSWORD = PW));
  afterEach(() => delete process.env.DISPATCH_PASSWORD);

  function gate(max = 3) {
    return makeBasicAuthGate(createFailureLimiter({ max, windowMs: 60_000, now: () => 1000 }));
  }

  it("passes a correct password through", () => {
    const { next, res } = call(gate(), { headers: { authorization: basic(PW) } });
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("401s a wrong password", () => {
    const { next, res } = call(gate(), { headers: { authorization: basic("nope") } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 429 on the Nth consecutive failed attempt from one IP", () => {
    const g = gate(3);
    const wrong = { headers: { authorization: basic("nope") }, ip: "5.5.5.5" };
    expect(call(g, wrong).res.status).toHaveBeenCalledWith(401); // 1
    expect(call(g, wrong).res.status).toHaveBeenCalledWith(401); // 2
    expect(call(g, wrong).res.status).toHaveBeenCalledWith(429); // 3rd → blocked
    // Still blocked afterwards, even before the window passes.
    expect(call(g, wrong).res.status).toHaveBeenCalledWith(429);
  });

  it("does not count a credential-less request as a failed guess", () => {
    const g = gate(2);
    // Two bare requests (browser's first hit, no header) must not trip the lockout.
    call(g, { headers: {}, ip: "7.7.7.7" });
    call(g, { headers: {}, ip: "7.7.7.7" });
    const { res } = call(g, { headers: { authorization: basic(PW) }, ip: "7.7.7.7" });
    expect(res.status).not.toHaveBeenCalledWith(429); // correct creds still get in
  });

  it("a correct password resets the IP's failure count", () => {
    const g = gate(3);
    const ip = "8.8.8.8";
    call(g, { headers: { authorization: basic("nope") }, ip }); // 1 fail
    call(g, { headers: { authorization: basic("nope") }, ip }); // 2 fail
    call(g, { headers: { authorization: basic(PW) }, ip }); // success → reset
    // Two more fails should not reach the cap of 3.
    call(g, { headers: { authorization: basic("nope") }, ip });
    const { res } = call(g, { headers: { authorization: basic("nope") }, ip });
    expect(res.status).toHaveBeenLastCalledWith(401);
  });

  it("is disabled entirely when DISPATCH_PASSWORD is unset", () => {
    delete process.env.DISPATCH_PASSWORD;
    const { next } = call(gate(), { headers: {} });
    expect(next).toHaveBeenCalledOnce();
  });
});
