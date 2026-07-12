// T2-5 (ticket #15) — the review-artifact contract, Dispatch's read side.
//
// Dispatch and TerMinal share ONE contract — the artifact schema — and neither
// imports the other (CLAUDE.md [6], the code-review agent contract). This module
// parses that schema and evaluates the ship gate. It is pure and fail-closed:
// anything it cannot fully trust becomes `null`, and `null` never ships.

export type Verdict = "approve" | "request-changes" | "blocked";
export type TestStatus = "pass" | "fail" | "partial" | "error" | "missing";
export type Severity = "critical" | "high" | "medium" | "low";

export interface ReviewArtifact {
  verdict: Verdict;
  testStatus: TestStatus;
  /** Count of OPEN findings at each severity (resolved findings are excluded). */
  openFindings: Record<Severity, number>;
}

export interface ShipGate {
  allowed: boolean;
  /** Why Ship is refused, for the user; null when allowed. */
  reason: string | null;
}

const VERDICTS = new Set<Verdict>(["approve", "request-changes", "blocked"]);
const TEST_STATUSES = new Set<TestStatus>(["pass", "fail", "partial", "error", "missing"]);
const SEVERITIES = new Set<Severity>(["critical", "high", "medium", "low"]);

/** Read one scalar out of `---`-fenced frontmatter. Strips quotes + `# comment`. */
function frontmatterValue(md: string, key: string): string | null {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m && m[1] === key) {
      // Drop a trailing ` # comment`, then surrounding quotes and whitespace.
      const raw = m[2].replace(/\s+#.*$/, "").trim();
      return raw.replace(/^["']|["']$/g, "").trim();
    }
  }
  return null;
}

/**
 * Parse a review artifact from its `<sha>.md` body and `findings.json` text.
 *
 * Returns `null` — which the gate treats as "blocked" — for anything less than a
 * complete, well-formed artifact: no markdown, frontmatter missing `verdict` or
 * `test_status`, an unrecognized enum value, or absent/unparseable findings.json.
 * "Absent" is the normal state on the first run after onboarding, so this path
 * is exercised in production; it must fail closed.
 */
export function parseReviewArtifact(
  md: string | null,
  findingsJson: string | null
): ReviewArtifact | null {
  if (!md) return null;

  const verdict = frontmatterValue(md, "verdict");
  const testStatus = frontmatterValue(md, "test_status");
  if (!verdict || !VERDICTS.has(verdict as Verdict)) return null;
  if (!testStatus || !TEST_STATUSES.has(testStatus as TestStatus)) return null;

  if (!findingsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(findingsJson);
  } catch {
    return null;
  }
  const list = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return null;

  const openFindings: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of list) {
    const sev = (f as { severity?: string }).severity;
    const status = (f as { status?: string }).status;
    if (status === "open" && sev && SEVERITIES.has(sev as Severity)) {
      openFindings[sev as Severity]++;
    }
  }

  return { verdict: verdict as Verdict, testStatus: testStatus as TestStatus, openFindings };
}

/**
 * The ship gate. Allowed ONLY on the full bar: verdict approve, tests pass, and
 * zero open findings at medium or above. A null artifact (missing/unparseable)
 * is refused — the gate never opens on absence.
 */
export function evaluateShipGate(review: ReviewArtifact | null): ShipGate {
  if (!review) {
    return { allowed: false, reason: "No review artifact for this commit — Ship is fail-closed until one lands." };
  }
  if (review.verdict !== "approve") {
    return { allowed: false, reason: `Review verdict is "${review.verdict}", not approve.` };
  }
  if (review.testStatus !== "pass") {
    return { allowed: false, reason: `Review test_status is "${review.testStatus}", not pass.` };
  }
  const blocking = review.openFindings.critical + review.openFindings.high + review.openFindings.medium;
  if (blocking > 0) {
    return { allowed: false, reason: `${blocking} open finding${blocking === 1 ? "" : "s"} at medium or above.` };
  }
  return { allowed: true, reason: null };
}
