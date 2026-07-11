import { Octokit } from "@octokit/rest";
import { httpStatus, isNotFound } from "../lib/errors.js";
import { findLinked, findRevert } from "./linkage.js";
import { CondCache, type CondCacheStore } from "./cond-cache.js";
import type { TokenSource } from "./token-source.js";
import { DIFF_MAX_FILES, mapGitHubFile } from "./diff.js";
import { issueBody } from "./prompt.js";
import { sealSecret } from "./sealed-box.js";
import { registerSecret, unregisterSecret } from "../lib/redaction.js";
import type {
  RepoAutomationSetup,
  PutFileResult,
  PutFileInput,
  NewPullRequest,
  CommitIdentity,
  BranchRef,
  Check,
  CheckState,
  CommentTarget,
  GitProvider,
  Issue,
  IssueRef,
  MergeMethod,
  MergeResult,
  PRDiff,
  PRRef,
  PRStatus,
  RateLimit,
  RevertRef,
  RepoContext,
  RepoRef,
  RepoSummary,
  Run,
  RawWorkflowRun,
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
/**
 * Which question `discoverRepos()` is allowed to ask (#21).
 *
 * `user` — a PAT: `GET /user/repos`, every repo the *user* can reach.
 * `installation` — a GitHub App token: `GET /installation/repositories`, only the
 * repos that installation was granted. `/user/repos` returns 403 for it, and the
 * installation endpoint does not exist for a PAT, so this is not a preference —
 * it is which endpoint is legal for the credential the adapter holds.
 *
 * Set by the factory, which knows the credential. Callers never pass it.
 */
export type RepoScope = "user" | "installation";

export class GitHubProvider implements GitProvider {
  private readonly octokit: Octokit;

  // Conditional-request cache (S3). Keyed per endpoint+args; sends If-None-Match
  // and replays the cached body on a 304 — which GitHub does NOT charge against
  // the rate-limit budget. Survives poll cycles because getProvider() memoizes
  // this instance, and survives process restarts when a store is supplied.
  private readonly conds: CondCache;

  constructor(
    tokens: TokenSource,
    host?: string | null,
    condStore?: CondCacheStore,
    private readonly scope: RepoScope = "user"
  ) {
    // Self-hosted GitHub Enterprise uses /api/v3; github.com uses the default.
    const baseUrl = host ? `${host.replace(/\/$/, "")}/api/v3` : undefined;
    this.octokit = new Octokit({ baseUrl });
    this.conds = new CondCache(condStore);

    // Auth is resolved per request, not at construction (#3). An App installation
    // token expires hourly, and this adapter is memoized for the life of the
    // process — baking the token into the Octokit instance would pin a credential
    // that goes stale an hour later. `EnvTokenSource.get()` is a constant, so the
    // PAT path pays nothing for this.
    //
    // Auth and the 401 retry live in ONE wrap rather than a `before` hook plus a
    // wrap, because the retry has to know *which* token it just failed with.
    this.octokit.hook.wrap("request", async (request, options) => {
      const used = await tokens.get();
      options.headers.authorization = `token ${used}`;

      try {
        return await request(options);
      } catch (err) {
        // A 401 means the token died before its stated expiry — revoked, or the
        // installation removed and re-added. Re-mint once and retry; a second 401
        // is a real credential failure and must surface rather than loop.
        if (httpStatus(err) !== 401) throw err;

        // Naming the failed token matters: concurrent requests sharing this
        // memoized adapter all 401 on the same dead token, and only the first
        // may discard it. The rest are no-ops and reuse the fresh one.
        tokens.invalidate(used);
        options.headers.authorization = `token ${await tokens.get()}`;
        return request(options);
      }
    });
  }

  /** Wrap a single GET so an unchanged resource costs no rate-limit quota. */
  private cond<T>(
    key: string,
    call: (
      headers: Record<string, string>
    ) => Promise<{ status: number; headers: { etag?: string }; data: T }>
  ): Promise<T> {
    return this.conds.run(key, call);
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

  /**
   * Every repo this adapter's credential can reach.
   *
   * Two endpoints, chosen by {@link RepoScope}, because a PAT and an installation
   * token cannot ask each other's question. `/installation/repositories` wraps its
   * results in a `repositories` envelope rather than returning a bare array;
   * Octokit's paginator unwraps it, so both branches yield the same row shape.
   */
  async discoverRepos(): Promise<RepoSummary[]> {
    const repos =
      this.scope === "installation"
        ? await this.octokit.paginate("GET /installation/repositories", { per_page: 100 })
        : await this.octokit.paginate("GET /user/repos", { sort: "pushed", per_page: 100 });

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

    // The instruction — including the provider-specific auto-close keyword — is one
    // shared string, so the two adapters cannot drift (F3.1, ARCH §5). ADR-0006 [2]:
    // it must not ask Claude to open the PR; Dispatch does that.
    const body = issueBody("github", spec.body_markdown);
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

  async closeIssue(repo: RepoRef, issueNumber: number): Promise<void> {
    const { owner, repo: name } = splitPath(repo.path);
    await this.octokit.issues.update({ owner, repo: name, issue_number: issueNumber, state: "closed" });
  }

  async deleteBranch(repo: RepoRef, branch: string): Promise<void> {
    const { owner, repo: name } = splitPath(repo.path);
    try {
      await this.octokit.git.deleteRef({ owner, repo: name, ref: `heads/${branch}` });
    } catch (err) {
      // 422/404 = the ref is already gone (or the canary never made one). Cleanup
      // is idempotent by contract; only a real error propagates.
      if (isNotFound(err) || httpStatus(err) === 422) return;
      throw err;
    }
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

  /** Recent PRs, newest first. Shared by findLinkedPR and findRevertPR (one ETag'd call). */
  private async recentPulls(owner: string, name: string) {
    return this.cond(`pulls.list:${owner}/${name}`, (headers) =>
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
  }

  async findLinkedPR(repo: RepoRef, issueNumber: number): Promise<PRRef | null> {
    const { owner, repo: name } = splitPath(repo.path);
    const prs = await this.recentPulls(owner, name);
    // F4.4: linked if the PR body references #<n> or its branch name contains
    // the issue number. Rule lives in ./linkage.ts (shared with the GitLab adapter).
    // findLinked skips reverts — see ADR-0004 [5].
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

  async findRevertPR(repo: RepoRef, prNumber: number): Promise<RevertRef | null> {
    const { owner, repo: name } = splitPath(repo.path);
    const prs = await this.recentPulls(owner, name);
    const match = findRevert(prNumber, prs, (pr) => ({ body: pr.body, branch: pr.head.ref }));
    if (!match) return null;
    return {
      number: match.number,
      url: match.html_url,
      state: match.merged_at ? "merged" : match.state === "closed" ? "closed" : "open",
    };
  }

  /**
   * `PullRequest.revertUrl` is a first-class GraphQL field, so the deep-link is
   * derived rather than string-built (ADR-0004 [2]). One query, on click.
   * `@octokit/graphql` ships with `@octokit/rest` — no new dependency.
   */
  async getRevertUrl(repo: RepoRef, prNumber: number): Promise<string> {
    const { owner, repo: name } = splitPath(repo.path);
    const data = await this.octokit.graphql<{
      repository: { pullRequest: { revertUrl: string } | null } | null;
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
         repository(owner: $owner, name: $name) {
           pullRequest(number: $number) { revertUrl }
         }
       }`,
      { owner, name, number: prNumber }
    );
    const url = data.repository?.pullRequest?.revertUrl;
    if (!url) throw new Error(`No revert url for PR #${prNumber}`);
    return url;
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
      headSha: pr.head.sha,
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
   * Changed files + patches for one PR (T1-5).
   *
   * A single page, deliberately. GitHub caps a page at 100 files and the whole
   * endpoint at 3000; paginating a 400-file PR would spend rate-limit quota to
   * fetch patches the caller is about to truncate anyway. A full page means
   * "there may be more", which is what `truncated` says.
   *
   * Goes through the conditional-request cache, so re-reading an unchanged PR's
   * diff costs no quota.
   */
  async getPRDiff(repo: RepoRef, prNumber: number): Promise<PRDiff> {
    const { owner, repo: name } = splitPath(repo.path);
    const files = await this.cond(`prfiles:${owner}/${name}#${prNumber}`, (headers) =>
      this.octokit.pulls.listFiles({
        owner,
        repo: name,
        pull_number: prNumber,
        per_page: DIFF_MAX_FILES,
        headers,
      })
    );
    return {
      files: files.map(mapGitHubFile),
      truncated: files.length >= DIFF_MAX_FILES,
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
  async getWorkflowRunsRaw(repo: RepoRef, ref: string): Promise<RawWorkflowRun[]> {
    const { owner, repo: name } = splitPath(repo.path);
    // Not conditional/ETag-cached: the canary is a one-shot bounded poll, and a
    // cached body would hide the status transition it is watching for.
    const { data } = await this.octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo: name,
      per_page: 30,
    });
    return data.workflow_runs
      .filter((r) => r.head_branch === ref || r.head_sha === ref)
      .map((r) => ({
        id: String(r.id),
        status: r.status ?? null,
        conclusion: r.conclusion ?? null,
        headBranch: r.head_branch ?? null,
        event: r.event ?? null,
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

  async listBranches(repo: RepoRef): Promise<BranchRef[]> {
    const { owner, repo: name } = splitPath(repo.path);
    const branches = await this.octokit.paginate("GET /repos/{owner}/{repo}/branches", {
      owner,
      repo: name,
      per_page: 100,
    });
    return branches.map((b) => ({ name: b.name, sha: b.commit.sha }));
  }

  /**
   * `author` is the account GitHub resolved from the commit's *email*, and is null
   * when no account matches. `commit.author.name` is whatever the git client wrote.
   * They disagree for Claude — see `poller/__fixtures__/README.md` — so both are
   * returned and neither is collapsed into the other.
   */
  async getCommitIdentity(repo: RepoRef, sha: string): Promise<CommitIdentity> {
    const { owner, repo: name } = splitPath(repo.path);
    const { data } = await this.octokit.repos.getCommit({ owner, repo: name, ref: sha });
    const type = data.author?.type;
    return {
      authorName: data.commit.author?.name ?? null,
      authorLogin: data.author?.login ?? null,
      authorType: type === "Bot" || type === "User" ? type : null,
    };
  }

  async createPullRequest(repo: RepoRef, input: NewPullRequest): Promise<PRRef> {
    const { owner, repo: name } = splitPath(repo.path);
    const { data } = await this.octokit.pulls.create({
      owner,
      repo: name,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return {
      number: data.number,
      url: data.html_url,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
    };
  }

  /**
   * Onboarding writes (#4). Bound to one repo so the caller never re-supplies it,
   * and so `null` from the GitLab adapter is a compile-time fact rather than a
   * runtime surprise.
   */
  automationSetup(repo: RepoRef): RepoAutomationSetup {
    const { owner, repo: name } = splitPath(repo.path);
    const branch = repo.defaultBranch ?? undefined;
    const octokit = this.octokit;

    return {
      putFile: async (input: PutFileInput): Promise<PutFileResult> => {
        // Re-running setup must not append a commit to the operator's history on
        // every click (AC 10). Compare content, not just existence.
        let sha: string | undefined;
        try {
          const { data } = await octokit.repos.getContent({
            owner,
            repo: name,
            path: input.path,
            ref: input.branch ?? branch,
          });
          if (!Array.isArray(data) && data.type === "file") {
            // `createOnly` guards a file whose content we do not own (ci.yml): it
            // exists, so leave it exactly as the operator wrote it.
            if (input.createOnly) return { committed: false, commitUrl: null };
            sha = data.sha;
            const current = Buffer.from(data.content, "base64").toString("utf8");
            if (current === input.content) return { committed: false, commitUrl: null };
          }
        } catch (err) {
          if (!isNotFound(err)) throw err; // absent is the create path
        }

        const { data } = await octokit.repos.createOrUpdateFileContents({
          owner,
          repo: name,
          path: input.path,
          message: input.message,
          content: Buffer.from(input.content, "utf8").toString("base64"),
          branch: input.branch ?? branch,
          ...(sha ? { sha } : {}), // omit on create; required on update or GitHub 409s
        });
        return { committed: true, commitUrl: data.commit?.html_url ?? null };
      },

      setSecret: async (secretName: string, value: string): Promise<void> => {
        // The plaintext must never reach a log line, an error message, or GitHub's
        // request body (AC 4, AC 13). Registering it makes `safeMessage()` redact it
        // even if some transport error stringifies the request.
        registerSecret(value);
        try {
          const { data: key } = await octokit.actions.getRepoPublicKey({ owner, repo: name });
          await octokit.actions.createOrUpdateRepoSecret({
            owner,
            repo: name,
            secret_name: secretName,
            key_id: key.key_id,
            encrypted_value: await sealSecret(key.key, value),
          });
        } finally {
          unregisterSecret(value);
        }
      },

      deleteSecret: async (secretName: string): Promise<boolean> => {
        try {
          await octokit.actions.deleteRepoSecret({ owner, repo: name, secret_name: secretName });
          return true;
        } catch (err) {
          if (isNotFound(err)) return false; // nothing to remove is success, not failure
          throw err;
        }
      },
    };
  }
}
