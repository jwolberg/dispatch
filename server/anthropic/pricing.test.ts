import { describe, it, expect } from "vitest";
import { priceUsd, UnknownModelError } from "./pricing.js";

// T1-9 (ticket #10) — the spend cap is only as honest as its price table.
//
// Two things the ticket did not anticipate, both load-bearing:
//
// 1. `usage.input_tokens` is the UNCACHED REMAINDER, not the prompt size.
//    Total prompt = input_tokens + cache_creation_input_tokens +
//    cache_read_input_tokens. Pricing only `input_tokens` under-reports every
//    cached request — and this repo caches aggressively, so that is the normal
//    case, not the edge case. Cache reads bill at ~0.10x base input; 5-minute
//    cache writes bill at 1.25x.
//
// 2. An unpriceable model must THROW, not cost $0. A silent zero turns the cap
//    into a no-op at exactly the moment someone points ANTHROPIC_MODEL at a
//    model we have never priced — i.e. the next model launch.

/** Per-MTok rates, from the Anthropic pricing table (verified 2026-07-09). */
const OPUS_48 = "claude-opus-4-8"; // $5 in / $25 out
const SONNET_46 = "claude-sonnet-4-6"; // $3 in / $15 out — this repo's default
const HAIKU_45 = "claude-haiku-4-5"; // $1 in / $5 out

const M = 1_000_000;

/** A usage object with every field zero unless overridden. */
function usage(over: Partial<Parameters<typeof priceUsd>[1]> = {}) {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  };
}

describe("priceUsd — base input and output rates", () => {
  it.each([
    [OPUS_48, 5, 25],
    [SONNET_46, 3, 15],
    [HAIKU_45, 1, 5],
  ])("%s bills $%d/MTok in and $%d/MTok out", (model, inRate, outRate) => {
    expect(priceUsd(model, usage({ input_tokens: M }))).toBeCloseTo(inRate, 6);
    expect(priceUsd(model, usage({ output_tokens: M }))).toBeCloseTo(outRate, 6);
  });

  it("sums input and output", () => {
    // 1M in + 1M out on Sonnet 4.6 = $3 + $15
    expect(priceUsd(SONNET_46, usage({ input_tokens: M, output_tokens: M }))).toBeCloseTo(18, 6);
  });

  it("prices zero usage at zero", () => {
    expect(priceUsd(SONNET_46, usage())).toBe(0);
  });
});

describe("priceUsd — cached tokens are not free and are not full price", () => {
  // This block is the reason the ticket's original acceptance criteria were
  // insufficient. A summary call (#6) re-sends a large cached prefix every
  // time; if cache reads price at zero we systematically under-count, and if
  // they price at 1.0x we over-count and refuse work the user can afford.

  it("bills cache reads at 0.10x the base input rate", () => {
    // 1M cache-read tokens on Sonnet 4.6 = $3 * 0.10 = $0.30
    expect(priceUsd(SONNET_46, usage({ cache_read_input_tokens: M }))).toBeCloseTo(0.3, 6);
  });

  it("bills 5-minute cache writes at 1.25x the base input rate", () => {
    // 1M cache-write tokens on Sonnet 4.6 = $3 * 1.25 = $3.75
    expect(priceUsd(SONNET_46, usage({ cache_creation_input_tokens: M }))).toBeCloseTo(3.75, 6);
  });

  it("a fully cache-read request costs a tenth of the uncached one", () => {
    const uncached = priceUsd(SONNET_46, usage({ input_tokens: M }));
    const cached = priceUsd(SONNET_46, usage({ cache_read_input_tokens: M }));
    expect(cached).toBeCloseTo(uncached * 0.1, 6);
  });

  it("does not double-count: input_tokens is the uncached remainder only", () => {
    // A 1M-token prompt served 90% from cache reports input_tokens=100k and
    // cache_read_input_tokens=900k. Total must be 0.1*$3 + 0.9*$3*0.10 = $0.57,
    // NOT $3 (treating input_tokens as the whole prompt) and NOT $3.27
    // (adding cache reads on top of a full-price prompt).
    const cost = priceUsd(
      SONNET_46,
      usage({ input_tokens: 100_000, cache_read_input_tokens: 900_000 }),
    );
    expect(cost).toBeCloseTo(0.3 + 0.27, 6);
  });
});

describe("priceUsd — an unknown model is an error, never $0", () => {
  it("throws UnknownModelError for a model absent from the table", () => {
    expect(() => priceUsd("claude-does-not-exist-9", usage({ output_tokens: M }))).toThrow(
      UnknownModelError,
    );
  });

  it("names the offending model in the error, so the fix is obvious", () => {
    expect(() => priceUsd("claude-does-not-exist-9", usage())).toThrow(/claude-does-not-exist-9/);
  });

  it("throws even when usage is zero — the model id is what is wrong", () => {
    // Guards the tempting shortcut `if (total === 0) return 0` before lookup.
    expect(() => priceUsd("claude-does-not-exist-9", usage())).toThrow(UnknownModelError);
  });

  it("prices the model this repo actually defaults to", () => {
    // server/anthropic/client.ts: MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"
    // If that default ever drifts to an unpriced id, this test fails loudly at
    // build time rather than silently zeroing the budget in production.
    expect(() => priceUsd(SONNET_46, usage({ input_tokens: 1 }))).not.toThrow();
  });
});
