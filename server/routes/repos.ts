import { Router } from "express";
import {
  listRepos,
  getRepo,
  insertRepo,
  deleteRepo,
  updateRepoContext,
  findRepoByIdentity,
  type RepoRow,
} from "../db/repos.js";
import { getProviderForRepo } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import { discoverTickets } from "../poller/discover.js";
import { safeMessage, registerSecret, unregisterSecret } from "../lib/redaction.js";
import { httpStatus } from "../lib/errors.js";
import { detectStack, templatesFor, SECRET_NAME, type AuthMode } from "../setup/templates.js";
import { appBotLogin } from "../db/installations.js";

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
    canary_verdict: row.canary_verdict,
    canary_reason: row.canary_reason,
    canary_checked_at: row.canary_checked_at,
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

  const ref = refToRow(row);
  const ctx = await getProviderForRepo(ref).getRepoContext(ref, row.claude_md_path);
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
    const ctx = await getProviderForRepo(ref).getRepoContext(ref, body.claude_md_path ?? null);

    // Tracking an already-tracked repo is a no-op, not a second row (#23). The
    // recheck after a constraint failure closes the race between two submits
    // that both miss the first lookup.
    let existing = findRepoByIdentity(provider, host, path);
    let row: RepoRow;
    if (existing) {
      row = existing;
    } else {
      try {
        row = insertRepo({
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
      } catch (err) {
        existing = findRepoByIdentity(provider, host, path);
        if (!existing) throw err; // a real failure, not the identity index
        row = existing;
      }
    }

    // Refresh the cache on both paths — a re-track is how an operator asks for
    // fresh context, and we have just paid for it.
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
    // Adopt the repo's existing open issues onto the board (best-effort — a
    // discovery failure must not fail the track itself; the poller retries).
    try {
      await discoverTickets(getRepo(row.id)!);
    } catch (err) {
      console.warn(`[repos] issue import failed for ${path}: ${safeMessage(err)}`);
    }
    res.status(existing ? 200 : 201).json({ repo: presentRepo(getRepo(row.id)!) });
  } catch (err) {
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err) });
  }
});

/**
 * POST /api/repos/:id/setup — onboard a repo from the browser (#4, T1-3).
 *
 * Commits `claude.yml`, a stack-aware `ci.yml`, and the three skills, then writes
 * **exactly one secret**: the Claude auth token. No GitHub credential of any kind is
 * written into the target repo — not a `GH_PAT`, not the App's private key. That is
 * ADR-0006 [2]'s whole point: an App credential in every onboarded repo would invert
 * the blast radius.
 *
 * The token arrives in the request body, is registered with the redactor for the
 * duration of the call, and is never logged or echoed back (AC 13).
 */
reposRouter.post("/:id/setup", async (req, res) => {
  const repo = getRepo(Number(req.params.id));
  if (!repo) {
    res.status(404).json({ error: "Repo not found." });
    return;
  }

  const body = req.body ?? {};
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    res.status(400).json({ error: "A Claude auth token is required." });
    return;
  }
  const mode: AuthMode = body.mode === "apikey" ? "apikey" : "oauth";

  const ref = refToRow(repo);
  const setup = getProviderForRepo(ref).automationSetup(ref);
  if (!setup) {
    // GitLab. `claude-code-action` is GitHub-only; its automation is a job in
    // `.gitlab-ci.yml` that Dispatch does not write.
    res.status(501).json({ error: `Automation setup is not supported on ${ref.provider}.` });
    return;
  }

  registerSecret(token);
  try {
    const stack = detectStack(JSON.parse(repo.file_tree_cache ?? "[]") as string[]);
    // When this deployment has registered an App, issues it files are authored by
    // the App bot, which claude-code-action rejects unless allow-listed (#29). Stamp
    // the bot login into claude.yml; null (PAT-only) omits the input.
    const files: { path: string; committed: boolean; commitUrl: string | null }[] = [];
    // Serial, not parallel: each write is a commit on the same branch, and
    // concurrent createOrUpdateFileContents calls race on the branch tip and 409.
    for (const t of templatesFor(mode, stack, appBotLogin())) {
      const result = await setup.putFile({
        path: t.path,
        content: t.content,
        message: t.message,
        createOnly: t.createOnly,
      });
      files.push({ path: t.path, committed: result.committed, commitUrl: result.commitUrl });
    }

    await setup.setSecret(SECRET_NAME[mode], token);

    // The API key outranks the OAuth token in Claude's auth precedence, so a
    // leftover one silently keeps billing the metered API (AC 5).
    const deleted: string[] = [];
    if (mode === "oauth" && (await setup.deleteSecret("ANTHROPIC_API_KEY"))) {
      deleted.push("ANTHROPIC_API_KEY");
    }

    // The card's ⚠ flag reads `automation_detected`, which is still the value cached
    // when the repo was tracked. Setup just committed `claude.yml`, so re-read the
    // context — otherwise a successful setup leaves the warning on screen and the
    // operator has no way to know it worked.
    const ctx = await getProviderForRepo(ref).getRepoContext(ref, repo.claude_md_path);
    updateRepoContext(repo.id, {
      description: ctx.description,
      default_branch: ctx.defaultBranch,
      language: ctx.language,
      claude_md_cache: ctx.claudeMd,
      readme_excerpt_cache: ctx.readmeExcerpt,
      file_tree_cache: JSON.stringify(ctx.fileTree),
      automation_detected: ctx.automationDetected ? 1 : 0,
      context_refreshed_at: new Date().toISOString(),
    });

    res.json({
      repo: presentRepo(getRepo(repo.id)!),
      stack,
      files,
      // Names only. Never a value.
      secrets: { set: [SECRET_NAME[mode]], deleted },
    });
  } catch (err) {
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err) });
  } finally {
    unregisterSecret(token);
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
