import { describe, it, expect, beforeEach } from "vitest";
import { recordSpend, spentTodayUsd, clearSpend, ticketSpend } from "./spend.js";
import { getDb } from "./migrate.js";
import { UnknownModelError } from "../anthropic/pricing.js";

// T1-9 (ticket #10) — the ledger behind DISPATCH_DAILY_BUDGET_USD.
//
// Unlike http_cache and status_cache, `spend` is NOT disposable. It is the only
// record that money was spent; wiping it resets the cap to zero and fails OPEN.
// That asymmetry is why the day boundary and the recording path are pinned here
// rather than left to the caller.

const SONNET = "claude-sonnet-4-6"; // $3/MTok in, $15/MTok out
const M = 1_000_000;

/** 1M input tokens on Sonnet = $3.00 exactly. A convenient unit of spend. */
const oneDollarish = { input_tokens: M, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** Insert a repo + ticket and return the ticket id. Tickets require a repo. */
function seedTicket(): number {
  const db = getDb();
  db.exec("DELETE FROM spend; DELETE FROM tickets; DELETE FROM repos");
  const repo = db
    .prepare("INSERT INTO repos (provider, path) VALUES ('github', 'acme/widgets')")
    .run();
  const ticket = db
    .prepare(
      "INSERT INTO tickets (repo_id, issue_number, created_at) VALUES (?, 7, '2026-07-09T00:00:00.000Z')",
    )
    .run(repo.lastInsertRowid);
  return Number(ticket.lastInsertRowid);
}

describe("recordSpend", () => {
  beforeEach(() => clearSpend());

  it("returns the cost it recorded", () => {
    const usd = recordSpend({
      model: SONNET,
      kind: "chat",
      usage: oneDollarish,
      at: new Date("2026-07-09T12:00:00Z"),
    });
    expect(usd).toBeCloseTo(3, 6);
  });

  it("accumulates across calls", () => {
    const at = new Date("2026-07-09T12:00:00Z");
    recordSpend({ model: SONNET, kind: "chat", usage: oneDollarish, at });
    recordSpend({ model: SONNET, kind: "summary", usage: oneDollarish, at });
    expect(spentTodayUsd(at)).toBeCloseTo(6, 6);
  });

  it("attributes spend to a ticket when one applies", () => {
    const at = new Date("2026-07-09T12:00:00Z");
    const ticketId = seedTicket();
    recordSpend({ model: SONNET, kind: "summary", usage: oneDollarish, ticketId, at });

    // Ticket attribution is what #14 (per-ticket cost telemetry) will read.
    const row = getDb()
      .prepare("SELECT ticket_id FROM spend")
      .get() as { ticket_id: number | null };
    expect(row.ticket_id).toBe(ticketId);
  });

  it("records the spend but drops attribution when the ticket does not exist", () => {
    // The money left the account regardless of whether the ticket survived the
    // call. A foreign-key violation here would throw away the row and silently
    // raise the day's remaining budget — the exact fail-open this ticket exists
    // to prevent. Attribution is best-effort; the ledger is not.
    const at = new Date("2026-07-09T12:00:00Z");
    expect(() =>
      recordSpend({ model: SONNET, kind: "summary", usage: oneDollarish, ticketId: 999_999, at }),
    ).not.toThrow();

    expect(spentTodayUsd(at)).toBeCloseTo(3, 6);
    const row = getDb()
      .prepare("SELECT ticket_id FROM spend")
      .get() as { ticket_id: number | null };
    expect(row.ticket_id).toBeNull();
  });

  it("keeps the spend row when its ticket is later deleted", () => {
    const at = new Date("2026-07-09T12:00:00Z");
    const ticketId = seedTicket();
    recordSpend({ model: SONNET, kind: "summary", usage: oneDollarish, ticketId, at });

    getDb().prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);

    // ON DELETE SET NULL, not CASCADE: the cost survives, the attribution does not.
    expect(spentTodayUsd(at)).toBeCloseTo(3, 6);
  });

  it("refuses to record an unpriceable model rather than logging it as $0", () => {
    const at = new Date("2026-07-09T12:00:00Z");
    expect(() =>
      recordSpend({ model: "claude-unpriced-9", kind: "chat", usage: oneDollarish, at }),
    ).toThrow(UnknownModelError);
    // and nothing was written
    expect(spentTodayUsd(at)).toBe(0);
  });
});

describe("ticketSpend — the token half of #14's per-ticket cost", () => {
  beforeEach(() => clearSpend());

  it("is a zeroed row for a ticket with no attributed spend", () => {
    const ticketId = seedTicket();
    expect(ticketSpend(ticketId)).toEqual({ usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
  });

  it("sums usd and tokens across every call attributed to the ticket", () => {
    const at = new Date("2026-07-09T12:00:00Z");
    const ticketId = seedTicket();
    recordSpend({ model: SONNET, kind: "summary", usage: oneDollarish, ticketId, at });
    recordSpend({
      model: SONNET,
      kind: "chat",
      usage: { input_tokens: M, output_tokens: 2 * M, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ticketId,
      at,
    });

    const cost = ticketSpend(ticketId);
    expect(cost.calls).toBe(2);
    expect(cost.inputTokens).toBe(2 * M);
    expect(cost.outputTokens).toBe(2 * M);
    // 2×$3 input + (2M output × $15/MTok = $30) = $36.
    expect(cost.usd).toBeCloseTo(36, 6);
  });

  it("does not count spend attributed to a different ticket, nor unattributed spend", () => {
    const at = new Date("2026-07-09T12:00:00Z");
    const mine = seedTicket();
    // A second ticket in the same repo.
    const other = Number(
      getDb()
        .prepare("INSERT INTO tickets (repo_id, issue_number, created_at) VALUES ((SELECT repo_id FROM tickets WHERE id = ?), 8, ?)")
        .run(mine, at.toISOString()).lastInsertRowid,
    );
    recordSpend({ model: SONNET, kind: "chat", usage: oneDollarish, ticketId: other, at });
    recordSpend({ model: SONNET, kind: "chat", usage: oneDollarish, at }); // unattributed

    expect(ticketSpend(mine)).toEqual({ usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
    expect(ticketSpend(other).usd).toBeCloseTo(3, 6);
  });
});

describe("spentTodayUsd — the day boundary is UTC, and it is a boundary", () => {
  beforeEach(() => clearSpend());

  it("is zero on a fresh ledger", () => {
    expect(spentTodayUsd(new Date("2026-07-09T12:00:00Z"))).toBe(0);
  });

  it("counts spend recorded earlier the same UTC day", () => {
    recordSpend({ model: SONNET, kind: "chat", usage: oneDollarish, at: new Date("2026-07-09T00:00:00.000Z") });
    expect(spentTodayUsd(new Date("2026-07-09T23:59:59.999Z"))).toBeCloseTo(3, 6);
  });

  it("excludes spend from the previous UTC day", () => {
    recordSpend({ model: SONNET, kind: "chat", usage: oneDollarish, at: new Date("2026-07-08T23:59:59.999Z") });
    expect(spentTodayUsd(new Date("2026-07-09T00:00:00.000Z"))).toBe(0);
  });

  it("excludes spend from the next UTC day", () => {
    recordSpend({ model: SONNET, kind: "chat", usage: oneDollarish, at: new Date("2026-07-10T00:00:00.000Z") });
    expect(spentTodayUsd(new Date("2026-07-09T23:59:59.999Z"))).toBe(0);
  });

  it("does not roll over at local midnight in a non-UTC zone", () => {
    // 2026-07-09T02:00Z is still 2026-07-08 in America/New_York. If the
    // boundary were local, this spend would land on the wrong day and the cap
    // would reset twice (or never) depending on the host's TZ.
    const at = new Date("2026-07-09T02:00:00.000Z");
    recordSpend({ model: SONNET, kind: "chat", usage: oneDollarish, at });
    expect(spentTodayUsd(new Date("2026-07-09T20:00:00.000Z"))).toBeCloseTo(3, 6);
  });
});
