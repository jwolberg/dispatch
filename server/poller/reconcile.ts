import { getRepo, type RepoRow } from "../db/repos.js";
import { type TicketRow } from "../db/tickets.js";
import { getStatus, upsertStatus } from "../db/status.js";
import { insertActivity } from "../db/activity.js";
import { getProviderForRepo } from "../providers/index.js";
import type {
  GitProvider,
  Issue,
  PRRef,
  PRStatus,
  ProviderId,
  RepoRef,
  RevertRef,
  Run,
} from "../providers/index.js";
import { autoCloseKeyword } from "../providers/types.js";
import { linksToIssue } from "../providers/linkage.js";
import { isClaudeAuthored } from "./claude-branch.js";
import { safeMessage } from "../lib/redaction.js";
import { httpStatus } from "../lib/errors.js";
import { markRateLimited, retryAfter } from "../lib/ratelimit.js";

export type Column =
  | "Spec"
  | "Queued"
  | "Building"
  | "Ready to test"
  | "Merged"
  | "Deployed"
  | "Blocked";

export interface StatusPayload {
  column: Column;
  issue: { number: number; title: string; state: "open" | "closed"; url: string; body: string };
  progressComment: { author: string | null; body: string; url: string | null } | null;
  pr: PRStatus | null;
  /**
   * A revert of `pr`, opened by the user on the provider's site (ADR-0004).
   * Separate from `pr` on purpose: it must never displace the shipping PR, and
   * a card with an open revert is still Merged/Deployed.
   */
  revertPr: RevertRef | null;
  runs: Run[];
}

/**
 * Derive the single board column from provider state (PRD F4.1). Columns are
 * computed every poll, never stored as authoritative (ARCH §6/§7). The terminal
 * Merged/Deployed states and Blocked take precedence over in-flight states.
 */
export function deriveColumn(
  issueState: "open" | "closed",
  pr: PRStatus | null,
  runs: Run[]
): Column {
  // Terminal, checked first so a failing post-merge deploy never drags a merged
  // card back to Blocked (T2-3). When shipped, the caller has already switched
  // the runs ref to the default branch (see reconcileTicket), so `runs` here are
  // the deploy runs: a successful one means Deployed, otherwise the card
  // terminates at Merged — including a repo with no deploy pipeline (no runs),
  // a deploy still in progress, or a failed deploy. `Merged` is the honest
  // resting state; `Deployed` is claimed only on observed success.
  if (issueState === "closed" || pr?.merged) {
    return runs.some((r) => r.state === "success") ? "Deployed" : "Merged";
  }

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
 * Open the pull request for Claude's branch, if there is one (#4, ADR-0006 [2]).
 *
 * `claude-code-action` pushes a branch and stops. Dispatch opens the PR with its App
 * installation token, because a PR opened by the workflow's own `GITHUB_TOKEN` would
 * not trigger `on: pull_request` CI (GitHub's anti-recursion rule), while an
 * App-authored one does — observed in #22, not inferred (ADR-0006 [8]).
 *
 * Every guard here exists because **opening a PR from somebody's work-in-progress
 * branch is not a recoverable mistake**:
 *
 * - `linksToIssue()` alone is not enough. It matches a human branch named `fix-7`.
 *   The tip commit's identity is the discriminator, and it was sampled from a real
 *   run rather than inferred (`./__fixtures__/README.md`, #4 AC 9).
 * - The default branch is excluded, or a repo whose default branch is `release-7`
 *   would get a PR opened from `main` onto `main` for issue #7.
 * - A 422 means the PR already exists — two polls raced. Swallow it; the next
 *   reconcile finds the PR through `findLinkedPR` and proceeds normally.
 *
 * Callers must have established that no PR links to the issue yet. `findLinkedPR`
 * lists PRs with `state: "all"`, so a PR a human *closed* still counts as linked and
 * this is never reached — the poller does not resurrect it.
 *
 * Exported for tests. Returns the new PR, or null when nothing should be opened.
 */
/**
 * Label that marks an issue as a setup-time canary (#5). The canary files an
 * `@claude` issue purely to prove a build triggers, so it must NOT grow a pull
 * request the way a real ticket does — otherwise it leaves an artifact behind in
 * a user's repo, and racing the cleanup against this poller could orphan it. The
 * canary applies this label; the guard below is what makes the PR impossible
 * rather than merely cleaned up after the fact.
 */
export const CANARY_LABEL = "dispatch-canary";

export async function openPRForClaudeBranch(
  provider: GitProvider,
  ref: RepoRef,
  issue: Issue
): Promise<PRRef | null> {
  if (issue.state !== "open") return null;
  if (issue.labels.includes(CANARY_LABEL)) return null;

  const base = ref.defaultBranch;
  if (!base) return null;

  const branches = await provider.listBranches(ref);
  const candidates = branches.filter(
    (b) => b.name !== base && linksToIssue(issue.number, { branch: b.name, body: null })
  );

  for (const branch of candidates) {
    const identity = await provider.getCommitIdentity(ref, branch.sha);
    if (!isClaudeAuthored(identity)) continue;

    const keyword = autoCloseKeyword(ref.provider);
    try {
      return await provider.createPullRequest(ref, {
        head: branch.name,
        base,
        title: `Claude: ${issue.title}`,
        body:
          `${keyword} #${issue.number}\n\n` +
          `Implemented by \`@claude\` on \`${branch.name}\`; opened by Dispatch so CI runs ` +
          `on it. Review before merging.`,
      });
    } catch (err) {
      // 422 — a PR for this head already exists. Another poll won the race.
      if (httpStatus(err) === 422) return null;
      throw err;
    }
  }
  return null;
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
  let prRef = await provider.findLinkedPR(ref, ticket.issue_number);

  // No PR yet? Claude may have pushed a branch and stopped — Dispatch opens the PR
  // (ADR-0006 [2]). Best-effort: a failure here must not fail the reconcile, or a
  // single bad repo would stall the whole board. The next poll retries.
  if (!prRef) {
    try {
      prRef = await openPRForClaudeBranch(provider, ref, issue);
    } catch (err) {
      console.warn(`[poller] could not open PR for ${repo.path}#${issue.number}: ${safeMessage(err)}`);
    }
  }

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
