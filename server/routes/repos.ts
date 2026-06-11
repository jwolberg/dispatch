import { Router } from "express";
import {
  listRepos,
  getRepo,
  insertRepo,
  deleteRepo,
  updateRepoContext,
  type RepoRow,
} from "../db/repos.js";
import { getProvider } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import { safeMessage } from "../lib/redaction.js";
import { httpStatus } from "../lib/errors.js";

export const reposRouter = Router();

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function refToRow(row: RepoRow): RepoRef {
  return {
    provider: row.provider as ProviderId,
    host: row.host,
    path: row.path,
    defaultBranch: row.default_branch,
  };
}

/** Root-level structure summary for the repo card (PRD F1.4). */
function summarizeTree(fileTreeJson: string | null): { dir: string; count: number }[] {
  if (!fileTreeJson) return [];
  let paths: string[];
  try {
    paths = JSON.parse(fileTreeJson) as string[];
  } catch {
    return [];
  }
  const counts = new Map<string, number>();
  for (const p of paths) {
    const trimmed = p.replace(/\/$/, "");
    if (!trimmed.includes("/")) {
      if (p.endsWith("/")) counts.set(trimmed, counts.get(trimmed) ?? 0);
    } else {
      const root = trimmed.split("/")[0];
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([dir, count]) => ({ dir, count })).sort((a, b) => a.dir.localeCompare(b.dir));
}

function presentRepo(row: RepoRow) {
  return {
    id: row.id,
    provider: row.provider,
    host: row.host,
    path: row.path,
    description: row.description,
    web_url: row.web_url,
    default_branch: row.default_branch,
    language: row.language,
    preview_url_pattern: row.preview_url_pattern,
    merge_method: row.merge_method,
    claude_md_path: row.claude_md_path,
    has_claude_md: Boolean(row.claude_md_cache),
    automation_detected: row.automation_detected,
    context_refreshed_at: row.context_refreshed_at,
    structure_summary: summarizeTree(row.file_tree_cache),
  };
}

/** Parse a manual path or URL into provider identity (PRD F1.1 fallback). */
function parseRepoInput(input: string): { provider: ProviderId; host: string | null; path: string } {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/^\/+|\/+$|\.git$/g, "");
    if (/github\.com$/i.test(url.hostname)) return { provider: "github", host: null, path };
    if (/gitlab\.com$/i.test(url.hostname)) return { provider: "gitlab", host: null, path };
    // Assume self-hosted GitLab for any other host.
    return { provider: "gitlab", host: url.origin, path };
  }
  // Bare "owner/name" path defaults to GitHub.
  return { provider: "github", host: null, path: trimmed.replace(/\.git$/, "") };
}

async function refreshContext(row: RepoRow, force: boolean): Promise<RepoRow> {
  const fresh =
    !force &&
    row.context_refreshed_at != null &&
    Date.now() - Date.parse(row.context_refreshed_at) < SIX_HOURS_MS;
  if (fresh) return row;

  const ctx = await getProvider(row.provider as ProviderId, row.host).getRepoContext(
    refToRow(row),
    row.claude_md_path
  );
  updateRepoContext(row.id, {
    description: ctx.description,
    default_branch: ctx.defaultBranch,
    language: ctx.language,
    claude_md_cache: ctx.claudeMd,
    readme_excerpt_cache: ctx.readmeExcerpt,
    file_tree_cache: JSON.stringify(ctx.fileTree),
    automation_detected: ctx.automationDetected ? 1 : 0,
    context_refreshed_at: new Date().toISOString(),
  });
  return getRepo(row.id)!;
}

// GET /api/repos — tracked repos with derived structure summary.
reposRouter.get("/", (_req, res) => {
  res.json({ repos: listRepos().map(presentRepo) });
});

// POST /api/repos — track a repo (from discovery or manual entry). Validates
// token access by fetching context before persisting (PRD F1.1).
reposRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  try {
    let provider: ProviderId;
    let host: string | null;
    let path: string;

    if (typeof body.url === "string" && body.url.trim()) {
      ({ provider, host, path } = parseRepoInput(body.url));
    } else if (typeof body.path === "string" && body.path.trim()) {
      provider = (body.provider as ProviderId) ?? "github";
      host = body.host ?? null;
      path = body.path.trim();
    } else {
      res.status(400).json({ error: "Provide either `url` or `path`." });
      return;
    }

    // Validate access before saving (throws on bad token / missing repo).
    const ref: RepoRef = { provider, host, path, defaultBranch: body.default_branch ?? null };
    const ctx = await getProvider(provider, host).getRepoContext(ref, body.claude_md_path ?? null);

    const row = insertRepo({
      provider,
      host,
      path,
      description: ctx.description,
      default_branch: ctx.defaultBranch ?? body.default_branch ?? null,
      language: ctx.language,
      preview_url_pattern: body.preview_url_pattern ?? null,
      merge_method: body.merge_method ?? "squash",
      claude_md_path: body.claude_md_path ?? null,
      web_url: body.web_url ?? null,
    });
    updateRepoContext(row.id, {
      description: ctx.description,
      default_branch: ctx.defaultBranch,
      language: ctx.language,
      claude_md_cache: ctx.claudeMd,
      readme_excerpt_cache: ctx.readmeExcerpt,
      file_tree_cache: JSON.stringify(ctx.fileTree),
      automation_detected: ctx.automationDetected ? 1 : 0,
      context_refreshed_at: new Date().toISOString(),
    });
    res.status(201).json({ repo: presentRepo(getRepo(row.id)!) });
  } catch (err) {
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err) });
  }
});

// DELETE /api/repos/:id — untrack (confirmation handled in the UI, S5).
reposRouter.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!deleteRepo(id)) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }
  res.json({ ok: true });
});

// POST /api/repos/:id/refresh-context — re-fetch CLAUDE.md + tree (≤6h TTL,
// ?force=1 to bypass).
reposRouter.post("/:id/refresh-context", async (req, res) => {
  const id = Number(req.params.id);
  const row = getRepo(id);
  if (!row) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }
  try {
    const updated = await refreshContext(row, req.query.force === "1");
    res.json({ repo: presentRepo(updated) });
  } catch (err) {
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err) });
  }
});
