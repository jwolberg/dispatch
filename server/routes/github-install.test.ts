import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resetDb, withServer } from "../test/helpers.js";
import { SqliteInstallationStore, type AppRecord } from "../db/installations.js";
import { getDb } from "../db/migrate.js";
import { ENCRYPTION_KEY_ENV, loadEncryptionKey } from "../lib/crypto.js";
import { __resetRegisteredSecrets } from "../lib/redaction.js";
import { createGithubAppRouter, fetchInstallationRecord } from "./github-app.js";

// #2 — step 3 of the flow: the operator installs the App they just registered,
// GitHub bounces them to `setup_url`, and we record which account and repos the
// installation covers. That record is what `forRepo()` reads to decide whether a
// repo polls with a minted token or with GITHUB_TOKEN.

const KEY = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: randomBytes(32).toString("base64") });

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP: AppRecord = {
  appId: 987654,
  slug: "dispatch-acme",
  name: "Dispatch (acme)",
  clientId: "Iv1.abc",
  clientSecret: "cs_value_long_enough",
  privateKey,
  webhookSecret: "whsec_value_long_enough",
  htmlUrl: "https://github.com/apps/dispatch-acme",
};

function store(onChange = () => {}) {
  return new SqliteInstallationStore(getDb(), KEY, onChange);
}

/**
 * A fake GitHub. Routes by URL so one impl serves the installation lookup, the
 * token mint, and the repository listing — the three calls the flow makes.
 */
function fakeGitHub(opts: {
  installation?: Record<string, unknown>;
  repos?: string[][];
  installationStatus?: number;
  reposStatus?: number;
} = {}) {
  const calls: string[] = [];
  const pages = opts.repos ?? [[]];

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);

    if (u.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "ghs_minted_token", expires_at: new Date(Date.now() + 3600e3).toISOString() }),
        { status: 201 }
      );
    }

    if (u.includes("/installation/repositories")) {
      if (opts.reposStatus) return new Response(JSON.stringify({ message: "no" }), { status: opts.reposStatus });
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      const names = pages[page - 1] ?? [];
      return new Response(
        JSON.stringify({ total_count: pages.flat().length, repositories: names.map((full_name) => ({ full_name })) }),
        { status: 200 }
      );
    }

    if (u.includes("/app/installations/")) {
      if (opts.installationStatus) {
        return new Response(JSON.stringify({ message: "no" }), { status: opts.installationStatus });
      }
      return new Response(
        JSON.stringify({
          id: 42,
          account: { login: "acme", type: "Organization" },
          repository_selection: "all",
          ...opts.installation,
        }),
        { status: 200 }
      );
    }

    throw new Error(`unexpected fetch: ${u} ${String(init?.method)}`);
  }) as unknown as typeof fetch;

  return { impl, calls };
}

describe("fetchInstallationRecord", () => {
  beforeEach(() => {
    resetDb();
    __resetRegisteredSecrets();
  });
  afterEach(() => __resetRegisteredSecrets());

  it("reads the account and selection from the installation, authenticating as the App", async () => {
    const gh = fakeGitHub();
    const rec = await fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl });

    expect(rec).toEqual({
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      repos: [],
    });
    expect(gh.calls[0]).toBe("https://api.github.com/app/installations/42");
  });

  it("does not list repositories when the selection is 'all'", async () => {
    // An 'all' installation covers every repo on the account, present and future.
    // Enumerating them would be a snapshot that goes stale the next time the
    // operator creates a repo.
    const gh = fakeGitHub();
    await fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl });
    expect(gh.calls.some((c) => c.includes("/installation/repositories"))).toBe(false);
  });

  it("lists the granted repositories when the selection is 'selected'", async () => {
    const gh = fakeGitHub({
      installation: { repository_selection: "selected" },
      repos: [["acme/widgets", "acme/gadgets"]],
    });
    const rec = await fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl });

    expect(rec.repositorySelection).toBe("selected");
    expect(rec.repos).toEqual(["acme/widgets", "acme/gadgets"]);
    // Listing repositories needs an installation token, not the App JWT.
    expect(gh.calls.some((c) => c.includes("/access_tokens"))).toBe(true);
  });

  it("pages through a selection larger than one page, and stops at the short page", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `acme/r${i}`);
    const gh = fakeGitHub({
      installation: { repository_selection: "selected" },
      repos: [first, ["acme/last"]],
    });

    const rec = await fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl });
    expect(rec.repos).toHaveLength(101);
    expect(rec.repos.at(-1)).toBe("acme/last");

    // A short page means the last page. Asking for page 3 is a wasted round trip
    // on every install, and the terminator is the only thing preventing it.
    const repoCalls = gh.calls.filter((c) => c.includes("/installation/repositories"));
    expect(repoCalls).toHaveLength(2);
  });

  it("mints the installation token once for the whole page walk", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `acme/r${i}`);
    const gh = fakeGitHub({ installation: { repository_selection: "selected" }, repos: [first, ["x/y"]] });

    await fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl });
    expect(gh.calls.filter((c) => c.includes("/access_tokens"))).toHaveLength(1);
  });

  it("throws when GitHub rejects the installation lookup", async () => {
    const gh = fakeGitHub({ installationStatus: 404 });
    await expect(fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl })).rejects.toThrow(/404/);
  });

  it("never puts the private key or the minted token in a thrown error", async () => {
    const gh = fakeGitHub({ installation: { repository_selection: "selected" }, reposStatus: 403 });
    await expect(fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl })).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("PRIVATE KEY"),
      })
    );
  });

  it("tolerates a missing account type", async () => {
    const gh = fakeGitHub({ installation: { account: { login: "acme" } } });
    const rec = await fetchInstallationRecord(APP, 42, { fetchImpl: gh.impl });
    expect(rec.accountType).toBeNull();
  });
});

describe("GET /api/github/installed", () => {
  beforeEach(() => {
    resetDb();
    __resetRegisteredSecrets();
  });
  afterEach(() => __resetRegisteredSecrets());

  function app(over: Parameters<typeof createGithubAppRouter>[0] = {}) {
    const a = express();
    a.use(express.json());
    a.use("/api/github", createGithubAppRouter({ store: () => store(), baseUrl: () => "https://d.test", ...over }));
    return a;
  }

  it("records the installation and redirects back into Dispatch", async () => {
    store().saveApp(APP);
    const gh = fakeGitHub();

    await withServer(app({ fetchImpl: gh.impl }), async (base) => {
      const res = await fetch(`${base}/api/github/installed?installation_id=42&setup_action=install`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/repos?installed=42");
    });

    expect(store().listInstallations()).toEqual([
      {
        installationId: 42,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "all",
        repos: [],
      },
    ]);
  });

  it("makes the installed repo resolve to the App, not to GITHUB_TOKEN", async () => {
    // The whole point of the ticket, asserted end to end through the store.
    store().saveApp(APP);
    const gh = fakeGitHub();

    await withServer(app({ fetchImpl: gh.impl }), async (base) => {
      await fetch(`${base}/api/github/installed?installation_id=42`, { redirect: "manual" });
    });

    const resolved = store().forRepo({ provider: "github", path: "acme/widgets" });
    expect(resolved).toMatchObject({ installationId: 42, appId: APP.appId });
    expect(resolved?.privateKey).toBe(privateKey);
  });

  it("invalidates the memoized provider cache, so a fresh adapter picks up the installation", async () => {
    store().saveApp(APP);
    const onChange = vi.fn();
    const gh = fakeGitHub();

    await withServer(app({ fetchImpl: gh.impl, store: () => store(onChange) }), async (base) => {
      await fetch(`${base}/api/github/installed?installation_id=42`, { redirect: "manual" });
    });

    expect(onChange).toHaveBeenCalled();
  });

  it("upserts on reinstall rather than duplicating", async () => {
    store().saveApp(APP);
    const gh = fakeGitHub();

    await withServer(app({ fetchImpl: gh.impl }), async (base) => {
      await fetch(`${base}/api/github/installed?installation_id=42`, { redirect: "manual" });
      await fetch(`${base}/api/github/installed?installation_id=42`, { redirect: "manual" });
    });

    expect(store().listInstallations()).toHaveLength(1);
  });

  it("refuses when no App has been registered yet", async () => {
    const gh = fakeGitHub();
    await withServer(app({ fetchImpl: gh.impl }), async (base) => {
      const res = await fetch(`${base}/api/github/installed?installation_id=42`, { redirect: "manual" });
      expect(res.status).toBe(400);
    });
    expect(gh.calls).toEqual([]);
  });

  it("rejects a missing or non-numeric installation_id", async () => {
    store().saveApp(APP);
    await withServer(app({ fetchImpl: fakeGitHub().impl }), async (base) => {
      expect((await fetch(`${base}/api/github/installed`, { redirect: "manual" })).status).toBe(400);
      expect(
        (await fetch(`${base}/api/github/installed?installation_id=abc`, { redirect: "manual" })).status
      ).toBe(400);
    });
  });

  it("handles setup_action=request, where the operator cannot self-approve the install", async () => {
    // GitHub sends `request` when a non-admin asks an org owner to approve. There
    // is no installation to record yet, and pretending otherwise writes a row for
    // an installation that does not exist.
    store().saveApp(APP);
    const gh = fakeGitHub();

    await withServer(app({ fetchImpl: gh.impl }), async (base) => {
      const res = await fetch(`${base}/api/github/installed?setup_action=request`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/repos?install=pending");
    });

    expect(store().listInstallations()).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("surfaces a GitHub failure as a 502 and records nothing", async () => {
    store().saveApp(APP);
    const gh = fakeGitHub({ installationStatus: 500 });

    await withServer(app({ fetchImpl: gh.impl }), async (base) => {
      const res = await fetch(`${base}/api/github/installed?installation_id=42`, { redirect: "manual" });
      expect(res.status).toBe(502);
    });

    expect(store().listInstallations()).toEqual([]);
  });
});

describe("GET /api/github/app — what the setup screen reads", () => {
  beforeEach(() => {
    resetDb();
    __resetRegisteredSecrets();
  });
  afterEach(() => __resetRegisteredSecrets());

  function app(over: Parameters<typeof createGithubAppRouter>[0] = {}) {
    const a = express();
    a.use(express.json());
    a.use("/api/github", createGithubAppRouter({ store: () => store(), baseUrl: () => "https://d.test", ...over }));
    return a;
  }

  it("reports an unregistered deployment", async () => {
    await withServer(app(), async (base) => {
      const body = await (await fetch(`${base}/api/github/app`)).json();
      expect(body).toMatchObject({ registered: false, encryptionKeyConfigured: true, installations: [] });
    });
  });

  it("reports a missing encryption key so the screen can tell the operator", async () => {
    await withServer(app({ store: () => null }), async (base) => {
      const body = await (await fetch(`${base}/api/github/app`)).json();
      expect(body).toMatchObject({ registered: false, encryptionKeyConfigured: false });
    });
  });

  it("describes the App and its install url", async () => {
    store().saveApp(APP);
    await withServer(app(), async (base) => {
      const body = (await (await fetch(`${base}/api/github/app`)).json()) as Record<string, unknown>;
      expect(body.registered).toBe(true);
      expect(body.app).toEqual({
        appId: 987654,
        slug: "dispatch-acme",
        name: "Dispatch (acme)",
        htmlUrl: "https://github.com/apps/dispatch-acme",
      });
      expect(body.installUrl).toBe("https://github.com/apps/dispatch-acme/installations/new");
    });
  });

  it("NEVER serves the private key, client secret, or webhook secret", async () => {
    // The single most important assertion in this file. This endpoint is behind
    // the same shared-password gate as everything else, which is not much of a
    // gate, and its response is the easiest place for a credential to escape.
    store().saveApp(APP);
    store().saveInstallation({
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      repos: ["acme/widgets"],
    });

    await withServer(app(), async (base) => {
      const raw = await (await fetch(`${base}/api/github/app`)).text();
      expect(raw).not.toContain("PRIVATE KEY");
      expect(raw).not.toContain(privateKey);
      expect(raw).not.toContain(APP.clientSecret);
      expect(raw).not.toContain(APP.webhookSecret as string);
      expect(raw).not.toContain(APP.clientId);
    });
  });

  it("summarizes installations by count, not by listing every repo", async () => {
    store().saveApp(APP);
    store().saveInstallation({
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      repos: ["acme/a", "acme/b"],
    });

    await withServer(app(), async (base) => {
      const body = (await (await fetch(`${base}/api/github/app`)).json()) as {
        installations: Array<Record<string, unknown>>;
      };
      expect(body.installations).toEqual([
        {
          installationId: 42,
          accountLogin: "acme",
          accountType: "Organization",
          repositorySelection: "selected",
          repoCount: 2,
        },
      ]);
    });
  });
});
