import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProvider,
  getProviderForRepo,
  resetProviderCache,
  setInstallationStore,
} from "./index.js";
import type { Installation, InstallationStore, RepoKey } from "./installations.js";
import type { RepoRef } from "./types.js";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-used-until-a-token-is-minted\n-----END PRIVATE KEY-----";

function install(installationId: number): Installation {
  return { installationId, appId: 1, privateKey: PRIVATE_KEY };
}

/** A store that maps repo path → installation. Anything unlisted has no App. */
function storeOf(byPath: Record<string, Installation>): InstallationStore {
  return { forRepo: (key: RepoKey) => byPath[key.path] ?? null };
}

const repo = (path: string, host?: string | null): RepoRef => ({
  provider: "github",
  host: host ?? null,
  path,
});

describe("getProvider / getProviderForRepo", () => {
  const originalGh = process.env.GITHUB_TOKEN;
  const originalGl = process.env.GITLAB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_env_token_for_tests";
    process.env.GITLAB_TOKEN = "glpat_env_token_for_tests";
    setInstallationStore(undefined);
    resetProviderCache();
  });

  afterEach(() => {
    setInstallationStore(undefined);
    resetProviderCache();
    if (originalGh === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGh;
    if (originalGl === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = originalGl;
  });

  describe("memoization (T0-9: the ETag cache must survive poll cycles)", () => {
    it("returns the same instance for the same repo's installation", () => {
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      const a = getProviderForRepo(repo("acme/widgets"));
      const b = getProviderForRepo(repo("acme/widgets"));
      expect(a).toBe(b);
    });

    it("shares one instance across two repos under the SAME installation", () => {
      // An App installed on an org covers many repos with one token. Two adapters
      // would mean two ETag caches and two token mints for one credential.
      setInstallationStore(storeOf({ "acme/widgets": install(100), "acme/gadgets": install(100) }));
      expect(getProviderForRepo(repo("acme/widgets"))).toBe(getProviderForRepo(repo("acme/gadgets")));
    });

    it("returns a DIFFERENT instance for a different installation", () => {
      setInstallationStore(storeOf({ "acme/widgets": install(100), "other/thing": install(200) }));
      expect(getProviderForRepo(repo("acme/widgets"))).not.toBe(getProviderForRepo(repo("other/thing")));
    });

    it("keeps the env-token adapter distinct from any installation's adapter", () => {
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      const app = getProviderForRepo(repo("acme/widgets"));
      const env = getProviderForRepo(repo("unlisted/repo"));
      expect(app).not.toBe(env);
    });

    it("keys on host, so github.com and an Enterprise host never share an adapter", () => {
      const a = getProviderForRepo(repo("acme/widgets"));
      const b = getProviderForRepo(repo("acme/widgets", "https://ghe.internal"));
      expect(a).not.toBe(b);
    });
  });

  describe("fallback to the env token", () => {
    it("resolves a repo with no installation to the GITHUB_TOKEN adapter", () => {
      setInstallationStore(storeOf({}));
      // Identity with the account-level adapter is what proves it is the env one.
      // `not.toThrow()` would also pass if it silently built an App adapter.
      expect(getProviderForRepo(repo("acme/widgets"))).toBe(getProvider("github"));
    });

    it("resolves every repo to the env adapter when no store is injected at all", () => {
      // The documented local path: no App, no store, GITHUB_TOKEN in .env.
      const a = getProviderForRepo(repo("acme/widgets"));
      const b = getProviderForRepo(repo("other/thing"));
      expect(a).toBe(b); // both are the one env-backed adapter
    });

    it("throws when a repo has no installation and no GITHUB_TOKEN is set", () => {
      delete process.env.GITHUB_TOKEN;
      expect(() => getProviderForRepo(repo("acme/widgets"))).toThrow(/GITHUB_TOKEN/);
    });

    it("leaves GitLab on its env token regardless of the installation store", () => {
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      const a = getProviderForRepo({ provider: "gitlab", host: null, path: "acme/widgets" });
      const b = getProviderForRepo({ provider: "gitlab", host: null, path: "acme/widgets" });
      expect(a).toBe(b);
      expect(a).not.toBe(getProviderForRepo(repo("acme/widgets")));
    });
  });

  describe("account-level getProvider (no repo in hand)", () => {
    it("ignores the installation store entirely — an installed repo's adapter is a different one", () => {
      // scheduler.ts, health.ts and discover.ts ask for a provider with no repo.
      // Under an App there is no account-level token; rewiring them is #21.
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      expect(getProvider("github")).not.toBe(getProviderForRepo(repo("acme/widgets")));
    });

    it("hands back the same adapter the env fallback uses, so the ETag cache is shared", () => {
      expect(getProvider("github")).toBe(getProviderForRepo(repo("unlisted/repo")));
    });
  });

  describe("setInstallationStore", () => {
    it("drops memoized adapters so they re-resolve against the new store", () => {
      const before = getProviderForRepo(repo("acme/widgets")); // env
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      expect(getProviderForRepo(repo("acme/widgets"))).not.toBe(before);
    });
  });
});
