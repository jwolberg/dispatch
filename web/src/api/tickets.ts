import { api } from "./client.js";

export interface FiledTicket {
  id: number;
  issue_number: number;
  url: string;
}

export interface Check {
  name: string;
  state: "pending" | "success" | "failure" | "neutral";
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
  headSha: string;
  baseBranch: string;
  url: string;
  checks: Check[];
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  previewUrl: string | null;
}

/** A revert of the shipped PR, opened by the user on the provider (T1-8). */
export interface RevertRef {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
}

/** T1-5 — the plain-language summary above the fold. `risk` is a closed set (#7). */
export interface ChangeSummary {
  whatChanged: string;
  howToTest: string;
  risk: "low" | "review-this";
}

/** Why there is no summary. The route degrades rather than erroring. */
export type SummaryUnavailable = "no-pr" | "budget" | "error";

export interface SummaryResponse {
  summary: ChangeSummary | null;
  unavailable: SummaryUnavailable | null;
}

/** T2-4 — the token half of a ticket's build cost. */
export interface TicketTokens {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/** T2-4 — the Actions half. `unknownRuns` were billed but we could not price them. */
export interface ActionsCost {
  minutes: number;
  usd: number;
  unknownRuns: number;
}

export interface CostResponse {
  tokens: TicketTokens;
  /** null when the provider has no GitHub-Actions billing (GitLab). */
  actions: ActionsCost | null;
  runnerAssumption: "standard-linux";
}
export interface Run {
  id: string;
  name: string;
  event: string | null;
  title: string | null;
  state: string;
  url: string | null;
  createdAt: string;
}
export interface TicketDetail {
  ticket: { id: number; issue_number: number; chat_id: number | null; created_at: string };
  repo: {
    id: number;
    path: string;
    provider: string;
    host: string | null;
    preview_url_pattern: string | null;
    merge_method: string;
    default_branch: string | null;
    web_url: string | null;
  };
  status: {
    column: string;
    issue: { number: number; title: string; state: string; url: string; body: string };
    progressComment: { author: string | null; body: string; url: string | null } | null;
    pr: PRStatus | null;
    /** A revert of `pr` the user opened on the provider's site (T1-8). */
    revertPr: RevertRef | null;
    runs: Run[];
  } | null;
  updated_at: string | null;
}

export const ticketsApi = {
  get: (id: number) => api.get<TicketDetail>(`/tickets/${id}`),
  // Generated lazily on first call and cached server-side per head SHA. Do NOT
  // poll this: a summary the model failed to produce would re-bill every tick.
  summary: (id: number) => api.get<SummaryResponse>(`/tickets/${id}/summary`),
  // Derived per-ticket build cost: tokens (spend ledger) + Actions minutes
  // (provider timing). Fetched on card open, not polled; timing is cond-cached.
  cost: (id: number) => api.get<CostResponse>(`/tickets/${id}/cost`),
  comment: (id: number, body: { body: string; target: "issue" | "pr" }) =>
    api.post<{ ok: boolean }>(`/tickets/${id}/comment`, body),
  skill: (
    id: number,
    body: { skill: "ci-plan" | "ci-implement" | "ci-debug"; note?: string; target?: "issue" | "pr" }
  ) => api.post<{ ok: boolean }>(`/tickets/${id}/skill`, body),
  merge: (id: number, method?: string) =>
    api.post<{ merged: boolean; sha: string | null }>(`/tickets/${id}/merge`, { method }),
  // Dispatch does not revert (ADR-0004) — it resolves the provider's own revert
  // page and the user finishes there.
  revertUrl: (id: number) => api.get<{ url: string }>(`/tickets/${id}/revert-url`),
  file: (body: {
    repo_id: number;
    chat_id: number | null;
    title: string;
    body_markdown: string;
    labels: string[];
  }) => api.post<{ ticket: FiledTicket }>("/tickets", body),
};
