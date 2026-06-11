import type { GitProvider, ProviderId } from "./types.js";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";

export * from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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
  switch (provider) {
    case "github":
      return new GitHubProvider(requireEnv("GITHUB_TOKEN"), host);
    case "gitlab":
      // Self-hosted GitLab is handled by passing GITLAB_HOST as the base URL.
      return new GitLabProvider(requireEnv("GITLAB_TOKEN"), host ?? process.env.GITLAB_HOST ?? null);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
