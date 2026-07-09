import { useEffect, useState } from "react";
import { ticketsApi, type ChangeSummary, type SummaryUnavailable } from "../api/tickets.js";

// T1-5 — the plain-language change summary, above the fold.
//
// The person reading this cannot read a diff. A list of check names tells them
// nothing; this tells them what changed, what to click, and whether to look
// closer before shipping.

const RISK_LABEL: Record<ChangeSummary["risk"], string> = {
  low: "Low risk",
  "review-this": "Review this",
};

const RISK_CLS: Record<ChangeSummary["risk"], string> = {
  low: "border-status-ok/40 bg-status-ok/10 text-status-ok",
  "review-this": "border-status-wait/40 bg-status-wait/10 text-status-wait",
};

// Never surface a raw error to someone who cannot act on it. Each of these is a
// quiet line, not an alarm — the card around it still works.
const UNAVAILABLE_TEXT: Record<SummaryUnavailable, string> = {
  "no-pr": "No summary yet — Claude hasn't opened a pull request.",
  budget: "Summary skipped: today's Anthropic budget is spent. It resets at midnight UTC.",
  error: "Couldn't summarize this change. Reload to try again.",
};

/**
 * Fetch once per (ticket, head SHA) — deliberately NOT on the card's 10s poll.
 *
 * The server caches by head SHA, so a poll would mostly hit that cache. But a
 * summary the model failed to produce is not cached, and polling would re-bill
 * that failure every ten seconds for as long as the card stayed open.
 */
export function ChangeSummaryCard({ ticketId, headSha }: { ticketId: number; headSha: string | null }) {
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  const [unavailable, setUnavailable] = useState<SummaryUnavailable | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!headSha) {
      setSummary(null);
      setUnavailable("no-pr");
      return;
    }

    let active = true;
    setLoading(true);
    ticketsApi
      .summary(ticketId)
      .then((res) => {
        if (!active) return;
        setSummary(res.summary);
        setUnavailable(res.unavailable);
      })
      .catch(() => {
        if (active) setUnavailable("error");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [ticketId, headSha]);

  if (loading) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="text-body text-gray-500">Summarizing the change…</p>
      </section>
    );
  }

  if (!summary) {
    // "No PR yet" is the normal early state of every ticket; it does not deserve
    // a section header of its own.
    if (!unavailable || unavailable === "no-pr") return null;
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="text-label text-gray-500">{UNAVAILABLE_TEXT[unavailable]}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-body font-semibold text-gray-200">What changed</h2>
        <span className={`rounded-full border px-2 py-0.5 text-label ${RISK_CLS[summary.risk]}`}>
          {RISK_LABEL[summary.risk]}
        </span>
      </div>

      <p className="text-body text-gray-200">{summary.whatChanged}</p>

      <h3 className="mt-3 text-label font-semibold uppercase tracking-wide text-gray-500">
        How to test it
      </h3>
      <p className="text-body text-gray-300">{summary.howToTest}</p>
    </section>
  );
}
