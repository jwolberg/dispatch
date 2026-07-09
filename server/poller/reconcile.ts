import { getRepo, type RepoRow } from "../db/repos.js";
import { type TicketRow } from "../db/tickets.js";
import { getStatus, upsertStatus } from "../db/status.js";
import { insertActivity } from "../db/activity.js";
import { getProviderForRepo } from "../providers/index.js";
import type { Issue, PRStatus, ProviderId, RepoRef, RevertRef, Run } from "../providers/index.js";
import { safeMessage } from "../lib/redaction.js";
import { markRateLimited, retryAfter } from "../lib/ratelimit.js";

export type Column = "Spec" | "Queued" | "Building" | "Ready to test" | "Shipped" | "Blocked";

export interface StatusPayload {
  column: Column;
  issue: { number: number; title: string; state: "open" | "closed"; url: string; body: string };
  progressComment: { author: string | null; body: string; url: string | null } | null;
  pr: PRStatus | null;
  /**
   * A revert of `pr`, opened by the user on the provider's site (ADR-0004).
   * Separate from `pr` on purpose: it must never displace the shipping PR, and
   * a card with an open revert is still Shipped.
   */
  revertPr: RevertRef | null;
  runs: Run[];
}

/**
 * Derive the single board column from provider state (PRD F4.1). Columns are
 * computed every poll, never stored as authoritative (ARCH §6/§7). Shipped and
 * Blocked take precedence over in-flight states.
 */
export function deriveColumn(
  issueState: "open" | "closed",
  pr: PRStatus | null,
  runs: Run[]
): Column {
  if (issueState === "closed" || pr?.merged) return "Shipped";

  const runFailed = runs.some((r) => r.state === "failure");
  const checkFailed = pr?.checks.some((c) => c.state === "failure") ?? false;
  if (runFailed || checkFailed) return "Blocked";

  if (pr && pr.state === "open") {
    // check-runs are unreadable by fine-grained PATs (Checks permission isn't
    // grantable), so pr.checks may omit Actions CI — also treat an in-progress
    // workflow run on the PR head as "still building".
    const building =
      pr.checks.some((c) => c.state === "pending") ||
      runs.some((r) => r.state === "queued" || r.state === "in_progress");
    return building ? "Building" : "Ready to test";
  }

  const runInProgress = runs.some((r) => r.state === "queued" || r.state === "in_progress");
  if (runInProgress) return "Building";

  return "Queued";
}

function pickProgressComment(issue: Issue): StatusPayload["progressComment"] {
  const byClaude = [...issue.comments].reverse().find((c) => /claude/i.test(c.author ?? ""));
  const withCheckboxes = [...issue.comments].reverse().find((c) => /- \[[ xX]\]/.test(c.body));
  const chosen = byClaude ?? withCheckboxes;
  return chosen ? { author: chosen.author, body: chosen.body, url: chosen.url } : null;
}

function diffActivity(ticketId: number, prev: StatusPayload | null, next: StatusPayload): void {
  const now = new Date().toISOString();
  const issueRef = `#${next.issue.number}`;

  if (!prev || prev.column !== next.column) {
    insertActivity({
      ticket_id: ticketId,
      type: `column:${next.column}`,
      summary: `${issueRef} → ${next.column}`,
      url: next.pr?.url ?? next.issue.url,
      occurred_at: now,
    });
  }
  if (!prev?.pr && next.pr) {
    insertActivity({
      ticket_id: ticketId,
      type: "pr_opened",
      summary: `${issueRef} PR #${next.pr.number} opened`,
      url: next.pr.url,
      occurred_at: now,
    });
  }
  // Dispatch did not open this one — the user did, on the provider's site. The
  // board finding out is the whole point of tracking it (T1-8, ADR-0004).
  if (!prev?.revertPr && next.revertPr) {
    insertActivity({
      ticket_id: ticketId,
      type: "revert_opened",
      summary: `${issueRef} revert PR #${next.revertPr.number} opened`,
      url: next.revertPr.url,
      occurred_at: now,
    });
  }
}

/**
 * Reconcile one ticket against the provider and persist a fresh status snapshot.
 * Invocable independently of the scheduler (webhook-ready, ARCH §15). Defensive:
 * always reconciles to whatever the provider reports (S6).
 */
export async function reconcileTicket(ticket: TicketRow): Promise<StatusPayload | null> {
  const repo = getRepo(ticket.repo_id);
  if (!repo) return null;

  const ref: RepoRef = {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };
  const provider = getProviderForRepo(ref);

  const issue = await provider.getIssue(ref, ticket.issue_number);
  const prRef = await provider.findLinkedPR(ref, ticket.issue_number);
  const pr = prRef ? await provider.getPRStatus(ref, prRef.number) : null;

  // Only a merged PR can have been reverted. Skipping the lookup otherwise keeps
  // the common path at its current call count (the adapters reuse the ETag'd PR
  // list, so this costs a 304 rather than a fresh page).
  const revertPr = pr?.merged ? await provider.findRevertPR(ref, pr.number) : null;

  // Run context (F6.3):
  //  - shipped (merged/closed): default branch → the production deploy run
  //  - PR exists: the PR head branch → build/check runs
  //  - pre-PR: default branch → the issue-triggered claude-code-action run
  const shipped = Boolean(pr?.merged) || issue.state === "closed";
  const runsRef = shipped
    ? repo.default_branch ?? "HEAD"
    : prRef?.headBranch ?? repo.default_branch ?? "HEAD";
  const runs = await provider.getWorkflowRuns(ref, runsRef);

  const payload: StatusPayload = {
    column: deriveColumn(issue.state, pr, runs),
    issue: {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      body: issue.body,
    },
    progressComment: pickProgressComment(issue),
    pr,
    revertPr,
    runs,
  };

  const prevRow = getStatus(ticket.id);
  let prev: StatusPayload | null = null;
  if (prevRow) {
    try {
      prev = JSON.parse(prevRow.payload_json) as StatusPayload;
    } catch {
      prev = null;
    }
  }

  diffActivity(ticket.id, prev, payload);
  upsertStatus(ticket.id, payload, new Date().toISOString());
  return payload;
}

/** Reconcile a ticket, swallowing provider errors (deleted issues, etc. — S6). */
export async function safeReconcile(ticket: TicketRow): Promise<void> {
  try {
    await reconcileTicket(ticket);
  } catch (err) {
    const backoff = retryAfter(err);
    if (backoff != null) markRateLimited(backoff); // honor 429/secondary limits (S3)
    console.warn(`[poller] reconcile ticket ${ticket.id} failed: ${safeMessage(err)}`);
  }
}

export function repoLabel(repo: RepoRow): string {
  return `${repo.provider}:${repo.path}`;
}
