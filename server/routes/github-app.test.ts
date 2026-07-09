import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { randomBytes } from "node:crypto";
import { resetDb, withServer } from "../test/helpers.js";
import { SqliteInstallationStore } from "../db/installations.js";
import { getDb } from "../db/migrate.js";
import { ENCRYPTION_KEY_ENV, loadEncryptionKey } from "../lib/crypto.js";
import { __resetRegisteredSecrets, safeMessage } from "../lib/redaction.js";
import {
  APP_PERMISSIONS,
  PendingRegistrations,
  buildManifest,
  convertManifestCode,
  createGithubAppRouter,
  manifestActionUrl,
} from "./github-app.js";

// #2 — the manifest flow. Nothing about the App is committed to this repo: the
// operator registers their own from their own instance (ADR-0006 [5]).
//
// The external format here was verified against GitHub's OpenAPI description and
// three live Apps before it was encoded, because the ADR's description of it was
// wrong in three places. The regression guards below are what keep it right.

const KEY_B64 = randomBytes(32).toString("base64");
const KEY = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: KEY_B64 });

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nfakefakefake\n-----END RSA PRIVATE KEY-----";

/** A 201 body shaped exactly like POST /app-manifests/{code}/conversions returns. */
function conversionBody(over: Record<string, unknown> = {}) {
  return {
    id: 987654,
    slug: "dispatch-acme",
    node_id: "MDM6QXBw",
    name: "Dispatch (acme)",
    html_url: "https://github.com/apps/dispatch-acme",
    owner: { login: "acme", type: "Organization" },
    client_id: "Iv1.abc123",
    client_secret: "cs_secret_value_here",
    webhook_secret: "whsec_value_here",
    pem: PEM,
    permissions: APP_PERMISSIONS,
    events: [],
    ...over,
  };
}

function store(onChange = () => {}) {
  return new SqliteInstallationStore(getDb(), KEY, onChange);
}

describe("buildManifest", () => {
  const manifest = () => buildManifest({ name: "Dispatch (acme)", baseUrl: "https://d.example.test" });

  it("requests exactly the seven permissions the ticket specifies", () => {
    // Verified against the `app-permissions` schema in GitHub's OpenAPI
    // description. Any extra permission here is scope the operator did not agree
    // to; any missing one breaks #4's setup commits.
    expect(manifest().default_permissions).toEqual({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      workflows: "write",
      secrets: "write",
      actions: "read",
      metadata: "read",
    });
  });

  it("never requests `workflows: read`, which GitHub does not accept", () => {
    // The app-permissions enum for `workflows` is ["write"] only.
    expect(manifest().default_permissions.workflows).toBe("write");
  });

  it("carries the operator's App name verbatim", () => {
    expect(buildManifest({ name: "My Own Name", baseUrl: "https://x.test" }).name).toBe("My Own Name");
  });

  it("points url, redirect_url, setup_url and the webhook at the deployment", () => {
    const m = manifest();
    expect(m.url).toBe("https://d.example.test");
    expect(m.redirect_url).toBe("https://d.example.test/api/github/callback");
    expect(m.setup_url).toBe("https://d.example.test/api/github/installed");
    expect(m.hook_attributes.url).toBe("https://d.example.test/api/webhooks/github");
  });

  it("tolerates a base URL with a trailing slash", () => {
    const m = buildManifest({ name: "n", baseUrl: "https://d.example.test/" });
    expect(m.redirect_url).toBe("https://d.example.test/api/github/callback");
  });

  it("registers a private App with no default events", () => {
    // Public would let anyone install the operator's App on their own repos.
    expect(manifest().public).toBe(false);
    expect(manifest().default_events).toEqual([]);
  });

  it("leaves the webhook inactive until #17 can verify its signatures", () => {
    expect(manifest().hook_attributes.active).toBe(false);
  });
});

describe("manifestActionUrl", () => {
  it("targets the personal-account path when no org is given", () => {
    expect(manifestActionUrl(null, "st8")).toBe("https://github.com/settings/apps/new?state=st8");
  });

  it("targets the organization path when an org is given", () => {
    expect(manifestActionUrl("acme", "st8")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=st8"
    );
  });

  it("never emits an `?org=` parameter", () => {
    // ADR-0006 [5] originally claimed `?org=<org>` selected org ownership. It does
    // not exist. Posting the manifest to the personal path with a stray `?org=`
    // would silently register the App on the operator's personal account instead
    // of their organization — a wrong-owner App that looks like it worked.
    expect(manifestActionUrl("acme", "st8")).not.toContain("org=");
    expect(manifestActionUrl(null, "st8")).not.toContain("org=");
  });

  it("url-encodes the org and the state", () => {
    expect(manifestActionUrl("my org", "a b")).toBe(
      "https://github.com/organizations/my%20org/settings/apps/new?state=a%20b"
    );
  });

  it("rejects an org that tries to escape the path", () => {
    expect(() => manifestActionUrl("../../evil", "s")).toThrow(/org/i);
    expect(() => manifestActionUrl("acme/x", "s")).toThrow(/org/i);
  });
});

describe("PendingRegistrations", () => {
  it("issues an unguessable state and returns it once", () => {
    const p = new PendingRegistrations();
    const state = p.issue({ org: "acme" });
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(p.consume(state)).toEqual({ org: "acme" });
  });

  it("refuses a replayed state — this is what makes the callback one-shot", () => {
    // GitHub documents the manifest code as valid for an hour and never promises
    // single use. Consuming the state is what stops a replayed callback URL from
    // re-registering (or re-writing) the App.
    const p = new PendingRegistrations();
    const state = p.issue({ org: null });
    expect(p.consume(state)).not.toBeNull();
    expect(p.consume(state)).toBeNull();
  });

  it("refuses a state it never issued", () => {
    expect(new PendingRegistrations().consume("forged")).toBeNull();
  });

  it("expires a state after GitHub's one-hour window", () => {
    let now = 1_000_000;
    const p = new PendingRegistrations({ now: () => now });
    const state = p.issue({ org: null });

    now += 60 * 60 * 1000 + 1;
    expect(p.consume(state)).toBeNull();
  });

  it("issues distinct states", () => {
    const p = new PendingRegistrations();
    expect(p.issue({ org: null })).not.toBe(p.issue({ org: null }));
  });
});

describe("convertManifestCode", () => {
  function fetchReturning(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  it("POSTs to the conversions endpoint with the code in the path", async () => {
    const fetchImpl = fetchReturning(201, conversionBody());
    await convertManifestCode("the-code", { fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.github.com/app-manifests/the-code/conversions");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("url-encodes a code containing path characters", async () => {
    const fetchImpl = fetchReturning(201, conversionBody());
    await convertManifestCode("a/../b", { fetchImpl });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.github.com/app-manifests/a%2F..%2Fb/conversions");
  });

  it("maps the response onto an AppRecord", async () => {
    const rec = await convertManifestCode("c", { fetchImpl: fetchReturning(201, conversionBody()) });
    expect(rec).toEqual({
      appId: 987654,
      slug: "dispatch-acme",
      name: "Dispatch (acme)",
      clientId: "Iv1.abc123",
      clientSecret: "cs_secret_value_here",
      privateKey: PEM,
      webhookSecret: "whsec_value_here",
      htmlUrl: "https://github.com/apps/dispatch-acme",
    });
  });

  it("accepts a null webhook_secret, which GitHub's schema allows", async () => {
    const rec = await convertManifestCode("c", {
      fetchImpl: fetchReturning(201, conversionBody({ webhook_secret: null })),
    });
    expect(rec.webhookSecret).toBeNull();
  });

  it("throws when GitHub rejects the code", async () => {
    const fetchImpl = fetchReturning(404, { message: "Not Found" });
    await expect(convertManifestCode("bad", { fetchImpl })).rejects.toThrow(/404/);
  });

  it("throws when a required credential is missing rather than storing a blank one", async () => {
    for (const missing of ["pem", "client_secret", "client_id", "id"]) {
      const fetchImpl = fetchReturning(201, conversionBody({ [missing]: undefined }));
      await expect(convertManifestCode("c", { fetchImpl })).rejects.toThrow(/incomplete|missing/i);
    }
  });

  it("never puts the private key in the error it throws", async () => {
    // A 201 that is missing client_secret still carries the pem. The throw must
    // not carry it into a log line.
    const fetchImpl = fetchReturning(201, conversionBody({ client_secret: undefined }));
    await expect(convertManifestCode("c", { fetchImpl })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(PEM) })
    );
  });

  it("registers the credentials with the redactor as soon as GitHub returns them", async () => {
    // ADR-0006 [6.3]: a secret registers its value when it is LOADED. This
    // response body is the load. Waiting until saveApp() has encrypted them
    // leaves a window in which the plaintext key is live in memory and unknown to
    // safeMessage() — so anything that throws in that window logs the PEM.
    __resetRegisteredSecrets();
    await convertManifestCode("c", { fetchImpl: fetchReturning(201, conversionBody()) });

    expect(safeMessage(new Error(`write failed: ${PEM}`))).not.toContain(PEM);
    expect(safeMessage(new Error("leak cs_secret_value_here"))).not.toContain("cs_secret_value_here");
    expect(safeMessage(new Error("leak whsec_value_here"))).not.toContain("whsec_value_here");
  });

  it("registers the key even when the response is incomplete and it throws", async () => {
    // The failure path is the one that matters: this is exactly when something is
    // about to be written to a log.
    __resetRegisteredSecrets();
    const fetchImpl = fetchReturning(201, conversionBody({ client_secret: undefined }));
    await expect(convertManifestCode("c", { fetchImpl })).rejects.toThrow();

    expect(safeMessage(new Error(`boom ${PEM}`))).not.toContain(PEM);
  });
});

describe("the routes", () => {
  beforeEach(() => {
    resetDb();
    __resetRegisteredSecrets();
  });
  afterEach(() => __resetRegisteredSecrets());

  function app(over: Parameters<typeof createGithubAppRouter>[0] = {}) {
    const a = express();
    a.use(express.json());
    a.use(
      "/api/github",
      createGithubAppRouter({
        store: () => store(),
        baseUrl: () => "https://d.example.test",
        ...over,
      })
    );
    return a;
  }

  describe("POST /api/github/app/manifest", () => {
    it("returns the action url, the manifest, and a state", async () => {
      await withServer(app(), async (base) => {
        const res = await fetch(`${base}/api/github/app/manifest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Dispatch (acme)", org: "acme" }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { action: string; state: string; manifest: { name: string } };
        expect(body.action).toBe(
          `https://github.com/organizations/acme/settings/apps/new?state=${body.state}`
        );
        expect(body.manifest.name).toBe("Dispatch (acme)");
      });
    });

    it("refuses when no encryption key is configured, rather than registering an App it cannot store", async () => {
      await withServer(app({ store: () => null }), async (base) => {
        const res = await fetch(`${base}/api/github/app/manifest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "x" }),
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain(ENCRYPTION_KEY_ENV);
      });
    });

    it("rejects a blank App name", async () => {
      await withServer(app(), async (base) => {
        const res = await fetch(`${base}/api/github/app/manifest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "   " }),
        });
        expect(res.status).toBe(400);
      });
    });
  });

  describe("GET /api/github/callback", () => {
    /** Issue a real state through the manifest endpoint so the pair is consistent. */
    async function issueState(base: string, org: string | null = null): Promise<string> {
      const res = await fetch(`${base}/api/github/app/manifest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Dispatch", org }),
      });
      return ((await res.json()) as { state: string }).state;
    }

    it("exchanges the code, persists the App, and redirects to the install page", async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify(conversionBody()), { status: 201 })
      ) as unknown as typeof fetch;

      await withServer(app({ fetchImpl }), async (base) => {
        const state = await issueState(base, "acme");
        const res = await fetch(`${base}/api/github/callback?code=abc&state=${state}`, {
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(
          "https://github.com/apps/dispatch-acme/installations/new"
        );
      });

      expect(store().getApp()?.appId).toBe(987654);
    });

    it("rejects a mismatched state without calling GitHub", async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      await withServer(app({ fetchImpl }), async (base) => {
        await issueState(base);
        const res = await fetch(`${base}/api/github/callback?code=abc&state=forged`, {
          redirect: "manual",
        });
        expect(res.status).toBe(400);
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(store().getApp()).toBeNull();
    });

    it("rejects a replayed code — the second callback must not re-register the App", async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify(conversionBody()), { status: 201 })
      ) as unknown as typeof fetch;

      await withServer(app({ fetchImpl }), async (base) => {
        const state = await issueState(base);
        const first = await fetch(`${base}/api/github/callback?code=abc&state=${state}`, {
          redirect: "manual",
        });
        expect(first.status).toBe(302);

        const replay = await fetch(`${base}/api/github/callback?code=abc&state=${state}`, {
          redirect: "manual",
        });
        expect(replay.status).toBe(400);
      });

      // GitHub was asked exactly once, and the App was written exactly once.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("rejects a callback with no code", async () => {
      await withServer(app(), async (base) => {
        const state = await issueState(base);
        const res = await fetch(`${base}/api/github/callback?state=${state}`, { redirect: "manual" });
        expect(res.status).toBe(400);
      });
    });

    it("surfaces a GitHub failure as a 502 without leaking the code", async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ message: "Bad" }), { status: 422 })
      ) as unknown as typeof fetch;

      await withServer(app({ fetchImpl }), async (base) => {
        const state = await issueState(base);
        const res = await fetch(`${base}/api/github/callback?code=supersecretcode&state=${state}`, {
          redirect: "manual",
        });
        expect(res.status).toBe(502);
        expect(await res.text()).not.toContain("supersecretcode");
      });

      expect(store().getApp()).toBeNull();
    });

    it("burns the state even when the exchange fails, so the code cannot be retried", async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ message: "Bad" }), { status: 422 })
      ) as unknown as typeof fetch;

      await withServer(app({ fetchImpl }), async (base) => {
        const state = await issueState(base);
        await fetch(`${base}/api/github/callback?code=c&state=${state}`, { redirect: "manual" });
        const again = await fetch(`${base}/api/github/callback?code=c&state=${state}`, {
          redirect: "manual",
        });
        expect(again.status).toBe(400);
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("invalidates the memoized provider cache when the App is written", async () => {
      const onChange = vi.fn();
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify(conversionBody()), { status: 201 })
      ) as unknown as typeof fetch;

      await withServer(app({ fetchImpl, store: () => store(onChange) }), async (base) => {
        const state = await issueState(base);
        await fetch(`${base}/api/github/callback?code=abc&state=${state}`, { redirect: "manual" });
      });

      expect(onChange).toHaveBeenCalled();
    });
  });
});
