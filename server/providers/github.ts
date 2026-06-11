import { Octokit } from "@octokit/rest";
import { httpStatus, isNotFound } from "../lib/errors.js";
import { autoCloseKeyword } from "./types.js";
import type {
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

  constructor(token: string, host?: string | null) {
    // Self-hosted GitHub Enterprise uses /api/v3; github.com uses the default.
    const baseUrl = host ? `${host.replace(/\/$/, "")}/api/v3` : undefined;
    this.octokit = new Octokit({ auth: token, baseUrl });
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

  // ── Methods below are implemented in their own tickets (P3-T1/T2, P4-T1/T3).
  //    Stubbed here so the class satisfies the GitProvider interface.

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
  async getIssue(_repo: RepoRef, _issueNumber: number): Promise<Issue> {
    throw new Error("getIssue not yet implemented (P3-T2)");
  }
  async findLinkedPR(_repo: RepoRef, _issueNumber: number): Promise<PRRef | null> {
    throw new Error("findLinkedPR not yet implemented (P3-T2)");
  }
  async getPRStatus(_repo: RepoRef, _prNumber: number): Promise<PRStatus> {
    throw new Error("getPRStatus not yet implemented (P3-T2)");
  }
  async getWorkflowRuns(_repo: RepoRef, _ref: string): Promise<Run[]> {
    throw new Error("getWorkflowRuns not yet implemented (P3-T2)");
  }
  async mergePR(_repo: RepoRef, _prNumber: number, _method: MergeMethod): Promise<MergeResult> {
    throw new Error("mergePR not yet implemented (P4-T3)");
  }
}
