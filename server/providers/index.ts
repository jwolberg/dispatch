import type { GitProvider, ProviderId } from "./types.js";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";

export * from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Adapters are memoized by (provider, host) so a single instance — and its
// in-process conditional-request (ETag) cache — survives across poll cycles.
// Without this, every getProvider() built a fresh Octokit and the ETag cache
// reset each 20s tick, so unchanged polls kept spending rate-limit quota.
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

/**
 * Factory: select a provider implementation from a repo's stored (provider,
 * host). This is the ONLY place adapters are constructed; callers depend on the
 * GitProvider interface alone (ARCH §5). Self-hosted GitLab is handled by
 * passing its base URL as `host` — no other code path changes.
 *
 * Tokens are read from the environment server-side and never leave the backend.
 */
export function getProvider(provider: ProviderId, host?: string | null): GitProvider {
  if (factoryOverride) return factoryOverride(provider, host);

  const key = `${provider}:${host ?? ""}`;
  const cached = providerCache.get(key);
  if (cached) return cached;

  let instance: GitProvider;
  switch (provider) {
    case "github":
      instance = new GitHubProvider(requireEnv("GITHUB_TOKEN"), host);
      break;
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

/** Drop memoized adapters (e.g. after a token/env change). Test + ops hook. */
export function resetProviderCache(): void {
  providerCache.clear();
}
