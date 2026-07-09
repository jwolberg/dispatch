import { describe, it, expect, beforeEach } from "vitest";
import { getSummary, putSummary, clearSummaries } from "./summary-cache.js";
import { getDb } from "./migrate.js";
import type { ChangeSummary } from "../anthropic/summary.js";

// T1-5 (ticket #6) — the cache is the whole cost story.
//
// A summary is billed once per (ticket, head SHA). The SHA is not decoration:
// without it the card would show a summary of code that has since been rewritten
// — confidently, and with no way for the reader to tell.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const summary: ChangeSummary = {
  whatChanged: "Adds a daily spend cap on Anthropic calls.",
  howToTest: "Open a chat and send a message; it should still stream.",
  risk: "low",
};

function seedTicket(): number {
  const db = getDb();
  db.exec("DELETE FROM summary_cache; DELETE FROM tickets; DELETE FROM repos");
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

const NOW = "2026-07-09T12:00:00.000Z";

describe("summary_cache", () => {
  beforeEach(() => clearSummaries());

  it("misses on an empty cache", () => {
    const id = seedTicket();
    expect(getSummary(id, SHA_A)).toBeUndefined();
  });

  it("round-trips a summary for the same SHA", () => {
    const id = seedTicket();
    putSummary(id, SHA_A, summary, NOW);
    expect(getSummary(id, SHA_A)).toEqual(summary);
  });

  it("misses when the head SHA has moved — a new commit is a new summary", () => {
    const id = seedTicket();
    putSummary(id, SHA_A, summary, NOW);
    // The PR was force-pushed. The cached prose describes code that is gone.
    expect(getSummary(id, SHA_B)).toBeUndefined();
  });

  it("replaces rather than accumulating when a ticket gets a new SHA", () => {
    const id = seedTicket();
    putSummary(id, SHA_A, summary, NOW);
    putSummary(id, SHA_B, { ...summary, risk: "review-this" }, NOW);

    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM summary_cache").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(getSummary(id, SHA_B)?.risk).toBe("review-this");
    expect(getSummary(id, SHA_A)).toBeUndefined();
  });

  it("drops a corrupt row rather than surfacing it", () => {
    // Same discipline as http_cache (T0-9): a row we cannot parse is a miss,
    // which costs one re-summarize. Returning half a summary costs trust.
    const id = seedTicket();
    getDb()
      .prepare(
        "INSERT INTO summary_cache (ticket_id, head_sha, payload_json, updated_at) VALUES (?, ?, '{not json', ?)",
      )
      .run(id, SHA_A, NOW);

    expect(getSummary(id, SHA_A)).toBeUndefined();
  });

  it("is disposable: deleting the ticket takes its summary with it", () => {
    const id = seedTicket();
    putSummary(id, SHA_A, summary, NOW);
    getDb().prepare("DELETE FROM tickets WHERE id = ?").run(id);

    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM summary_cache").get() as { n: number };
    // Unlike `spend`, this table holds no record of money — CASCADE is correct.
    expect(rows.n).toBe(0);
  });
});
