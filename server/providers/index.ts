import type { GitProvider, ProviderId, RepoRef } from "./types.js";
import type { CondCacheStore } from "./cond-cache.js";
import type { Installation, InstallationStore, RepoKey } from "./installations.js";
import { AppTokenSource, EnvTokenSource, type TokenSource } from "./token-source.js";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";

export * from "./types.js";
export type { CondCacheStore, CondEntry } from "./cond-cache.js";
export type { Installation, InstallationStore, RepoKey } from "./installations.js";
export type { TokenSource } from "./token-source.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Adapters are memoized by (provider, host, installationId) so a single instance
// — and its in-process conditional-request (ETag) cache — survives across poll
// cycles. Without this, every lookup built a fresh Octokit and the ETag cache
// reset each 20s tick, so unchanged polls kept spending rate-limit quota.
//
// `installationId` joined the key in #3: two repos under one App installation
// share a token and therefore should share an adapter, but a repo under a
// *different* installation must not reuse the first one's credential.
const providerCache = new Map<string, GitProvider>();

export type ProviderFactory = (provider: ProviderId, host?: string | null) => GitProvider;

// Test seam (T0-5). The merge route is the highest-blast-radius endpoint in the
// app — it merges to production — so its gate must be exercisable against a fake
// GitProvider. Production code never calls this; it stays null and the factories
// below keep their memoized real adapters.
let factoryOverride: ProviderFactory | null = null;

/** Install (or clear, with null) a provider factory. Tests only. */
export function setProviderFactory(factory: ProviderFactory | null): void {
  factoryOverride = factory;
  resetProviderCache();
}

// Durable conditional-request cache (T0-9). Injected at boot by server/index.ts
// so providers/ never imports the db layer. Unset → adapters cache in-process
// only, which is what tests and one-shot scripts want.
let condStore: CondCacheStore | undefined;

export function setCondCacheStore(store: CondCacheStore | undefined): void {
  condStore = store;
  resetProviderCache(); // rebuild adapters so they hydrate from the new store
}

// GitHub App installations (#3). Injected the same way and for the same reason:
// providers/ must not import the db layer, and nothing outside providers/ may
// learn that an installation exists. Unset → every repo uses GITHUB_TOKEN, which
// is the documented local path and the only path until #2 registers an App.
let installationStore: InstallationStore | undefined;

export function setInstallationStore(store: InstallationStore | undefined): void {
  installationStore = store;
  resetProviderCache(); // adapters hold a TokenSource; re-resolve it
}

/** The installation covering `key`, or null when there is no App. */
function installationFor(key: RepoKey): Installation | null {
  if (key.provider !== "github") return null; // GitLab has no App story
  return installationStore?.forRepo(key) ?? null;
}

/**
 * One adapter per (provider, host, credential). `installation` is null for the
 * env-token adapter, which is why an unconfigured repo and the env entry from
 * `getAccountProviders()` land on the same instance and share one ETag cache.
 */
function resolve(
  provider: ProviderId,
  host: string | null | undefined,
  installation: Installation | null
): GitProvider {
  const key = `${provider}:${host ?? ""}:${installation?.installationId ?? "env"}`;
  const cached = providerCache.get(key);
  if (cached) return cached;

  let instance: GitProvider;
  switch (provider) {
    case "github": {
      const tokens: TokenSource = installation
        ? new AppTokenSource(installation, { apiBase: host ? `${host.replace(/\/$/, "")}/api/v3` : undefined })
        : new EnvTokenSource(requireEnv("GITHUB_TOKEN"));
      // The credential decides which discovery endpoint is legal (#21). The
      // factory is the only place that knows which credential this adapter got.
      instance = new GitHubProvider(tokens, host, condStore, installation ? "installation" : "user");
      break;
    }
    case "gitlab":
      // Self-hosted GitLab is handled by passing GITLAB_HOST as the base URL.
      instance = new GitLabProvider(requireEnv("GITLAB_TOKEN"), host ?? process.env.GITLAB_HOST ?? null);
      break;
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
  providerCache.set(key, instance);
  return instance;
}

/**
 * Factory for a repo. Resolves the repo's installation *internally*, so callers
 * name a repo and never an installation (ARCH §5).
 *
 * Use this anywhere a repo is in hand — which is 11 of the 14 call sites, all of
 * which already build a `RepoRef`. The other three had no repo and now use
 * {@link getAccountProviders}.
 */
export function getProviderForRepo(ref: RepoRef): GitProvider {
  if (factoryOverride) return factoryOverride(ref.provider, ref.host);
  return resolve(ref.provider, ref.host, installationFor(ref));
}

// `getProvider(provider, host)` — the env-token account-level factory — was removed
// in #21. It had exactly three callers (the rate-limit probe, the health route, and
// repo discovery), all of which assumed a single account-level credential exists.
// Under a GitHub App none does. They now use `getAccountProviders()`. The env token
// still reaches an adapter through `resolve(..., null)`, via that function and via
// `getProviderForRepo()`'s fallback for a repo outside every installation.

/** An adapter, and enough to name the credential behind it — never which one. */
export interface AccountProvider {
  /** `env` = a PAT; `app` = a GitHub App installation token. */
  kind: "env" | "app";
  /** An account login (`acme`), or the env var's name. Safe to render. */
  label: string;
  provider: GitProvider;
}

/**
 * One adapter per credential that can answer an account-level question (#21).
 *
 * A PAT belongs to a *user* and enumerates that user's repos. An installation
 * token belongs to one *installation* and enumerates only its repos. So under a
 * GitHub App there is no single "account-level provider" — there are N, and
 * `discoverRepos()` / `getRateLimit()` must be asked of each and merged.
 *
 * **The seam holds.** A caller receives a `label` (an account login — public, and
 * already the owner half of every `RepoSummary.path`) and an opaque `GitProvider`.
 * It never sees an installation id, and never learns that installations exist.
 * That is ARCHITECTURE §5's rule, and it is why this returns `AccountProvider[]`
 * rather than exposing the store.
 *
 * The env adapter is included **alongside** the App's when `GITHUB_TOKEN` is set:
 * a repo outside every installation is reachable only through it, so dropping it
 * would silently hide those repos from Discover. It is omitted when the token is
 * unset — the case `requireEnv` must never see, and #21's exit criterion.
 *
 * Returns `[]` when there is no credential at all. Callers render an empty list or
 * report `configured: false`. Nothing throws.
 */
export function getAccountProviders(provider: ProviderId, host?: string | null): AccountProvider[] {
  // Honour the test seam (T0-5). A suite that installs a fake factory expects every
  // path through this module to route to it, not just the per-repo one.
  if (factoryOverride) {
    return [{ kind: "env", label: "test", provider: factoryOverride(provider, host) }];
  }

  if (provider === "gitlab") {
    return process.env.GITLAB_TOKEN
      ? [{ kind: "env", label: "GITLAB_TOKEN", provider: resolve(provider, host, null) }]
      : [];
  }

  const accounts: AccountProvider[] = (installationStore?.list() ?? []).map((installation) => ({
    kind: "app" as const,
    label: installation.accountLogin,
    provider: resolve(provider, host, installation),
  }));

  if (process.env.GITHUB_TOKEN) {
    accounts.push({ kind: "env", label: "GITHUB_TOKEN", provider: resolve(provider, host, null) });
  }
  return accounts;
}

/** Drop memoized adapters (e.g. after a token/env change). Test + ops hook. */
export function resetProviderCache(): void {
  providerCache.clear();
}
