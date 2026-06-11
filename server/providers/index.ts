import type { GitProvider, ProviderId } from "./types.js";

export * from "./types.js";

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
      // Wired in P1-T4 (GitHub adapter).
      throw new Error("GitHub provider not yet implemented");
    case "gitlab":
      // Wired in P5-T1 (GitLab adapter).
      throw new Error("GitLab provider not yet implemented");
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
