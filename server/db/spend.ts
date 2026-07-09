import { getDb } from "./migrate.js";
import { priceUsd, type TokenUsage } from "../anthropic/pricing.js";
import { markDirty } from "./snapshot.js";

// T1-9 — the spend ledger behind DISPATCH_DAILY_BUDGET_USD.
//
// This table is NOT disposable. See the note in schema.sql: wiping it fails
// open. Everything else in this file follows from that.

/** What kind of Anthropic call produced this spend. */
export type SpendKind = "chat" | "summary";

export interface SpendEntry {
  model: string;
  kind: SpendKind;
  usage: TokenUsage;
  /** Present when the call is attributable to one ticket (read by #14). */
  ticketId?: number;
  /** Injected so the day boundary is testable and never reads the wall clock. */
  at: Date;
}

/**
 * Price and record one Anthropic call. Returns the cost in USD.
 *
 * Throws UnknownModelError *before* writing, so an unpriceable model leaves no
 * row rather than a $0 one. A $0 row would understate the day's spend forever.
 *
 * Attribution is best-effort. `ticket_id` is resolved through a subquery so a
 * ticket that no longer exists yields NULL instead of a foreign-key violation:
 * the money was spent whether or not the ticket survived the call, and a lost
 * row would silently raise the day's remaining budget. Losing the attribution
 * costs #14 one unattributed line; losing the row costs the user money.
 */
export function recordSpend(entry: SpendEntry): number {
  const usd = priceUsd(entry.model, entry.usage);

  getDb()
    .prepare(
      `INSERT INTO spend (
         occurred_at, model, kind, ticket_id,
         input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, usd
       ) VALUES (
         @occurred_at, @model, @kind,
         (SELECT id FROM tickets WHERE id = @ticket_id),
         @input_tokens, @output_tokens,
         @cache_creation_input_tokens, @cache_read_input_tokens, @usd
       )`,
    )
    .run({
      occurred_at: entry.at.toISOString(),
      model: entry.model,
      kind: entry.kind,
      ticket_id: entry.ticketId ?? null,
      input_tokens: entry.usage.input_tokens,
      output_tokens: entry.usage.output_tokens,
      cache_creation_input_tokens: entry.usage.cache_creation_input_tokens,
      cache_read_input_tokens: entry.usage.cache_read_input_tokens,
      usd,
    });
  markDirty(); // the budget cap's ledger — a reset would silently re-grant the day's budget (#20)

  return usd;
}

/**
 * Inclusive start / exclusive end of the UTC day containing `now`.
 *
 * UTC, not local: a local boundary makes the cap reset at a time that depends
 * on the host's TZ, which on Cloud Run is whatever the base image says.
 */
function utcDayBounds(now: Date): { start: string; end: string } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Total USD spent during the UTC day containing `now`. */
export function spentTodayUsd(now: Date): number {
  const { start, end } = utcDayBounds(now);
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(usd), 0) AS total
         FROM spend
        WHERE occurred_at >= @start AND occurred_at < @end`,
    )
    .get({ start, end }) as { total: number };
  return row.total;
}

/** Test/teardown only. Never call this from a request path — it fails open. */
export function clearSpend(): void {
  getDb().exec("DELETE FROM spend");
}
