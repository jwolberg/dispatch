import { listRepos, type RepoRow } from "../db/repos.js";
import { createTicket, listTickets } from "../db/tickets.js";
import { getProviderForRepo } from "../providers/index.js";
import type { ProviderId, RepoRef } from "../providers/index.js";
import { safeMessage } from "../lib/redaction.js";

function refOf(repo: RepoRow): RepoRef {
  return {
    provider: repo.provider as ProviderId,
    host: repo.host,
    path: repo.path,
    defaultBranch: repo.default_branch,
  };
}

/**
 * Adopt a tracked repo's existing open issues onto the board as tickets — not
 * just the issues Dispatch itself filed. Idempotent: only issue numbers not yet
 * tracked for this repo are inserted (the poller then builds each card from the
 * live provider state). Returns the number of new tickets created.
 */
export async function discoverTickets(repo: RepoRow): Promise<number> {
  const ref = refOf(repo);
  const provider = getProviderForRepo(ref);
  const open = await provider.listOpenIssues(ref);
  const known = new Set(
    listTickets()
      .filter((t) => t.repo_id === repo.id)
      .map((t) => t.issue_number)
  );
  const now = new Date().toISOString();
  let created = 0;
  for (const issue of open) {
    if (known.has(issue.number)) continue;
    createTicket(repo.id, issue.number, null, now);
    created++;
  }
  return created;
}

/** Discover across every tracked repo, swallowing per-repo provider errors. */
export async function discoverAllRepos(): Promise<void> {
  for (const repo of listRepos()) {
    try {
      const n = await discoverTickets(repo);
      if (n > 0) {
        console.log(`[discover] imported ${n} issue(s) from ${repo.provider}:${repo.path}`);
      }
    } catch (err) {
      console.warn(`[discover] ${repo.provider}:${repo.path} failed: ${safeMessage(err)}`);
    }
  }
}
