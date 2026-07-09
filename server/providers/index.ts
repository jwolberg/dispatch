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
// cycles. Without this, every getProvider() built a fresh Octokit and the ETag
// cache reset each 20s tick, so unchanged polls kept spending rate-limit quota.
//
// `installationId` joined the key in #3: two repos under one App installation
// share a token and therefore should share an adapter, but a repo under a
// *different* installation must not reuse the first one's credential.
const providerCache = new Map<string, GitProvider>();

export type ProviderFactory = (provider: ProviderId, host?: string | null) => GitProvider;

// Test seam (T0-5). The merge route is the highest-blast-radius endpoint in the
// app — it merges to production — so its gate must be exercisable against a fake
// GitProvider. Production code never calls this; it stays null and getProvider
// keeps its memoized real adapters.
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
 * env-token adapter, which is why an unconfigured repo and an account-level
 * `getProvider()` call land on the same instance and share one ETag cache.
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
      instance = new GitHubProvider(tokens, host, condStore);
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
 * Prefer this over {@link getProvider} anywhere a repo is in hand — which is 11
 * of the 14 call sites, all of which already build a `RepoRef`.
 */
export function getProviderForRepo(ref: RepoRef): GitProvider {
  if (factoryOverride) return factoryOverride(ref.provider, ref.host);
  return resolve(ref.provider, ref.host, installationFor(ref));
}

/**
 * Factory for an account-level call — one with no repo: the rate-limit probe
 * (`poller/scheduler.ts`, `routes/health.ts`) and repo discovery
 * (`routes/discover.ts`).
 *
 * These always use the env token. Under a GitHub App there is no account-level
 * credential at all — `discoverRepos()` would enumerate an *installation's*
 * repos — so rewiring them belongs to #2's source swap, not to this seam.
 */
export function getProvider(provider: ProviderId, host?: string | null): GitProvider {
  if (factoryOverride) return factoryOverride(provider, host);
  return resolve(provider, host, null);
}

/** Drop memoized adapters (e.g. after a token/env change). Test + ops hook. */
export function resetProviderCache(): void {
  providerCache.clear();
}
