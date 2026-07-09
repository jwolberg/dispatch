import { Octokit } from "@octokit/rest";
import { httpStatus, isNotFound } from "../lib/errors.js";
import { autoCloseKeyword } from "./types.js";
import { findLinked } from "./linkage.js";
import type {
  Check,
  CheckState,
  CommentTarget,
  GitProvider,
  Issue,
  IssueRef,
  MergeMethod,
  MergeResult,
  PRRef,
  PRStatus,
  RateLimit,
  RepoContext,
  RepoRef,
  RepoSummary,
  Run,
  SpecInput,
} from "./types.js";

const DISPATCH_LABEL = "dispatch";

const README_MAX_LINES = 80;
const FILE_TREE_MAX_DEPTH = 2; // root + one level (PRD F1.3 "depth-2")
const FILE_TREE_MAX_ENTRIES = 400;

function mapCheckRun(status: string | null, conclusion: string | null): CheckState {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "cancelled":
    case "action_required":
    case "startup_failure":
      return "failure";
    default:
      return "neutral"; // neutral, skipped, stale, etc.
  }
}

function mapCommitStatus(state: string): CheckState {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    default:
      return "pending";
  }
}

function mapRun(status: string | null, conclusion: string | null): Run["state"] {
  if (status !== "completed") return status === "queued" ? "queued" : "in_progress";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "cancelled":
    case "startup_failure":
      return "failure";
    default:
      return "neutral";
  }
}

function splitPath(path: string): { owner: string; repo: string } {
  const [owner, repo] = path.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repo path: "${path}"`);
  return { owner, repo };
}

/**
 * GitHub adapter. The ONLY module (besides the GitLab adapter) permitted to
 * import a provider SDK. Normalizes GitHub concepts into Dispatch DTOs.
 */
export class GitHubProvider implements GitProvider {
  private readonly octokit: Octokit;

  // In-process conditional-request cache (S3). Keyed per endpoint+args; sends
  // If-None-Match and returns the cached body on a 304 — which GitHub does NOT
  // charge against the rate-limit budget. Survives across poll cycles because
  // getProvider() memoizes this provider instance.
  private readonly condCache = new Map<string, { etag: string; data: unknown }>();

  constructor(token: string, host?: string | null) {
    // Self-hosted GitHub Enterprise uses /api/v3; github.com uses the default.
    const baseUrl = host ? `${host.replace(/\/$/, "")}/api/v3` : undefined;
    this.octokit = new Octokit({ auth: token, baseUrl });
  }

  /**
   * Wrap a single GET so an unchanged resource costs no rate-limit quota. Sends
   * If-None-Match from the cached ETag; on 304 returns the cached body, on 200
   * stores the fresh ETag + body. Octokit surfaces 304 either as a response with
   * status 304 or (on some paths) a thrown error — both are handled. Errors
   * other than 304 (404, etc.) propagate so existing handlers behave unchanged.
   */
  private async cond<T>(
    key: string,
    call: (
      headers: Record<string, string>
    ) => Promise<{ status: number; headers: { etag?: string }; data: T }>
  ): Promise<T> {
    const cached = this.condCache.get(key);
    const headers: Record<string, string> = cached ? { "if-none-match": cached.etag } : {};
    try {
      const res = await call(headers);
      if (res.status === 304 && cached) return cached.data as T;
      if (res.headers.etag) this.condCache.set(key, { etag: res.headers.etag, data: res.data });
      return res.data;
    } catch (err) {
      if (httpStatus(err) === 304 && cached) return cached.data as T;
      throw err;
    }
  }

  async getRateLimit(): Promise<RateLimit> {
    const { data } = await this.octokit.rateLimit.get();
    const core = data.resources.core;
    return {
      limit: core.limit ?? null,
      remaining: core.remaining ?? null,
      reset: core.reset ? new Date(core.reset * 1000).toISOString() : null,
    };
  }

  async discoverRepos(): Promise<RepoSummary[]> {
    const repos = await this.octokit.paginate("GET /user/repos", {
      sort: "pushed",
      per_page: 100,
    });
    return repos.map((r) => ({
      provider: "github" as const,
      host: null,
      path: r.full_name,
      description: r.description ?? null,
      defaultBranch: r.default_branch ?? null,
      language: r.language ?? null,
      visibility: r.private ? "private" : "public",
      lastActivity: r.pushed_at ?? null,
      webUrl: r.html_url ?? null,
    }));
  }

  async getRepoContext(repo: RepoRef, claudeMdPath?: string | null): Promise<RepoContext> {
    const { owner, repo: name } = splitPath(repo.path);

    const { data: meta } = await this.octokit.repos.get({ owner, repo: name });
    const branch = repo.defaultBranch ?? meta.default_branch;

    const [claudeMd, readmeExcerpt, fileTree, automationDetected] = await Promise.all([
      this.fetchFileText(owner, name, claudeMdPath || "CLAUDE.md"),
      this.fetchReadmeExcerpt(owner, name),
      this.fetchFileTree(owner, name, branch),
      this.detectAutomation(owner, name),
    ]);

    return {
      description: meta.description ?? null,
      defaultBranch: meta.default_branch ?? null,
      language: meta.language ?? null,
      claudeMd,
      readmeExcerpt,
      fileTree,
      automationDetected,
    };
  }

  private async fetchFileText(
    owner: string,
    repo: string,
    path: string
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path });
      if (!Array.isArray(data) && "content" in data && data.content) {
        return Buffer.from(data.content, "base64").toString("utf8");
      }
      return null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async fetchReadmeExcerpt(owner: string, repo: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getReadme({ owner, repo });
      const text = Buffer.from(data.content, "base64").toString("utf8");
      return text.split("\n").slice(0, README_MAX_LINES).join("\n");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async fetchFileTree(owner: string, repo: string, branch: string): Promise<string[]> {
    try {
      const { data } = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: "true",
      });
      const paths = (data.tree ?? [])
        .map((node) => {
          const p = node.path ?? "";
          return node.type === "tree" ? `${p}/` : p;
        })
        .filter((p) => p && p.replace(/\/$/, "").split("/").length <= FILE_TREE_MAX_DEPTH)
        .sort();
      return paths.slice(0, FILE_TREE_MAX_ENTRIES);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  private async detectAutomation(owner: string, repo: string): Promise<boolean> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path: ".github/workflows",
      });
      if (!Array.isArray(data)) return false;
      const workflows = data.filter(
        (f) => f.type === "file" && /\.ya?ml$/.test(f.name)
      );
      // Quick win: a filename that mentions claude.
      if (workflows.some((f) => /claude/i.test(f.name))) return true;
      // Otherwise inspect contents for a claude trigger / action.
      const contents = await Promise.all(
        workflows.map((f) => this.fetchFileText(owner, repo, f.path))
      );
      return contents.some(
        (c) => c != null && /(claude-code-action|anthropics\/claude|@claude)/i.test(c)
      );
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  private async ensureLabel(owner: string, repo: string, name: string): Promise<void> {
    try {
      await this.octokit.issues.getLabel({ owner, repo, name });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      try {
        await this.octokit.issues.createLabel({ owner, repo, name, color: "5319e7" });
      } catch (e) {
        if (httpStatus(e) !== 422) throw e; // 422 = already exists (race)
      }
    }
  }

  async createIssue(repo: RepoRef, spec: SpecInput): Promise<IssueRef> {
    const { owner, repo: name } = splitPath(repo.path);
    await this.ensureLabel(owner, name, DISPATCH_LABEL);

    // The auto-close keyword is provider-specific and injected here so the core
    // never branches on provider for ship semantics (F3.1, ARCH §5).
    const keyword = autoCloseKeyword("github");
    const body =
      `${spec.body_markdown}\n\n---\n` +
      `@claude please implement this. Open a PR referencing this issue ` +
      `(use \`${keyword} #<this issue number>\` so it auto-closes on merge).`;
    const labels = Array.from(new Set([...(spec.labels ?? []), DISPATCH_LABEL]));

    const { data } = await this.octokit.issues.create({
      owner,
      repo: name,
      title: spec.title,
      body,
      labels,
    });
    return { number: data.number, url: data.html_url };
  }

  async postComment(target: CommentTarget, body: string): Promise<void> {
    // On GitHub, issue and PR conversation comments share the issues API.
    const { owner, repo } = splitPath(target.repo.path);
    await this.octokit.issues.createComment({ owner, repo, issue_number: target.number, body });
  }
  async getIssue(repo: RepoRef, issueNumber: number): Promise<Issue> {
    const { owner, repo: name } = splitPath(repo.path);
    const data = await this.cond(`issue:${owner}/${name}#${issueNumber}`, (headers) =>
      this.octokit.issues.get({ owner, repo: name, issue_number: issueNumber, headers })
    );
    // NOTE: comment pagination is left unconditional for now (paginate() doesn't
    // surface per-page ETags). Follow-up: conditional first page for ≤100 comments.
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner,
      repo: name,
      issue_number: issueNumber,
      per_page: 100,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state === "closed" ? "closed" : "open",
      labels: (data.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
      comments: comments.map((c) => ({
        id: String(c.id),
        author: c.user?.login ?? null,
        body: c.body ?? "",
        createdAt: c.created_at,
        url: c.html_url,
      })),
      url: data.html_url,
    };
  }

  async listOpenIssues(repo: RepoRef): Promise<IssueRef[]> {
    const { owner, repo: name } = splitPath(repo.path);
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      owner,
      repo: name,
      state: "open",
      per_page: 100,
    });
    // GitHub's issues API returns PRs as issues; exclude them (they carry a
    // `pull_request` field). Tickets track issues, not PRs.
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, url: i.html_url }));
  }

  async findLinkedPR(repo: RepoRef, issueNumber: number): Promise<PRRef | null> {
    const { owner, repo: name } = splitPath(repo.path);
    const prs = await this.cond(`pulls.list:${owner}/${name}`, (headers) =>
      this.octokit.pulls.list({
        owner,
        repo: name,
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: 50,
        headers,
      })
    );
    // F4.4: linked if the PR body references #<n> or its branch name contains
    // the issue number. Rule lives in ./linkage.ts (shared with the GitLab adapter).
    const match = findLinked(issueNumber, prs, (pr) => ({
      body: pr.body,
      branch: pr.head.ref,
    }));
    if (!match) return null;
    return {
      number: match.number,
      url: match.html_url,
      headBranch: match.head.ref,
      baseBranch: match.base.ref,
    };
  }

  async getPRStatus(repo: RepoRef, prNumber: number): Promise<PRStatus> {
    const { owner, repo: name } = splitPath(repo.path);
    const pr = await this.cond(`pull:${owner}/${name}#${prNumber}`, (headers) =>
      this.octokit.pulls.get({ owner, repo: name, pull_number: prNumber, headers })
    );
    const [checks, previewUrl] = await Promise.all([
      this.collectChecks(owner, name, pr.head.sha),
      this.findPreviewUrl(owner, name, pr.head.sha, pr.head.ref),
    ]);
    const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    return {
      number: pr.number,
      title: pr.title,
      state,
      merged: Boolean(pr.merged),
      mergeable: pr.mergeable,
      draft: Boolean(pr.draft),
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      url: pr.html_url,
      checks,
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
      changedFiles: pr.changed_files ?? null,
      previewUrl,
    };
  }

  /**
   * Prefer a live preview URL over the configured pattern (F5.2): a deploy-ish
   * commit status target, else a deployment status environment URL. (Free-text
   * bot-comment scraping is intentionally skipped to bound API calls — Vercel/
   * Netlify post deployment statuses, which this reads.)
   */
  private async findPreviewUrl(
    owner: string,
    repo: string,
    sha: string,
    branch: string
  ): Promise<string | null> {
    try {
      // Same cache key as collectChecks' combined-status fetch — one ETag covers both.
      const data = await this.cond(`combined:${owner}/${repo}@${sha}`, (headers) =>
        this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha, headers })
      );
      const s = data.statuses.find(
        (s) => /vercel|netlify|preview|deploy|render|surge|pages/i.test(s.context) && s.target_url
      );
      if (s?.target_url) return s.target_url;
    } catch (err) {
      // Deployments/statuses 403 on fine-grained PATs lacking that permission;
      // preview discovery is best-effort, so treat 403/404 as "no preview".
      if (httpStatus(err) !== 403 && !isNotFound(err)) throw err;
    }
    try {
      const deployments = await this.cond(`deployments:${owner}/${repo}@${branch}`, (headers) =>
        this.octokit.repos.listDeployments({ owner, repo, ref: branch, per_page: 5, headers })
      );
      for (const d of deployments) {
        const statuses = await this.cond(`depstatus:${owner}/${repo}#${d.id}`, (headers) =>
          this.octokit.repos.listDeploymentStatuses({
            owner,
            repo,
            deployment_id: d.id,
            per_page: 5,
            headers,
          })
        );
        const st = statuses.find((s) => s.environment_url || s.target_url);
        if (st) return st.environment_url || st.target_url || null;
      }
    } catch (err) {
      // Deployments/statuses 403 on fine-grained PATs lacking that permission;
      // preview discovery is best-effort, so treat 403/404 as "no preview".
      if (httpStatus(err) !== 403 && !isNotFound(err)) throw err;
    }
    return null;
  }

  private async collectChecks(owner: string, repo: string, sha: string): Promise<Check[]> {
    const [runs, combined] = await Promise.all([
      this.cond(`checkruns:${owner}/${repo}@${sha}`, (headers) =>
        this.octokit.checks.listForRef({ owner, repo, ref: sha, per_page: 100, headers })
      ).catch((e) => {
        // Fine-grained PATs cannot be granted the Checks permission, so this
        // endpoint 403s on them. Degrade to commit statuses (+ the workflow-run
        // signal read separately) instead of failing the whole reconcile.
        if (httpStatus(e) === 403 || isNotFound(e)) return null;
        throw e;
      }),
      this.cond(`combined:${owner}/${repo}@${sha}`, (headers) =>
        this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha, headers })
      ).catch((e) => {
        if (isNotFound(e)) return null;
        throw e;
      }),
    ]);
    const fromRuns: Check[] = (runs?.check_runs ?? []).map((r) => ({
      name: r.name,
      state: mapCheckRun(r.status, r.conclusion),
      url: r.html_url ?? null,
    }));
    const fromStatuses: Check[] = (combined?.statuses ?? []).map((s) => ({
      name: s.context,
      state: mapCommitStatus(s.state),
      url: s.target_url ?? null,
    }));
    return [...fromRuns, ...fromStatuses];
  }

  async getWorkflowRuns(repo: RepoRef, ref: string): Promise<Run[]> {
    const { owner, repo: name } = splitPath(repo.path);
    // Repo-wide list (filtered by ref client-side below), so one ETag per repo
    // serves every ticket's call this cycle.
    const data = await this.cond(`runs:${owner}/${name}`, (headers) =>
      this.octokit.actions.listWorkflowRunsForRepo({ owner, repo: name, per_page: 30, headers })
    );
    return data.workflow_runs
      .filter((r) => r.head_branch === ref || r.head_sha === ref)
      .map((r) => ({
        id: String(r.id),
        name: r.name ?? r.display_title ?? "workflow",
        event: r.event ?? null,
        title: r.display_title ?? null,
        state: mapRun(r.status, r.conclusion),
        url: r.html_url ?? null,
        createdAt: r.created_at,
      }));
  }
  async mergePR(repo: RepoRef, prNumber: number, method: MergeMethod): Promise<MergeResult> {
    const { owner, repo: name } = splitPath(repo.path);
    // Errors (conflicts, branch protection) propagate so the route can surface
    // the provider message verbatim with a PR link (F6.4).
    const { data } = await this.octokit.pulls.merge({
      owner,
      repo: name,
      pull_number: prNumber,
      merge_method: method,
    });
    return { merged: Boolean(data.merged), message: data.message ?? null, sha: data.sha ?? null };
  }
}
