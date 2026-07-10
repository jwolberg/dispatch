import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { getDb } from "./migrate.js";
import {
  SqliteInstallationStore,
  clearInstallations,
  hasRegisteredApp,
  openInstallationStore,
  type AppRecord,
  type InstallationRecord,
} from "./installations.js";
import { ENCRYPTION_KEY_ENV, loadEncryptionKey } from "../lib/crypto.js";
import { __resetRegisteredSecrets, safeMessage } from "../lib/redaction.js";
import { getAccountProviders, getProviderForRepo, setInstallationStore } from "../providers/index.js";
import { clearDirty, isDirty } from "./snapshot.js";

// #2 — the first CONFIDENTIAL table in schema.sql. Every other table here is
// either disposable (rebuilt from the provider) or irreplaceable-but-public
// (`repos`, `tickets`, `spend`). This one holds a GitHub App private key, and
// `snapshot.ts` uploads the whole database to a versioned GCS bucket, so the
// column must be ciphertext before it ever leaves the process (ADR-0006 [6.2]).

const KEY_B64 = randomBytes(32).toString("base64");
const KEY = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: KEY_B64 });

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAxfakefakefakefakefakefakefakefakefakefakefake",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const APP: AppRecord = {
  appId: 987654,
  slug: "dispatch-acme",
  name: "Dispatch (acme)",
  clientId: "Iv1.abc123def456",
  clientSecret: "cs_super_secret_value",
  privateKey: PEM,
  webhookSecret: "whsec_hook_secret_value",
  htmlUrl: "https://github.com/apps/dispatch-acme",
};

function installation(over: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    installationId: 42,
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "all",
    repos: [],
    ...over,
  };
}

function newStore(onChange = () => {}): SqliteInstallationStore {
  return new SqliteInstallationStore(getDb(), KEY, onChange);
}

describe("installations store", () => {
  beforeEach(() => {
    clearInstallations();
    __resetRegisteredSecrets();
  });
  afterEach(() => __resetRegisteredSecrets());

  describe("openInstallationStore — the boot gate", () => {
    it("returns null when no App is registered and no encryption key is set", () => {
      // The documented local-development path: GITHUB_TOKEN, no App, no key.
      // Booting must not demand a key nobody needs yet.
      expect(hasRegisteredApp()).toBe(false);
      expect(openInstallationStore({}, () => {})).toBeNull();
    });

    it("refuses to boot when an App is registered but the encryption key is gone", () => {
      // The dangerous case. A key column that cannot be decrypted must halt boot,
      // not silently fall back to GITHUB_TOKEN and leave the operator wondering
      // why their App stopped being used.
      newStore().saveApp(APP);
      expect(hasRegisteredApp()).toBe(true);
      expect(() => openInstallationStore({}, () => {})).toThrow(/DISPATCH_ENCRYPTION_KEY/);
    });

    it("returns a store when the key is set", () => {
      newStore().saveApp(APP);
      expect(openInstallationStore({ [ENCRYPTION_KEY_ENV]: KEY_B64 }, () => {})).toBeInstanceOf(
        SqliteInstallationStore
      );
    });
  });

  describe("encryption at rest", () => {
    it("writes the private key to disk as ciphertext, never as PEM", () => {
      newStore().saveApp(APP);

      const row = getDb()
        .prepare("SELECT private_key_enc, client_secret_enc, webhook_secret_enc FROM github_app")
        .get() as Record<string, string>;

      for (const column of Object.values(row)) {
        expect(column.startsWith("v1.")).toBe(true);
      }
      expect(row.private_key_enc).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(row.private_key_enc).not.toContain(PEM);
      expect(row.client_secret_enc).not.toContain(APP.clientSecret);
      expect(row.webhook_secret_enc).not.toContain(APP.webhookSecret);
    });

    it("round-trips the App through a fresh store over the same database", () => {
      // Stands in for a container restart: same file, new process, new store.
      newStore().saveApp(APP);
      expect(newStore().getApp()).toEqual(APP);
    });

    it("round-trips a null webhook secret as null, not as an empty string", () => {
      // GitHub's conversion response types webhook_secret as nullable. #17's HMAC
      // verification has to be able to see the absence, so `"" ⇄ null` must survive
      // the encrypted round trip.
      newStore().saveApp({ ...APP, webhookSecret: null });
      expect(newStore().getApp()?.webhookSecret).toBeNull();
    });

    it("still encrypts the column when the webhook secret is null", () => {
      newStore().saveApp({ ...APP, webhookSecret: null });
      const row = getDb().prepare("SELECT webhook_secret_enc FROM github_app").get() as {
        webhook_secret_enc: string;
      };
      expect(row.webhook_secret_enc.startsWith("v1.")).toBe(true);
      expect(row.webhook_secret_enc).not.toBe("");
    });

    it("registers the decrypted private key with the redactor", () => {
      // ADR-0006 [6.3]: redaction.ts scans process.env, and a key from SQLite is
      // never in process.env. Without registering it on decrypt, safeMessage()
      // returns the PEM verbatim into a log line.
      const store = newStore();
      store.saveApp(APP);
      __resetRegisteredSecrets(); // pretend a fresh process that has not read it yet

      store.getApp();

      const leaked = new Error(`mint failed with key ${PEM}`);
      expect(safeMessage(leaked)).not.toContain(PEM);
      expect(safeMessage(leaked)).toContain("«redacted»");
    });

    it("registers the key when it is reached through forRepo, not only getApp", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation());
      __resetRegisteredSecrets();

      const resolved = store.forRepo({ provider: "github", path: "acme/widgets" });
      expect(resolved?.privateKey).toBe(PEM);

      expect(safeMessage(new Error(`boom ${PEM}`))).not.toContain(PEM);
    });
  });

  describe("forRepo — installation resolution", () => {
    let store: SqliteInstallationStore;
    beforeEach(() => {
      store = newStore();
      store.saveApp(APP);
    });

    it("resolves a repo under an installed account to that installation", () => {
      store.saveInstallation(installation());
      expect(store.forRepo({ provider: "github", path: "acme/widgets" })).toEqual({
        installationId: 42,
        appId: APP.appId,
        privateKey: PEM,
        accountLogin: "acme",
      });
    });

    it("matches the account case-insensitively, as GitHub does", () => {
      store.saveInstallation(installation({ accountLogin: "Acme" }));
      expect(store.forRepo({ provider: "github", path: "acme/widgets" })).not.toBeNull();
      expect(store.forRepo({ provider: "github", path: "ACME/widgets" })).not.toBeNull();
    });

    it("returns null for a repo under an account with no installation", () => {
      store.saveInstallation(installation({ accountLogin: "acme" }));
      expect(store.forRepo({ provider: "github", path: "other/widgets" })).toBeNull();
    });

    it("returns null for gitlab, which has no App story", () => {
      store.saveInstallation(installation({ accountLogin: "acme" }));
      expect(store.forRepo({ provider: "gitlab", path: "acme/widgets" })).toBeNull();
    });

    it("returns null when no App is registered, even with an installation row", () => {
      clearInstallations();
      newStore().saveInstallation(installation());
      expect(newStore().forRepo({ provider: "github", path: "acme/widgets" })).toBeNull();
    });

    describe("repository_selection", () => {
      it("resolves any repo under the account when selection is 'all'", () => {
        store.saveInstallation(installation({ repositorySelection: "all", repos: [] }));
        expect(store.forRepo({ provider: "github", path: "acme/anything" })).not.toBeNull();
      });

      it("resolves a repo the App was granted when selection is 'selected'", () => {
        store.saveInstallation(
          installation({ repositorySelection: "selected", repos: ["acme/widgets"] })
        );
        expect(store.forRepo({ provider: "github", path: "acme/widgets" })).not.toBeNull();
      });

      it("returns null for a repo the App was NOT granted, so GITHUB_TOKEN still serves it", () => {
        // The alternative — returning the installation anyway — turns every call on
        // that repo into a 404, and regresses a repo the operator was already
        // tracking with GITHUB_TOKEN before they installed the App.
        store.saveInstallation(
          installation({ repositorySelection: "selected", repos: ["acme/widgets"] })
        );
        expect(store.forRepo({ provider: "github", path: "acme/other" })).toBeNull();
      });

      it("compares the granted repo list case-insensitively", () => {
        store.saveInstallation(
          installation({ repositorySelection: "selected", repos: ["Acme/Widgets"] })
        );
        expect(store.forRepo({ provider: "github", path: "acme/widgets" })).not.toBeNull();
      });
    });
  });

  describe("installation records", () => {
    it("persists account, type, selection and granted repos", () => {
      const store = newStore();
      const rec = installation({ repositorySelection: "selected", repos: ["acme/a", "acme/b"] });
      store.saveApp(APP);
      store.saveInstallation(rec);

      expect(newStore().listInstallations()).toEqual([rec]);
    });

    it("upserts on reinstall rather than duplicating the installation", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation({ repos: ["acme/a"] }));
      store.saveInstallation(installation({ repos: ["acme/a", "acme/b"] }));

      const all = store.listInstallations();
      expect(all).toHaveLength(1);
      expect(all[0].repos).toEqual(["acme/a", "acme/b"]);
    });

    it("drops an installation on uninstall", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation());
      store.deleteInstallation(42);
      expect(store.listInstallations()).toEqual([]);
      expect(store.forRepo({ provider: "github", path: "acme/widgets" })).toBeNull();
    });
  });

  describe("cache invalidation (the stale-key trap)", () => {
    // providers/index.ts memoizes one adapter — and one AppTokenSource holding one
    // privateKey — per (provider, host, installationId), for the life of the
    // process. Regenerate the key or reinstall the App and that adapter mints
    // against dead credentials forever: a 401 triggers exactly one re-mint, which
    // reuses the same stale key. The store is the only thing that knows.
    it("notifies on saveApp — a regenerated private key must not stay memoized", () => {
      const onChange = vi.fn();
      newStore(onChange).saveApp(APP);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("notifies on saveInstallation", () => {
      const onChange = vi.fn();
      const store = newStore(onChange);
      store.saveApp(APP);
      onChange.mockClear();

      store.saveInstallation(installation());
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("notifies on deleteInstallation", () => {
      const onChange = vi.fn();
      const store = newStore(onChange);
      store.saveApp(APP);
      store.saveInstallation(installation());
      onChange.mockClear();

      store.deleteInstallation(42);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("does not notify on a read", () => {
      const onChange = vi.fn();
      const store = newStore(onChange);
      store.saveApp(APP);
      store.saveInstallation(installation());
      onChange.mockClear();

      store.forRepo({ provider: "github", path: "acme/widgets" });
      store.getApp();
      store.listInstallations();
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("the GITHUB_TOKEN path must not regress (AC 11)", () => {
    // providers/index.test.ts proves the fallback against a *fake* store. This
    // proves it against the real SQLite one, wired through the real factory —
    // which is the thing server/index.ts actually injects.
    const original = process.env.GITHUB_TOKEN;
    beforeEach(() => {
      process.env.GITHUB_TOKEN = "ghp_local_dev_token";
    });
    afterEach(() => {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
      setInstallationStore(undefined);
    });

    it("resolves every repo to the env adapter when no App is registered", () => {
      setInstallationStore(newStore());
      expect(() => getProviderForRepo({ provider: "github", path: "acme/widgets" })).not.toThrow();
    });

    it("resolves a repo outside the installation's account to the env adapter", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation({ accountLogin: "acme" }));
      setInstallationStore(store);

      // Same instance as the env account → it is the env adapter, not the App's.
      const outside = getProviderForRepo({ provider: "github", path: "someone-else/repo" });
      expect(outside).toBe(getAccountProviders("github").find((a) => a.kind === "env")!.provider);
    });

    it("does NOT hand an installed repo the env adapter", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation({ accountLogin: "acme" }));
      setInstallationStore(store);

      expect(getProviderForRepo({ provider: "github", path: "acme/widgets" })).not.toBe(
        getAccountProviders("github").find((a) => a.kind === "env")!.provider
      );
    });
  });

  describe("list() — the account-level enumeration (#21)", () => {
    it("returns nothing when no App is registered", () => {
      expect(newStore().list()).toEqual([]);
    });

    it("returns nothing when an App exists but nothing is installed", () => {
      const store = newStore();
      store.saveApp(APP);
      expect(store.list()).toEqual([]);
    });

    it("returns one entry per installation, each carrying the App's key", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation({ installationId: 42, accountLogin: "acme" }));
      store.saveInstallation(installation({ installationId: 43, accountLogin: "jwolberg" }));

      expect(store.list()).toEqual([
        { installationId: 42, appId: APP.appId, privateKey: PEM, accountLogin: "acme" },
        { installationId: 43, appId: APP.appId, privateKey: PEM, accountLogin: "jwolberg" },
      ]);
    });

    it("registers the private key with the redactor", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation());
      __resetRegisteredSecrets();

      store.list();
      expect(safeMessage(new Error(`boom ${PEM}`))).not.toContain(PEM);
    });
  });

  describe("durability — these tables are irreplaceable (#20)", () => {
    // github_app and installations cannot be rebuilt from the provider: the private
    // key exists nowhere else. Without markDirty(), snapshot.ts never uploads after
    // a registration, and the next Cloud Run redeploy restores a snapshot that has
    // never heard of the App. Dispatch then boots clean and silently uses
    // GITHUB_TOKEN — the failure the boot gate exists to prevent, by another door.
    beforeEach(() => clearDirty());
    afterEach(() => clearDirty());

    it("marks the database dirty when the App is registered", () => {
      newStore().saveApp(APP);
      expect(isDirty()).toBe(true);
    });

    it("marks the database dirty when an installation is recorded", () => {
      newStore().saveApp(APP);
      clearDirty();
      newStore().saveInstallation(installation());
      expect(isDirty()).toBe(true);
    });

    it("marks the database dirty when an installation is removed", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation());
      clearDirty();

      store.deleteInstallation(42);
      expect(isDirty()).toBe(true);
    });

    it("does not mark the database dirty on a read", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveInstallation(installation());
      clearDirty();

      store.getApp();
      store.forRepo({ provider: "github", path: "acme/widgets" });
      store.listInstallations();
      expect(isDirty()).toBe(false);
    });
  });

  describe("the App row is a singleton", () => {
    it("replaces the App on re-registration rather than accumulating rows", () => {
      const store = newStore();
      store.saveApp(APP);
      store.saveApp({ ...APP, appId: 111, name: "Dispatch (re-registered)" });

      const count = getDb().prepare("SELECT COUNT(*) AS n FROM github_app").get() as { n: number };
      expect(count.n).toBe(1);
      expect(store.getApp()?.appId).toBe(111);
    });
  });
});
