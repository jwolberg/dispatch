import type { ReviewResponse } from "../api/tickets.js";

// T2-5 (ticket #15) — render the code-review artifact and the ship gate.
//
// The gate shown here is for the reader; Ship is enforced server-side on merge
// (a hidden button is not a gate). Fail-closed reads as a plain "not reviewed
// yet" line, not an error — a freshly-onboarded repo simply has no artifact.

const VERDICT_CLS: Record<string, string> = {
  approve: "border-status-ok/40 bg-status-ok/10 text-status-ok",
  "request-changes": "border-status-wait/40 bg-status-wait/10 text-status-wait",
  blocked: "border-status-fail/40 bg-status-fail/10 text-status-fail",
};

export function ReviewCard({ data }: { data: ReviewResponse | null }) {
  if (!data || data.unavailable === "no-pr") {
    return <p className="text-body text-gray-500">No review yet — Claude hasn't opened a pull request.</p>;
  }

  const { review, gate } = data;

  if (!review) {
    // Fail-closed but calm: the artifact is simply absent (the normal state
    // right after onboarding, before CI has emitted one).
    return (
      <div>
        <p className="text-body text-gray-300">Not reviewed yet.</p>
        <p className="mt-1 text-label text-status-wait">{gate.reason}</p>
      </div>
    );
  }

  const blocking =
    review.openFindings.critical + review.openFindings.high + review.openFindings.medium;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-body font-semibold text-gray-200">Code review</h2>
        <span className={`rounded-full border px-2 py-0.5 text-label ${VERDICT_CLS[review.verdict] ?? "text-gray-400"}`}>
          {review.verdict}
        </span>
        <span className="text-label text-gray-500">tests: {review.testStatus}</span>
      </div>

      <div className="text-label text-gray-400">
        {blocking > 0 ? (
          <span className="text-status-fail">
            {blocking} open finding{blocking === 1 ? "" : "s"} at medium+
          </span>
        ) : (
          <span>No blocking findings</span>
        )}
        {review.openFindings.low > 0 && <span> · {review.openFindings.low} low</span>}
      </div>

      <p className={`mt-2 text-label ${gate.allowed ? "text-status-ok" : "text-status-wait"}`}>
        {gate.allowed ? "✓ Meets the ship bar." : `Ship blocked: ${gate.reason}`}
      </p>
    </div>
  );
}
