import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAccountProviders,
  getProvider,
  getProviderForRepo,
  resetProviderCache,
  setInstallationStore,
} from "./index.js";
import type { Installation, InstallationStore, RepoKey } from "./installations.js";
import type { RepoRef } from "./types.js";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-used-until-a-token-is-minted\n-----END PRIVATE KEY-----";

function install(installationId: number, accountLogin = "acme"): Installation {
  return { installationId, appId: 1, privateKey: PRIVATE_KEY, accountLogin };
}

/** A store that maps repo path → installation. Anything unlisted has no App. */
function storeOf(byPath: Record<string, Installation>): InstallationStore {
  const seen = new Map<number, Installation>();
  for (const i of Object.values(byPath)) seen.set(i.installationId, i);
  return {
    forRepo: (key: RepoKey) => byPath[key.path] ?? null,
    list: () => [...seen.values()],
  };
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

  describe("getAccountProviders — one adapter per credential (#21)", () => {
    // health.ts and discover.ts have no repo, and under an App there is no
    // account-level credential — only one per installation. They iterate opaque
    // adapters; nothing outside providers/ learns what an installation is.

    it("returns just the env adapter when no store is injected", () => {
      const accounts = getAccountProviders("github");
      expect(accounts).toHaveLength(1);
      expect(accounts[0].kind).toBe("env");
      expect(accounts[0].provider).toBe(getProvider("github"));
    });

    it("labels the env adapter by its environment variable", () => {
      expect(getAccountProviders("github")[0].label).toBe("GITHUB_TOKEN");
    });

    it("returns one adapter per installation, labelled by account", () => {
      setInstallationStore(
        storeOf({ "acme/widgets": install(100, "acme"), "jw/dispatch": install(200, "jwolberg") })
      );
      const accounts = getAccountProviders("github");

      expect(accounts.filter((a) => a.kind === "app").map((a) => a.label).sort()).toEqual([
        "acme",
        "jwolberg",
      ]);
    });

    it("gives each installation a distinct adapter, and reuses the memoized one", () => {
      // Distinct: two installations hold two different credentials. Reused: the
      // adapter carries the ETag cache, and discover must not reset it every call.
      setInstallationStore(
        storeOf({ "acme/widgets": install(100, "acme"), "jw/dispatch": install(200, "jwolberg") })
      );
      const [a, b] = getAccountProviders("github").filter((x) => x.kind === "app");

      expect(a.provider).not.toBe(b.provider);
      expect(a.provider).toBe(getProviderForRepo(repo("acme/widgets")));
      expect(b.provider).toBe(getProviderForRepo(repo("jw/dispatch")));
    });

    it("also includes the env adapter when GITHUB_TOKEN is set alongside an App", () => {
      // A repo outside every installation is reachable only via the env token.
      // Dropping it here would silently hide those repos from Discover.
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      const kinds = getAccountProviders("github").map((a) => a.kind);
      expect(kinds).toContain("env");
      expect(kinds).toContain("app");
    });

    it("omits the env adapter — and does not throw — when GITHUB_TOKEN is unset", () => {
      // The exit criterion of #21: run end-to-end with only an App. `requireEnv`
      // must never be reached.
      delete process.env.GITHUB_TOKEN;
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));

      const accounts = getAccountProviders("github");
      expect(accounts.map((a) => a.kind)).toEqual(["app"]);
    });

    it("returns nothing rather than throwing when there is no credential at all", () => {
      // No App, no token. Discover should render an empty list and health should
      // say `configured: false` — neither should 500.
      delete process.env.GITHUB_TOKEN;
      expect(getAccountProviders("github")).toEqual([]);
    });

    it("leaves GitLab on its env token regardless of the installation store", () => {
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      const accounts = getAccountProviders("gitlab");
      expect(accounts).toHaveLength(1);
      expect(accounts[0].kind).toBe("env");
    });

    it("never exposes an installation id to the caller", () => {
      // The seam's rule (ARCHITECTURE §5). A label is an account login — public,
      // and already visible in every RepoSummary.path.
      setInstallationStore(storeOf({ "acme/widgets": install(100) }));
      for (const account of getAccountProviders("github")) {
        expect(Object.keys(account).sort()).toEqual(["kind", "label", "provider"]);
      }
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
