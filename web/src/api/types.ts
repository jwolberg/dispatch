// Shared response shapes mirrored from the backend. Kept hand-synced rather
// than imported so the web build stays decoupled from server code.

export interface ProviderHealth {
  provider: "github" | "gitlab";
  configured: boolean;
  valid: boolean;
  remaining: number | null;
  limit: number | null;
  reset: string | null;
  error: string | null;
}

export interface Health {
  ok: boolean;
  db: { ok: boolean };
  anthropic: { configured: boolean };
  providers: ProviderHealth[];
}

export interface RepoSummary {
  provider: "github" | "gitlab";
  host: string | null;
  path: string;
  description: string | null;
  defaultBranch: string | null;
  language: string | null;
  visibility: string | null;
  lastActivity: string | null;
  webUrl: string | null;
}

export interface TrackedRepo {
  id: number;
  provider: "github" | "gitlab";
  host: string | null;
  path: string;
  description: string | null;
  web_url: string | null;
  default_branch: string | null;
  language: string | null;
  preview_url_pattern: string | null;
  merge_method: string;
  claude_md_path: string | null;
  has_claude_md: boolean;
  automation_detected: number | null;
  context_refreshed_at: string | null;
  structure_summary: { dir: string; count: number }[];
}
