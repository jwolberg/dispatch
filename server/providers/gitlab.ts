import { Gitlab } from "@gitbeaker/rest";
import { httpStatus, isNotFound } from "../lib/errors.js";
import { findLinked, findRevertOfCommit } from "./linkage.js";
import { DIFF_MAX_FILES, mapGitLabDiff, type RawGitLabDiff } from "./diff.js";
import { issueBody } from "./prompt.js";
import type {
  RepoAutomationSetup,
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
  RepoContext,
  RepoRef,
  RepoSummary,
  RevertRef,
  Run,
  RawWorkflowRun,
  RunTiming,
  SpecInput,
} from "./types.js";

const README_MAX_LINES = 80;
const FILE_TREE_MAX_DEPTH = 2;
const FILE_TREE_MAX_ENTRIES = 400;
const DISPATCH_LABEL = "dispatch";

type GitlabClient = InstanceType<typeof Gitlab>;
// GitLab schemas extend Record<string, unknown>; read fields through a loose
// view at this SDK boundary while the public methods stay strongly typed.
type Loose = Record<string, any>;

function mapStatus(status: string): CheckState {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "running":
    case "pending":
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
      return "pending";
    default:
      return "neutral"; // canceled, skipped, manual, etc.
  }
}

function mapRun(status: string): Run["state"] {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "created":
    case "pending":
    case "waiting_for_resource":
    case "scheduled":
      return "queued";
    case "running":
    case "preparing":
      return "in_progress";
    default:
      return "neutral";
  }
}

/**
 * GitLab adapter. Like the GitHub adapter, the only place its SDK is imported.
 * Normalizes GitLab concepts (MR=PR, pipeline=run, job=check, Closes keyword).
 */
export class GitLabProvider implements GitProvider {
  private readonly api: GitlabClient;

  constructor(token: string, host?: string | null) {
    this.api = new Gitlab({ token, host: host || "https://gitlab.com" });
  }

  async getRateLimit(): Promise<RateLimit> {
    // GitLab has no rate-limit query endpoint; Metadata.show validates the token.
    await this.api.Metadata.show();
    return { limit: null, remaining: null, reset: null };
  }

  async discoverRepos(): Promise<RepoSummary[]> {
    const projects = (await this.api.Projects.all({ membership: true, perPage: 100 })) as Loose[];
    projects.sort((a, b) =>
      String(b.last_activity_at ?? "").localeCompare(String(a.last_activity_at ?? ""))
    );
    return projects.map((p) => ({
      provider: "gitlab" as const,
      host: null,
      path: p.path_with_namespace,
      description: p.description ?? null,
      defaultBranch: p.default_branch ?? null,
      language: null, // not in the list payload; omitted to avoid N extra calls
      visibility: p.visibility ?? null,
      lastActivity: p.last_activity_at ?? null,
      webUrl: p.web_url ?? null,
    }));
  }

  async getRepoContext(repo: RepoRef, claudeMdPath?: string | null): Promise<RepoContext> {
    const id = repo.path;
    const meta = (await this.api.Projects.show(id)) as Loose;
    const branch = repo.defaultBranch ?? meta.default_branch ?? "main";

    const [claudeMd, readmeExcerpt, fileTree, automationDetected] = await Promise.all([
      this.fetchFile(id, claudeMdPath || "CLAUDE.md", branch),
      this.fetchReadme(id, branch),
      this.fetchTree(id, branch),
      this.detectAutomation(id, branch),
    ]);

    return {
      description: meta.description ?? null,
      defaultBranch: meta.default_branch ?? null,
      language: null,
      claudeMd,
      readmeExcerpt,
      fileTree,
      automationDetected,
    };
  }

  async readFile(repo: RepoRef, path: string, ref?: string): Promise<string | null> {
    const at = ref ?? repo.defaultBranch ?? "main";
    const text = await this.fetchFile(repo.path, path, at);
    if (text === null) return null;
    // A NUL byte means it is not decodable text (binary) — return null like a miss.
    return text.includes("\u0000") ? null : text;
  }

  async listFiles(repo: RepoRef, path: string, ref?: string): Promise<string[]> {
    const at = ref ?? repo.defaultBranch ?? "main";
    try {
      const entries = (await this.api.Repositories.allRepositoryTrees(repo.path, {
        path,
        ref: at,
      })) as Loose[];
      return entries.map((e) => String(e.name));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  private async fetchFile(id: string, path: string, ref: string): Promise<string | null> {
    try {
      return (await this.api.RepositoryFiles.showRaw(id, path, ref)) as string;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async fetchReadme(id: string, ref: string): Promise<string | null> {
    for (const name of ["README.md", "README"]) {
      const text = await this.fetchFile(id, name, ref);
      if (text != null) return text.split("\n").slice(0, README_MAX_LINES).join("\n");
    }
    return null;
  }

  private async fetchTree(id: string, ref: string): Promise<string[]> {
    try {
      const entries = (await this.api.Repositories.allRepositoryTrees(id, {
        recursive: true,
        ref,
      })) as Loose[];
      return entries
        .map((e) => (e.type === "tree" ? `${e.path}/` : String(e.path)))
        .filter((p) => p && p.replace(/\/$/, "").split("/").length <= FILE_TREE_MAX_DEPTH)
        .sort()
        .slice(0, FILE_TREE_MAX_ENTRIES);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  private async detectAutomation(id: string, ref: string): Promise<boolean> {
    const ci = await this.fetchFile(id, ".gitlab-ci.yml", ref);
    return ci != null && /(claude|anthropics)/i.test(ci);
  }

  async createIssue(repo: RepoRef, spec: SpecInput): Promise<IssueRef> {
    // Shared with the GitHub adapter so the wording cannot drift; it carries
    // GitLab's "Closes" keyword and "merge request" vocabulary. ADR-0006 [2]:
    // Dispatch opens the merge request, not the pipeline.
    const description = issueBody("gitlab", spec.body_markdown);
    // GitLab creates labels on the fly when applied to an issue.
    const labels = Array.from(new Set([...(spec.labels ?? []), DISPATCH_LABEL])).join(",");
    const issue = (await this.api.Issues.create(repo.path, spec.title, {
      description,
      labels,
    })) as Loose;
    return { number: issue.iid, url: issue.web_url };
  }

  async postComment(target: CommentTarget, body: string): Promise<void> {
    if (target.kind === "pr") {
      await this.api.MergeRequestNotes.create(target.repo.path, target.number, body);
    } else {
      await this.api.IssueNotes.create(target.repo.path, target.number, body);
    }
  }

  async getIssue(repo: RepoRef, issueNumber: number): Promise<Issue> {
    const issue = (await this.api.Issues.show(issueNumber, { projectId: repo.path })) as Loose;
    const notes = (await this.api.IssueNotes.all(repo.path, issueNumber)) as Loose[];
    return {
      number: issue.iid,
      title: issue.title,
      body: issue.description ?? "",
      state: issue.state === "closed" ? "closed" : "open",
      labels: Array.isArray(issue.labels) ? issue.labels : [],
      comments: notes
        .filter((n) => !n.system)
        .map((n) => ({
          id: String(n.id),
          author: n.author?.username ?? null,
          body: n.body ?? "",
          createdAt: n.created_at,
          url: null,
        })),
      url: issue.web_url,
    };
  }

  async closeIssue(repo: RepoRef, issueNumber: number): Promise<void> {
    await this.api.Issues.edit(repo.path, issueNumber, { stateEvent: "close" });
  }

  async deleteBranch(repo: RepoRef, branch: string): Promise<void> {
    try {
      await this.api.Branches.remove(repo.path, branch);
    } catch (err) {
      // Idempotent cleanup: a branch that never existed is not an error.
      if (isNotFound(err) || httpStatus(err) === 422) return;
      throw err;
    }
  }

  async listOpenIssues(repo: RepoRef): Promise<IssueRef[]> {
    // MRs are a separate resource in GitLab, so this returns issues only.
    const issues = (await this.api.Issues.all({
      projectId: repo.path,
      state: "opened",
      perPage: 100,
    })) as Loose[];
    return issues.map((i) => ({ number: i.iid, url: i.web_url }));
  }

  /** Recent MRs, newest first. Shared by findLinkedPR and findRevertPR. */
  private async recentMRs(repo: RepoRef): Promise<Loose[]> {
    return (await this.api.MergeRequests.all({
      projectId: repo.path,
      orderBy: "updated_at",
      perPage: 50,
    })) as Loose[];
  }

  async findLinkedPR(repo: RepoRef, issueNumber: number): Promise<PRRef | null> {
    const mrs = await this.recentMRs(repo);
    // F4.4 — same rule as the GitHub adapter, shared via ./linkage.ts.
    // findLinked skips reverts — see ADR-0004 [5].
    const match = findLinked(issueNumber, mrs, (mr) => ({
      body: mr.description,
      branch: mr.source_branch,
    }));
    if (!match) return null;
    return {
      number: match.iid,
      url: match.web_url,
      headBranch: match.source_branch,
      baseBranch: match.target_branch,
    };
  }

  /**
   * GitLab reverts a *commit*, not a merge request — `api/v4` has no MR-level
   * revert (ADR-0003 [2]). So the revert MR never cites the original MR's iid;
   * it cites the sha it undid. Attribution runs through that sha.
   *
   * `squash_commit_sha` when the project squashes on merge, else
   * `merge_commit_sha`. Reading only the latter would silently find nothing on
   * every squash-merging project.
   */
  async findRevertPR(repo: RepoRef, prNumber: number): Promise<RevertRef | null> {
    const mr = (await this.api.MergeRequests.show(repo.path, prNumber)) as Loose;
    const sha = (mr.squash_commit_sha ?? mr.merge_commit_sha) as string | null | undefined;
    if (!sha) return null; // not merged, so nothing to revert

    const mrs = await this.recentMRs(repo);
    const match = findRevertOfCommit(
      sha,
      mrs.filter((m) => m.iid !== prNumber),
      (m) => ({ body: m.description, branch: m.source_branch })
    );
    if (!match) return null;
    return {
      number: match.iid,
      url: match.web_url,
      state: match.state === "merged" ? "merged" : match.state === "closed" ? "closed" : "open",
    };
  }

  /**
   * GitLab has no revert *page*. `api/v4` exposes a commit-level revert endpoint
   * that writes straight to a branch (ADR-0003 [2]), and the MR page's Revert
   * button is a Rails action with no addressable GET route. So the honest
   * deep-link is the MR itself, where that button lives.
   *
   * This is strictly worse than GitHub's dedicated revert page, and ADR-0004 [4]
   * accepts it as the cost of Dispatch never writing to a user's repository.
   */
  async getRevertUrl(repo: RepoRef, prNumber: number): Promise<string> {
    const mr = (await this.api.MergeRequests.show(repo.path, prNumber)) as Loose;
    const url = mr.web_url as string | undefined;
    if (!url) throw new Error(`No web url for MR !${prNumber}`);
    return url;
  }

  async getPRStatus(repo: RepoRef, prNumber: number): Promise<PRStatus> {
    const mr = (await this.api.MergeRequests.show(repo.path, prNumber)) as Loose;
    const checks = await this.collectChecks(repo.path, mr);
    const state = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open";
    return {
      number: mr.iid,
      title: mr.title,
      state,
      merged: mr.state === "merged",
      mergeable: mr.merge_status ? mr.merge_status === "can_be_merged" : null,
      draft: Boolean(mr.draft ?? mr.work_in_progress),
      headBranch: mr.source_branch,
      // `diff_refs.head_sha` is the commit the current diff is against; `sha` is
      // GitLab's older name for the same thing and is always present.
      headSha: mr.diff_refs?.head_sha ?? mr.sha ?? "",
      baseBranch: mr.target_branch,
      url: mr.web_url,
      checks,
      additions: null,
      deletions: null,
      changedFiles: null,
      previewUrl: null,
    };
  }

  /**
   * Changed files + patches for one MR (T1-5). One page, same reasoning as the
   * GitHub adapter: a full page means "there may be more", not "that was all".
   *
   * GitLab reports no per-file line counts, so `mapGitLabDiff` derives them from
   * the unified diff text. The GitHub adapter gets them for free — both arrive
   * at the same PRFileDiff, which is what diff.test.ts pins down.
   */
  async getPRDiff(repo: RepoRef, prNumber: number): Promise<PRDiff> {
    const diffs = (await this.api.MergeRequests.allDiffs(repo.path, prNumber, {
      perPage: DIFF_MAX_FILES,
      maxPages: 1,
    })) as RawGitLabDiff[];

    return {
      files: diffs.map(mapGitLabDiff),
      truncated: diffs.length >= DIFF_MAX_FILES,
    };
  }

  private async collectChecks(id: string, mr: Loose): Promise<Check[]> {
    const pipeline = mr.head_pipeline ?? mr.pipeline;
    if (!pipeline?.id) return [];
    try {
      const jobs = (await this.api.Jobs.all(id, { pipelineId: pipeline.id })) as Loose[];
      return jobs.map((j) => ({
        name: j.name,
        state: mapStatus(j.status),
        url: j.web_url ?? null,
      }));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async getWorkflowRuns(repo: RepoRef, ref: string): Promise<Run[]> {
    const pipelines = (await this.api.Pipelines.all(repo.path, { ref })) as Loose[];
    return pipelines.slice(0, 20).map((p) => ({
      id: String(p.id),
      name: `pipeline ${p.id}`,
      event: p.source ?? null, // GitLab pipeline source (push, merge_request_event, …)
      title: p.ref ?? null, // pipelines have no display title; the ref is the closest "what"
      state: mapRun(p.status),
      url: p.web_url ?? null,
      createdAt: p.created_at,
    }));
  }

  async getRunTiming(): Promise<RunTiming | null> {
    // GitLab CI minutes are billed and modeled differently from GitHub Actions,
    // and Dispatch's cost view is GitHub-Actions-shaped (T2-4). Rather than
    // report a number in a different unit, GitLab degrades to tokens-only: null
    // is "unknown", and the card shows no Actions figure for GitLab repos.
    return null;
  }

  async getWorkflowRunsRaw(repo: RepoRef, ref: string): Promise<RawWorkflowRun[]> {
    // GitLab pipelines carry a single status and no separate conclusion, and no
    // `action_required` concept — so the raw view maps status straight through
    // and leaves conclusion null. `claude-code-action` is GitHub-only, so the
    // canary never actually polls this; it exists to keep the seam total.
    const pipelines = (await this.api.Pipelines.all(repo.path, { ref })) as Loose[];
    return pipelines.slice(0, 20).map((p) => ({
      id: String(p.id),
      status: p.status ?? null,
      conclusion: null,
      headBranch: p.ref ?? ref,
      event: p.source ?? null,
      createdAt: p.created_at,
    }));
  }

  async mergePR(repo: RepoRef, prNumber: number, method: MergeMethod): Promise<MergeResult> {
    try {
      const mr = (await this.api.MergeRequests.accept(repo.path, prNumber, {
        squash: method === "squash",
      })) as Loose;
      return {
        merged: mr.state === "merged",
        message: mr.merge_error ?? null,
        sha: mr.merge_commit_sha ?? mr.sha ?? null,
      };
    } catch (err) {
      if (httpStatus(err) === 405 || httpStatus(err) === 406) {
        return { merged: false, message: "Merge request cannot be merged", sha: null };
      }
      throw err;
    }
  }

  async listBranches(repo: RepoRef): Promise<BranchRef[]> {
    const branches = (await this.api.Branches.all(repo.path)) as Loose[];
    return branches.map((b) => ({ name: b.name, sha: b.commit?.id }));
  }

  /**
   * GitLab's commit payload names an author but does not resolve it to an account,
   * and has no bot/user distinction. `authorLogin` and `authorType` are therefore
   * **null**, not guessed.
   *
   * That is deliberate. `claude-code-action` is GitHub-only, so there is no GitLab
   * identity to sample, and #4 AC 9 forbids inferring one from documentation. A
   * poller that treated `authorType: null` as "not a human" would open merge
   * requests from people's work-in-progress branches.
   */
  async getCommitIdentity(repo: RepoRef, sha: string): Promise<CommitIdentity> {
    const commit = (await this.api.Commits.show(repo.path, sha)) as Loose;
    return { authorName: commit.author_name ?? null, authorLogin: null, authorType: null };
  }

  async createPullRequest(repo: RepoRef, input: NewPullRequest): Promise<PRRef> {
    const mr = (await this.api.MergeRequests.create(repo.path, input.head, input.base, input.title, {
      description: input.body,
    })) as Loose;
    return {
      number: mr.iid,
      url: mr.web_url,
      headBranch: mr.source_branch,
      baseBranch: mr.target_branch,
    };
  }

  /**
   * GitLab has no `claude-code-action` to install — its automation is a job in
   * `.gitlab-ci.yml`, which Dispatch does not write. Returning `null` states that
   * in the type, so the route renders "not supported" rather than catching an
   * exception thrown from the bottom of a call stack (#4).
   */
  automationSetup(_repo: RepoRef): RepoAutomationSetup | null {
    return null;
  }
}
