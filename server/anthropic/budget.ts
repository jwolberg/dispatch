import { spentTodayUsd } from "../db/spend.js";

// T1-9 — the gate. Tier 1's exit criterion: "the tool cannot silently spend
// unbounded money."
//
// Two failure directions, and they are not symmetric. Refusing a call the user
// could afford costs them one retry. Permitting a call past their cap costs
// them money they said they did not want to spend. Every ambiguous case below
// resolves toward refusing.

/**
 * Thrown when the day's spend has reached or exceeded DISPATCH_DAILY_BUDGET_USD.
 *
 * `status: 429` rather than 500: this is a refusal, not a crash. The existing
 * S4 contract requires the client to redisplay the user's typed input, which it
 * does for 4xx and not for 5xx.
 */
export class BudgetExceededError extends Error {
  readonly status = 429;
  readonly spentUsd: number;
  readonly budgetUsd: number;

  constructor(spentUsd: number, budgetUsd: number) {
    super(
      `Daily budget reached: $${spentUsd.toFixed(2)} spent of ` +
        `$${budgetUsd.toFixed(2)} (DISPATCH_DAILY_BUDGET_USD). ` +
        `Resets at 00:00 UTC. Your message was not sent and was not lost.`,
    );
    this.name = "BudgetExceededError";
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
  }
}

/**
 * The configured cap, or undefined when none is set.
 *
 * A malformed value throws rather than reading as "no cap" — someone who typed
 * `DISPATCH_DAILY_BUDGET_USD="ten dollars"` wanted a limit, and silently
 * uncapping them is the exact outcome this ticket exists to prevent.
 */
export function dailyBudgetUsd(): number | undefined {
  const raw = process.env.DISPATCH_DAILY_BUDGET_USD;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `DISPATCH_DAILY_BUDGET_USD must be a non-negative number, got ${JSON.stringify(raw)}. ` +
        `Unset it to run without a cap.`,
    );
  }
  return parsed;
}

/**
 * Throw if the day's budget is already exhausted. Call this **before** the
 * Anthropic request — it reads only the ledger, so being over budget never
 * costs a further call to discover.
 *
 * The comparison is `>=`, not `>`: at $3 spent against a $3 cap the budget is
 * gone. Allowing one more call there would let any single request overshoot by
 * its own full cost.
 */
export function assertWithinBudget(now: Date): void {
  const budget = dailyBudgetUsd();
  if (budget === undefined) return;

  const spent = spentTodayUsd(now);
  if (spent >= budget) throw new BudgetExceededError(spent, budget);
}
