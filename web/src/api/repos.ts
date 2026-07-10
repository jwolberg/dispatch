import { api } from "./client.js";
import type { RepoSummary, TrackedRepo } from "./types.js";

export interface TrackBody {
  provider?: "github" | "gitlab";
  host?: string | null;
  path?: string;
  url?: string;
  default_branch?: string | null;
  web_url?: string | null;
  preview_url_pattern?: string | null;
  merge_method?: string;
  claude_md_path?: string | null;
}

/** One credential that could not be enumerated (#21). `label` is an account login. */
export interface DiscoverError {
  label: string;
  error: string;
}

export const reposApi = {
  discover: (provider: "github" | "gitlab") =>
    api.get<{ provider: string; repos: RepoSummary[]; errors: DiscoverError[] }>(
      `/discover?provider=${provider}`
    ),
  list: () => api.get<{ repos: TrackedRepo[] }>("/repos"),
  track: (body: TrackBody) => api.post<{ repo: TrackedRepo }>("/repos", body),
  untrack: (id: number) => api.del<{ ok: boolean }>(`/repos/${id}`),
  refresh: (id: number) => api.post<{ repo: TrackedRepo }>(`/repos/${id}/refresh-context?force=1`),
};
