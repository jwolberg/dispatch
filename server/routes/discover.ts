import { Router } from "express";
import { getAccountProviders } from "../providers/index.js";
import type { AccountProvider, ProviderId } from "../providers/index.js";
import type { RepoSummary } from "../providers/types.js";
import { safeMessage } from "../lib/redaction.js";

const VALID_PROVIDERS: ProviderId[] = ["github", "gitlab"];

export interface DiscoverDeps {
  accounts: (provider: ProviderId, host?: string | null) => AccountProvider[];
}

interface AccountError {
  label: string;
  error: string;
}

/** Newest first; a repo with no recorded activity sorts last. */
function byActivityDesc(a: RepoSummary, b: RepoSummary): number {
  const ta = a.lastActivity ? Date.parse(a.lastActivity) : -Infinity;
  const tb = b.lastActivity ? Date.parse(b.lastActivity) : -Infinity;
  return tb - ta;
}

/**
 * Merge, preferring the **first** account that reported a repo.
 *
 * `getAccountProviders()` lists App installations before the env adapter, so an
 * org repo visible through both is described by its installation. Without this the
 * Repos page renders two Track buttons for one repo.
 */
function dedupeByPath(repos: RepoSummary[]): RepoSummary[] {
  const seen = new Map<string, RepoSummary>();
  for (const repo of repos) {
    const key = `${repo.host ?? ""}:${repo.path.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, repo);
  }
  return [...seen.values()];
}

export function createDiscoverRouter(deps: Partial<DiscoverDeps> = {}): Router {
  const accounts = deps.accounts ?? getAccountProviders;
  const router = Router();

  // GET /api/discover?provider=github|gitlab — every repo every credential can
  // reach, normalized to RepoSummary[] (PRD F1.0).
  //
  // Under a GitHub App there is no single account-level credential (#21): a PAT
  // enumerates a *user's* repos, an installation token only *its own*. So ask each
  // and merge. One failing account must not blank the page for the others — a
  // revoked installation is a partial outage, not a total one.
  router.get("/", async (req, res) => {
    const provider = String(req.query.provider ?? "github") as ProviderId;
    if (!VALID_PROVIDERS.includes(provider)) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    const credentials = accounts(provider);
    if (credentials.length === 0) {
      // No App, no token. An empty list is the honest answer; "you have configured
      // nothing" is what /api/health is for.
      res.json({ provider, repos: [], errors: [] });
      return;
    }

    const settled = await Promise.allSettled(credentials.map((a) => a.provider.discoverRepos()));

    const repos: RepoSummary[] = [];
    const errors: AccountError[] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") repos.push(...result.value);
      // safeMessage, not the raw reason: an Octokit error can echo the
      // Authorization header, and AppTokenSource registers every token it mints.
      else errors.push({ label: credentials[i].label, error: safeMessage(result.reason) });
    });

    // Every credential failed. That is an outage, not a partial result.
    if (errors.length === credentials.length) {
      res.status(502).json({ provider, repos: [], errors });
      return;
    }

    res.json({ provider, repos: dedupeByPath(repos).sort(byActivityDesc), errors });
  });

  return router;
}

export const discoverRouter = createDiscoverRouter();
