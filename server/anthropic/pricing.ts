/**
 * T1-9 — token pricing for the daily spend cap.
 *
 * Rates are per million tokens, from Anthropic's published pricing, verified
 * 2026-07-09. They change; when they do, edit the table and the date, and let
 * the tests tell you what else moved.
 *
 * The two rules that make this table honest, both learned the hard way:
 *
 *   - `usage.input_tokens` is the *uncached remainder*, not the prompt size.
 *     Cached tokens are reported separately and billed at different rates, so
 *     all three input fields must be priced independently. Pricing only
 *     `input_tokens` under-reports every cached request.
 *
 *   - A model we cannot price is an error, never $0. A silent zero disables the
 *     cap precisely when someone points ANTHROPIC_MODEL at a newly-launched
 *     model, which is the moment the cap matters most.
 */

/** Cache reads bill at a tenth of the base input rate. */
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Cache writes bill at 1.25x the base input rate for the default 5-minute TTL.
 * A 1-hour TTL bills 2x — we never request one, so it is not modeled here. If
 * `cache_control: {ttl: "1h"}` ever appears in this codebase, this constant
 * becomes a lie and needs to become a parameter.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;

const PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  // Sonnet 5 carries introductory pricing ($2/$10) through 2026-08-31. We bill
  // the standard rate: over-estimating spend fails closed (we refuse work the
  // user could afford), while under-estimating fails open (we spend money they
  // capped). Prefer the safe direction.
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const MTOK = 1_000_000;

/** Thrown when a model id has no entry in the price table. Never priced as 0. */
export class UnknownModelError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(
      `No price for model ${JSON.stringify(model)}. ` +
        `Add it to server/anthropic/pricing.ts — refusing to bill it as $0.`,
    );
    this.name = "UnknownModelError";
    this.model = model;
  }
}

/** The four token counters the Messages API reports on every response. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Cost in USD of one Anthropic call. Throws if the model is not priceable. */
export function priceUsd(model: string, usage: TokenUsage): number {
  const rate = PER_MTOK[model];
  // Before any arithmetic: a zero-usage call on an unpriceable model is still
  // a configuration error, and returning 0 here would hide it.
  if (!rate) throw new UnknownModelError(model);

  const inputUsd =
    (usage.input_tokens +
      usage.cache_read_input_tokens * CACHE_READ_MULTIPLIER +
      usage.cache_creation_input_tokens * CACHE_WRITE_MULTIPLIER) *
    (rate.input / MTOK);

  const outputUsd = usage.output_tokens * (rate.output / MTOK);

  return inputUsd + outputUsd;
}

/** True when `model` can be priced. Use to fail fast at boot, not at call time. */
export function isPriceable(model: string): boolean {
  return model in PER_MTOK;
}

/**
 * Normalize the SDK's `usage` (whose cache fields are nullable) into TokenUsage.
 * A missing counter is genuinely zero; a missing *model* is not (see above).
 */
export function toTokenUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): TokenUsage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}
