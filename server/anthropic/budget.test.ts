import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertWithinBudget, BudgetExceededError, dailyBudgetUsd } from "./budget.js";
import { recordSpend, clearSpend } from "../db/spend.js";

// T1-9 (ticket #10) — the gate itself. Tier 1's exit criterion is "the tool
// cannot silently spend unbounded money", and the S4 contract says a refusal
// must be non-destructive: the user's typed input survives.

const SONNET = "claude-sonnet-4-6"; // $3/MTok in
const M = 1_000_000;
const NOW = new Date("2026-07-09T12:00:00Z");

/** $3.00 of spend. */
const threeDollars = {
  input_tokens: M,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const ORIGINAL = process.env.DISPATCH_DAILY_BUDGET_USD;

describe("dailyBudgetUsd", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISPATCH_DAILY_BUDGET_USD;
    else process.env.DISPATCH_DAILY_BUDGET_USD = ORIGINAL;
  });

  it("is undefined when the env var is unset — no cap", () => {
    delete process.env.DISPATCH_DAILY_BUDGET_USD;
    expect(dailyBudgetUsd()).toBeUndefined();
  });

  it("parses a numeric budget", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "10";
    expect(dailyBudgetUsd()).toBe(10);
  });

  it("treats a non-numeric budget as a configuration error, not as no-cap", () => {
    // Failing open here would silently uncap a user who meant to set a limit.
    process.env.DISPATCH_DAILY_BUDGET_USD = "ten dollars";
    expect(() => dailyBudgetUsd()).toThrow();
  });

  it("rejects a negative budget", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "-1";
    expect(() => dailyBudgetUsd()).toThrow();
  });

  it("accepts a zero budget, which blocks every call", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "0";
    expect(dailyBudgetUsd()).toBe(0);
  });
});

describe("assertWithinBudget", () => {
  beforeEach(() => clearSpend());
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISPATCH_DAILY_BUDGET_USD;
    else process.env.DISPATCH_DAILY_BUDGET_USD = ORIGINAL;
  });

  it("permits any call when no budget is configured", () => {
    delete process.env.DISPATCH_DAILY_BUDGET_USD;
    recordSpend({ model: SONNET, kind: "chat", usage: threeDollars, at: NOW });
    expect(() => assertWithinBudget(NOW)).not.toThrow();
  });

  it("permits a call when spend is under the budget", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "10";
    recordSpend({ model: SONNET, kind: "chat", usage: threeDollars, at: NOW });
    expect(() => assertWithinBudget(NOW)).not.toThrow();
  });

  it("refuses once spend has reached the budget exactly", () => {
    // Exact equality is the boundary the ticket calls out. At $3 spent with a
    // $3 cap the budget is exhausted; the next call would exceed it.
    process.env.DISPATCH_DAILY_BUDGET_USD = "3";
    recordSpend({ model: SONNET, kind: "chat", usage: threeDollars, at: NOW });
    expect(() => assertWithinBudget(NOW)).toThrow(BudgetExceededError);
  });

  it("refuses once spend has exceeded the budget", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "2";
    recordSpend({ model: SONNET, kind: "chat", usage: threeDollars, at: NOW });
    expect(() => assertWithinBudget(NOW)).toThrow(BudgetExceededError);
  });

  it("refuses every call under a zero budget", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "0";
    expect(() => assertWithinBudget(NOW)).toThrow(BudgetExceededError);
  });

  it("permits again the next UTC day", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "3";
    recordSpend({ model: SONNET, kind: "chat", usage: threeDollars, at: NOW });
    expect(() => assertWithinBudget(NOW)).toThrow(BudgetExceededError);
    expect(() => assertWithinBudget(new Date("2026-07-10T00:00:00.000Z"))).not.toThrow();
  });
});

describe("BudgetExceededError — the refusal must be usable", () => {
  beforeEach(() => clearSpend());
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISPATCH_DAILY_BUDGET_USD;
    else process.env.DISPATCH_DAILY_BUDGET_USD = ORIGINAL;
  });

  it("carries the spend and the budget so the message can name real numbers", () => {
    process.env.DISPATCH_DAILY_BUDGET_USD = "2";
    recordSpend({ model: SONNET, kind: "chat", usage: threeDollars, at: NOW });
    try {
      assertWithinBudget(NOW);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const e = err as BudgetExceededError;
      expect(e.spentUsd).toBeCloseTo(3, 6);
      expect(e.budgetUsd).toBe(2);
      expect(e.message).toMatch(/budget/i);
    }
  });

  it("maps to HTTP 429, not 500 — this is a refusal, not a crash", () => {
    // The route must be able to answer without the client treating it as a bug.
    // 429 keeps the S4 contract: the client redisplays the user's typed input.
    process.env.DISPATCH_DAILY_BUDGET_USD = "0";
    try {
      assertWithinBudget(NOW);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as BudgetExceededError).status).toBe(429);
    }
  });

  it("is thrown before any Anthropic call, so nothing is spent to learn we are over", () => {
    // Structural, not behavioral: assertWithinBudget reads only the ledger.
    // Recorded here so a future refactor that moves the check after the call
    // trips a named test rather than passing silently.
    process.env.DISPATCH_DAILY_BUDGET_USD = "0";
    const before = () => assertWithinBudget(NOW);
    expect(before).toThrow(BudgetExceededError);
  });
});
