import { getDb } from "./migrate.js";

export interface RepoRow {
  id: number;
  provider: string;
  host: string | null;
  path: string;
  description: string | null;
  web_url: string | null;
  default_branch: string | null;
  language: string | null;
  preview_url_pattern: string | null;
  merge_method: string;
  claude_md_path: string | null;
  claude_md_cache: string | null;
  readme_excerpt_cache: string | null;
  file_tree_cache: string | null;
  automation_detected: number | null;
  context_refreshed_at: string | null;
}

export interface NewRepo {
  provider: string;
  host?: string | null;
  path: string;
  description?: string | null;
  web_url?: string | null;
  default_branch?: string | null;
  language?: string | null;
  preview_url_pattern?: string | null;
  merge_method?: string;
  claude_md_path?: string | null;
}

export function listRepos(): RepoRow[] {
  return getDb().prepare("SELECT * FROM repos ORDER BY path").all() as RepoRow[];
}

export function getRepo(id: number): RepoRow | undefined {
  return getDb().prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
}

export function insertRepo(repo: NewRepo): RepoRow {
  const info = getDb()
    .prepare(
      `INSERT INTO repos (provider, host, path, description, web_url, default_branch,
                          language, preview_url_pattern, merge_method, claude_md_path)
       VALUES (@provider, @host, @path, @description, @web_url, @default_branch,
               @language, @preview_url_pattern, @merge_method, @claude_md_path)`
    )
    .run({
      provider: repo.provider,
      host: repo.host ?? null,
      path: repo.path,
      description: repo.description ?? null,
      web_url: repo.web_url ?? null,
      default_branch: repo.default_branch ?? null,
      language: repo.language ?? null,
      preview_url_pattern: repo.preview_url_pattern ?? null,
      merge_method: repo.merge_method ?? "squash",
      claude_md_path: repo.claude_md_path ?? null,
    });
  return getRepo(Number(info.lastInsertRowid))!;
}

export function deleteRepo(id: number): boolean {
  return getDb().prepare("DELETE FROM repos WHERE id = ?").run(id).changes > 0;
}

export interface RepoContextCache {
  description?: string | null;
  claude_md_cache?: string | null;
  readme_excerpt_cache?: string | null;
  file_tree_cache?: string | null;
  automation_detected?: number | null;
  context_refreshed_at?: string | null;
  default_branch?: string | null;
  language?: string | null;
}

export function updateRepoContext(id: number, ctx: RepoContextCache): void {
  getDb()
    .prepare(
      `UPDATE repos SET
         description = COALESCE(@description, description),
         default_branch = COALESCE(@default_branch, default_branch),
         language = COALESCE(@language, language),
         claude_md_cache = @claude_md_cache,
         readme_excerpt_cache = @readme_excerpt_cache,
         file_tree_cache = @file_tree_cache,
         automation_detected = @automation_detected,
         context_refreshed_at = @context_refreshed_at
       WHERE id = @id`
    )
    .run({
      id,
      description: ctx.description ?? null,
      default_branch: ctx.default_branch ?? null,
      language: ctx.language ?? null,
      claude_md_cache: ctx.claude_md_cache ?? null,
      readme_excerpt_cache: ctx.readme_excerpt_cache ?? null,
      file_tree_cache: ctx.file_tree_cache ?? null,
      automation_detected:
        ctx.automation_detected === undefined ? null : ctx.automation_detected,
      context_refreshed_at: ctx.context_refreshed_at ?? null,
    });
}
