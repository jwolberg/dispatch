// The provider seam (PRD §5.5 / F1a, ARCH §5).
//
// Everything outside server/providers/ speaks ONLY these types — never Octokit
// or Gitbeaker. Each adapter normalizes its provider's concepts into this one
// vocabulary so GitHub and GitLab repos coexist on a single board.

export type ProviderId = "github" | "gitlab";

export type MergeMethod = "squash" | "merge" | "rebase";

/** Identity needed to address a repo on its provider. */
export interface RepoRef {
  provider: ProviderId;
  host?: string | null; // base URL for self-hosted (GitLab)
  path: string; // owner/name (GitHub) or group/.../project (GitLab)
  defaultBranch?: string | null;
}

/** A repo as surfaced by discovery (PRD F1.0). */
export interface RepoSummary {
  provider: ProviderId;
  host?: string | null;
  path: string;
  description: string | null;
  defaultBranch: string | null;
  language: string | null;
  visibility: string | null;
  lastActivity: string | null; // ISO timestamp
  webUrl: string | null;
}

/** Cached repo context that feeds the repo card and spec-chat injection (F1.3). */
export interface RepoContext {
  description: string | null;
  defaultBranch: string | null;
  language: string | null;
  claudeMd: string | null;
  readmeExcerpt: string | null;
  fileTree: string[]; // depth-2 paths, e.g. "src/", "src/index.ts"
  automationDetected: boolean; // claude workflow (GitHub) / claude job (GitLab)
}

/** Structured spec produced by the chat flow (F2.3), used to file an issue. */
export interface SpecInput {
  title: string;
  body_markdown: string;
  labels: string[];
}

export interface IssueRef {
  number: number;
  url: string;
}

export interface IssueComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
  url: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: IssueComment[];
  url: string;
}

export interface PRRef {
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
}

export type CheckState = "pending" | "success" | "failure" | "neutral";

export interface Check {
  name: string;
  state: CheckState;
  url: string | null;
}

export interface PRStatus {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergeable: boolean | null;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  url: string;
  checks: Check[];
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  previewUrl: string | null; // from deployments/statuses/bot comments (F5.2)
}

export type RunState = "queued" | "in_progress" | "success" | "failure" | "neutral";

/** Actions workflow run (GitHub) / CI pipeline (GitLab). */
export interface Run {
  id: string;
  name: string;
  state: RunState;
  url: string | null;
  createdAt: string;
}

export interface MergeResult {
  merged: boolean;
  message: string | null;
  sha: string | null;
}

/** Rate-limit snapshot for the health route + footer (PRD F4.2 / S3). */
export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  reset: string | null; // ISO timestamp
}

/** Where a steer comment goes (F4.5): the issue or its PR/MR. */
export interface CommentTarget {
  repo: RepoRef;
  kind: "issue" | "pr";
  number: number;
}

/**
 * The single interface the whole app depends on. Adapters are constructed bound
 * to a provider + host + token by the factory in ./index.ts. All methods are
 * async (every call hits the network).
 */
export interface GitProvider {
  /** Validates the token and returns its rate-limit budget (throws if invalid). */
  getRateLimit(): Promise<RateLimit>;
  discoverRepos(): Promise<RepoSummary[]>;
  getRepoContext(repo: RepoRef, claudeMdPath?: string | null): Promise<RepoContext>;
  createIssue(repo: RepoRef, spec: SpecInput): Promise<IssueRef>;
  postComment(target: CommentTarget, body: string): Promise<void>;
  getIssue(repo: RepoRef, issueNumber: number): Promise<Issue>;
  findLinkedPR(repo: RepoRef, issueNumber: number): Promise<PRRef | null>;
  getPRStatus(repo: RepoRef, prNumber: number): Promise<PRStatus>;
  getWorkflowRuns(repo: RepoRef, ref: string): Promise<Run[]>;
  mergePR(repo: RepoRef, prNumber: number, method: MergeMethod): Promise<MergeResult>;
}

/** Provider-specific issue auto-close keyword (ARCH §5). */
export function autoCloseKeyword(provider: ProviderId): string {
  return provider === "gitlab" ? "Closes" : "Fixes";
}
