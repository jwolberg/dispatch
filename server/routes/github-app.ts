import { Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import {
  openInstallationStore,
  type AppRecord,
  type InstallationRecord,
  type SqliteInstallationStore,
} from "../db/installations.js";
import { resetProviderCache } from "../providers/index.js";
import { flush } from "../db/snapshot.js";
import { AppTokenSource, signAppJwt } from "../providers/token-source.js";
import { ENCRYPTION_KEY_ENV } from "../lib/crypto.js";
import { registerSecret, safeMessage, unregisterSecret } from "../lib/redaction.js";

// GitHub App registration via the manifest flow (#2, ADR-0006 [5]).
//
// Dispatch is a public repo that anyone deploys for themselves, so there is no
// central Dispatch App. Each operator registers their own from their own
// instance: we serve a manifest, GitHub redirects back with a temporary code, and
// we exchange it once for the App's credentials.
//
// Every external detail below was verified against GitHub's OpenAPI description
// and three live Apps before being written down, because ADR-0006's prose
// description of this flow was wrong in three places — see the correction note in
// that ADR. In particular there is no `?org=` parameter, `webhook_secret` is
// nullable, and GitHub never promises the code is single-use.

const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";

/**
 * GitHub documents the manifest flow as "complete all three steps within one
 * hour". A pending registration older than that cannot be completed anyway.
 */
const STATE_TTL_MS = 60 * 60 * 1000;

/**
 * Exactly the access #2 specifies, and no more. Every key and value was checked
 * against the `app-permissions` schema in GitHub's OpenAPI description:
 *
 *  - `pull_requests: write` — Dispatch's server opens the PR now (ADR-0006 [2]).
 *  - `contents`, `workflows`, `secrets: write` — #4's setup commits and the one
 *    remaining repo secret (the Claude auth token).
 *  - `issues: write` — filing tickets.
 *  - `actions: read` — reading workflow runs for the board.
 *  - `metadata: read` — mandatory for every App.
 *
 * `workflows` accepts only `write`; its enum has no `read`.
 */
export const APP_PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  workflows: "write",
  secrets: "write",
  actions: "read",
  metadata: "read",
} as const;

export interface GitHubAppManifest {
  name: string;
  url: string;
  /** Omitted when the deployment is not publicly reachable — see {@link isPubliclyReachable}. */
  hook_attributes?: { url: string; active: boolean };
  redirect_url: string;
  setup_url: string;
  description: string;
  public: boolean;
  default_events: string[];
  default_permissions: typeof APP_PERMISSIONS;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Loopback, link-local, and the RFC1918 blocks. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;

  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127) return true; // 127.0.0.0/8, the whole loopback block
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — NOT 172.15 or 172.32
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Can GitHub's servers POST to this origin?
 *
 * **Observed 2026-07-10**, registering from a laptop:
 *
 * > Error Hook url is not supported because it isn't reachable over the public
 * > Internet (127.0.0.1) — Error Hook is invalid
 *
 * GitHub validates `hook_attributes.url` **even when `active` is false**. The
 * manifest is rejected outright, so a localhost deployment could not register an
 * App at all — which would make the whole browser-native onboarding story
 * untestable without a tunnel.
 *
 * Nothing else in the flow needs a public URL: `redirect_url` and `setup_url` are
 * browser redirects, and every other call is outbound. Only the webhook is inbound,
 * and it is the only thing we drop.
 */
export function isPubliclyReachable(baseUrl: string): boolean {
  try {
    return !isPrivateHost(new URL(baseUrl).hostname);
  } catch {
    return false; // unparseable → assume we cannot be reached
  }
}

/**
 * The manifest the operator's browser POSTs to GitHub.
 *
 * `url` is the only field GitHub requires. The App is registered **private**
 * (`public: false`) — a public App could be installed by anyone on their own
 * repos, which is not what "register your own instance's App" means.
 *
 * `hook_attributes` is included **only when this deployment is reachable from the
 * public internet**, because GitHub validates the hook URL at registration time
 * regardless of `active` (see {@link isPubliclyReachable}). When present it is
 * declared inactive: nothing verifies its signatures until #17 lands, and an App
 * delivering to an endpoint that does not exist yet is a queue of failed
 * deliveries. When absent the App simply has no webhook, which is exactly right
 * for a laptop — and #17 can add one later without re-registering.
 */
export function buildManifest(opts: { name: string; baseUrl: string; description?: string }): GitHubAppManifest {
  const base = trimSlash(opts.baseUrl);
  const manifest: GitHubAppManifest = {
    name: opts.name,
    url: base,
    redirect_url: `${base}/api/github/callback`,
    setup_url: `${base}/api/github/installed`,
    description: opts.description ?? "Dispatch — browser-native agent control plane.",
    public: false,
    default_events: [],
    default_permissions: APP_PERMISSIONS,
  };

  if (isPubliclyReachable(base)) {
    manifest.hook_attributes = { url: `${base}/api/webhooks/github`, active: false };
  }
  return manifest;
}

/**
 * Where the manifest form POSTs. Ownership is chosen by the **path**, not by a
 * query parameter — `?org=` does not exist, and sending it to the personal path
 * would quietly register the App on the operator's personal account while looking
 * like it had worked.
 */
export function manifestActionUrl(org: string | null | undefined, state: string): string {
  const q = `?state=${encodeURIComponent(state)}`;
  if (!org) return `${GITHUB_WEB}/settings/apps/new${q}`;

  // An org containing a slash or a traversal segment would rewrite the path.
  if (!/^[A-Za-z0-9-_. ]+$/.test(org)) {
    throw new Error(`Invalid GitHub org name: ${JSON.stringify(org)}`);
  }
  return `${GITHUB_WEB}/organizations/${encodeURIComponent(org)}/settings/apps/new${q}`;
}

export interface PendingRegistration {
  org: string | null;
}

/**
 * The CSRF `state` for an in-flight registration, and the reason the callback is
 * one-shot.
 *
 * GitHub says the manifest code is valid for an hour; it never says the code is
 * single-use. So Dispatch enforces that itself: a state is consumed on first
 * presentation, and a replayed callback URL finds nothing to consume.
 *
 * In memory, not in SQLite. A registration in flight across a process restart is
 * simply retried from the setup screen — cheaper than a table whose only rows
 * live for under an hour.
 */
export class PendingRegistrations {
  private readonly pending = new Map<string, { rec: PendingRegistration; expiresAt: number }>();
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  issue(rec: PendingRegistration): string {
    this.sweep();
    const state = randomBytes(24).toString("base64url"); // 32 chars, 192 bits
    this.pending.set(state, { rec, expiresAt: this.now() + STATE_TTL_MS });
    return state;
  }

  /** Returns the registration and forgets it, or null for unknown/expired/replayed. */
  consume(state: string): PendingRegistration | null {
    const entry = this.pending.get(state);
    if (!entry) return null;
    this.pending.delete(state);
    return this.now() > entry.expiresAt ? null : entry.rec;
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (now > entry.expiresAt) this.pending.delete(state);
    }
  }
}

interface ConversionResponse {
  id?: number;
  slug?: string;
  name?: string;
  html_url?: string;
  client_id?: string;
  client_secret?: string;
  /** Nullable, per GitHub's schema. */
  webhook_secret?: string | null;
  pem?: string;
}

/**
 * Exchange the temporary manifest code for the App's credentials.
 *
 * The 201 body carries the private key. Any error raised from here must not, so
 * failures are re-thrown with a message built from the status alone — never from
 * the body.
 */
export async function convertManifestCode(
  code: string,
  deps: { fetchImpl?: typeof fetch; apiBase?: string } = {}
): Promise<AppRecord> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = deps.apiBase ?? GITHUB_API;

  const res = await fetchImpl(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub rejected the App manifest code: ${res.status}`);
  }

  const body = (await res.json()) as ConversionResponse;

  // Register the credentials with the redactor the moment they exist, not when
  // they are later read back out of SQLite (ADR-0006 [6.3]: "secrets register
  // their values when they are loaded"). This response body IS the load.
  //
  // Without this there is a window — from here until saveApp() encrypts them —
  // where the plaintext private key is live in memory and unknown to
  // safeMessage(). Anything that throws in that window (a disk error, a
  // constraint violation) can carry the PEM into a log line or a 502 body.
  registerSecret(body.pem);
  registerSecret(body.client_secret);
  registerSecret(body.webhook_secret);

  // `webhook_secret` may legitimately be null. Everything else is required by the
  // response schema, and a blank credential stored now is a 401 an hour from now.
  if (!body.id || !body.pem || !body.client_id || !body.client_secret || !body.slug) {
    throw new Error("GitHub returned an incomplete App manifest conversion (missing credentials)");
  }

  return {
    appId: body.id,
    slug: body.slug,
    name: body.name ?? body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    privateKey: body.pem,
    webhookSecret: body.webhook_secret ?? null,
    htmlUrl: body.html_url ?? null,
  };
}

/**
 * A 'selected' installation with more repos than this is not enumerated further.
 * 10 pages of 100. Beyond that the operator is better served by switching the
 * installation to "all repositories" than by us paging forever on a setup click.
 */
const MAX_REPO_PAGES = 10;

interface InstallationResponse {
  account?: { login?: string; type?: string } | null;
  repository_selection?: string;
}

/**
 * Ask GitHub what an installation covers: whose account, and which repos.
 *
 * Two credentials, and they are not interchangeable. Reading the *installation*
 * is an App-level call, authenticated with the App JWT. Listing the repositories
 * that installation was granted is an *installation*-level call, and needs a
 * minted installation token — the App JWT is rejected there.
 *
 * When the selection is `all`, the repo list is deliberately left empty rather
 * than enumerated: an 'all' installation covers every repo on the account
 * including ones created tomorrow, so a snapshot would be wrong by the next push.
 * `forRepo()` reads `repositorySelection` and only consults the list for
 * `selected`.
 */
export async function fetchInstallationRecord(
  app: AppRecord,
  installationId: number,
  deps: { fetchImpl?: typeof fetch; apiBase?: string; now?: () => number } = {}
): Promise<InstallationRecord> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = deps.apiBase ?? GITHUB_API;
  const now = deps.now ?? Date.now;

  const jwt = signAppJwt(app.appId, app.privateKey, now());
  registerSecret(jwt); // a bearer credential for ~9 minutes
  let installation: InstallationResponse;
  try {
    const res = await fetchImpl(`${apiBase}/app/installations/${installationId}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GitHub rejected the installation lookup: ${res.status}`);
    installation = (await res.json()) as InstallationResponse;
  } finally {
    unregisterSecret(jwt);
  }

  const selection = installation.repository_selection === "selected" ? "selected" : "all";
  const repos = selection === "selected"
    ? await listInstallationRepos(app, installationId, { fetchImpl, apiBase, now })
    : [];

  return {
    installationId,
    accountLogin: installation.account?.login ?? "",
    accountType: installation.account?.type ?? null,
    repositorySelection: selection,
    repos,
  };
}

async function listInstallationRepos(
  app: AppRecord,
  installationId: number,
  deps: { fetchImpl: typeof fetch; apiBase: string; now: () => number }
): Promise<string[]> {
  // AppTokenSource registers and retires the minted token with the redactor, and
  // mints exactly once for this burst of pages.
  const tokens = new AppTokenSource(
    { appId: app.appId, privateKey: app.privateKey, installationId },
    { fetchImpl: deps.fetchImpl, now: deps.now, apiBase: deps.apiBase }
  );

  const names: string[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const token = await tokens.get();
    const res = await deps.fetchImpl(
      `${deps.apiBase}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub rejected the repository listing: ${res.status}`);

    const body = (await res.json()) as { repositories?: Array<{ full_name?: string }> };
    const batch = (body.repositories ?? []).map((r) => r.full_name).filter((n): n is string => !!n);
    names.push(...batch);
    if (batch.length < 100) return names;
  }

  console.warn(
    `[dispatch] installation ${installationId} has more than ${MAX_REPO_PAGES * 100} selected ` +
      `repositories; the rest will fall back to GITHUB_TOKEN. Switch the installation to ` +
      `"all repositories" instead.`
  );
  return names;
}

export interface GithubAppDeps {
  /** Null when DISPATCH_ENCRYPTION_KEY is unset — we cannot store what we register. */
  store: () => SqliteInstallationStore | null;
  fetchImpl: typeof fetch;
  baseUrl: (req: Request) => string;
  pending: PendingRegistrations;
  /** See {@link persist}. Injected so tests can observe it without a bucket. */
  flushSnapshot: () => Promise<void>;
}

/**
 * Upload a snapshot now, rather than waiting for `snapshotMiddleware`.
 *
 * Both write paths in this router are **GET** requests — GitHub redirects the
 * operator's browser to `redirect_url` and `setup_url` — and the middleware
 * short-circuits on GET/HEAD, because a board poll must not cost an upload. So
 * nothing would ever persist a registration: the next Cloud Run redeploy restores
 * a snapshot that has never heard of the App, Dispatch boots clean, and silently
 * falls back to `GITHUB_TOKEN`.
 *
 * A failed upload must not fail the operator's install. The row is committed
 * locally either way and stays dirty, so the next mutating request retries.
 */
async function persist(flushSnapshot: () => Promise<void>): Promise<void> {
  try {
    await flushSnapshot();
  } catch (err) {
    console.warn(`[dispatch] snapshot upload failed: ${safeMessage(err)}`);
  }
}

/** The deployment's own public origin, which the manifest's URLs must point at. */
function defaultBaseUrl(req: Request): string {
  const configured = process.env.DISPATCH_PUBLIC_URL?.trim();
  if (configured) return trimSlash(configured);
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

export function createGithubAppRouter(deps: Partial<GithubAppDeps> = {}): Router {
  const store = deps.store ?? (() => openInstallationStore(process.env, resetProviderCache));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.baseUrl ?? defaultBaseUrl;
  const pending = deps.pending ?? new PendingRegistrations();
  const flushSnapshot = deps.flushSnapshot ?? flush;

  const router = Router();

  // What the setup screen renders. Deliberately a hand-built projection, not a
  // filtered AppRecord: adding a field here has to be a decision, so a future
  // credential added to AppRecord cannot leak by being spread into a response.
  router.get("/app", (_req, res) => {
    const installations = store();
    if (!installations) {
      res.json({ registered: false, encryptionKeyConfigured: false, installations: [] });
      return;
    }

    const app = installations.getApp();
    res.json({
      registered: !!app,
      encryptionKeyConfigured: true,
      app: app
        ? { appId: app.appId, slug: app.slug, name: app.name, htmlUrl: app.htmlUrl ?? null }
        : null,
      installUrl: app ? `${GITHUB_WEB}/apps/${encodeURIComponent(app.slug)}/installations/new` : null,
      installations: installations.listInstallations().map((i) => ({
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        accountType: i.accountType,
        repositorySelection: i.repositorySelection,
        repoCount: i.repos.length,
      })),
    });
  });

  // Step 1. Hand the browser a manifest and the action URL to POST it to. The
  // operator's click on GitHub's own page is the escalating-cost action, and it
  // never leaves their hands (ADR-0006 [5]).
  router.post("/app/manifest", (req, res) => {
    if (!store()) {
      res.status(400).json({
        error:
          `Set ${ENCRYPTION_KEY_ENV} before registering a GitHub App. Its private key is ` +
          `stored in SQLite and must be encrypted at rest. Generate one with: openssl rand -base64 32`,
      });
      return;
    }

    const body = req.body as { name?: unknown; org?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const org = typeof body.org === "string" && body.org.trim() ? body.org.trim() : null;
    if (!name) {
      res.status(400).json({ error: "An App name is required." });
      return;
    }

    let action: string;
    try {
      const state = pending.issue({ org });
      action = manifestActionUrl(org, state);
      res.json({ action, state, manifest: buildManifest({ name, baseUrl: baseUrl(req) }) });
    } catch (err) {
      res.status(400).json({ error: safeMessage(err) });
    }
  });

  // Step 3. GitHub redirects here with the temporary code. Consume the state
  // FIRST — before any network call — so a replayed callback cannot re-exchange,
  // and so a failed exchange cannot be retried with the same code.
  router.get("/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    const registration = state ? pending.consume(state) : null;
    if (!registration) {
      res.status(400).json({ error: "Unrecognized, expired, or already-used registration state." });
      return;
    }
    if (!code) {
      res.status(400).json({ error: "GitHub did not return a manifest code." });
      return;
    }

    const installations = store();
    if (!installations) {
      res.status(400).json({ error: `Set ${ENCRYPTION_KEY_ENV} before registering a GitHub App.` });
      return;
    }

    try {
      const app = await convertManifestCode(code, { fetchImpl });
      installations.saveApp(app); // fires onChange → resetProviderCache(), markDirty()
      await persist(flushSnapshot);
      res.redirect(302, `${GITHUB_WEB}/apps/${encodeURIComponent(app.slug)}/installations/new`);
    } catch (err) {
      // safeMessage, not the raw error: the conversion body carries the private key.
      res.status(502).json({ error: safeMessage(err) });
    }
  });

  // Step 4. GitHub's `setup_url` — the operator has installed the App, and we
  // record which account and repos the installation covers. Until this row
  // exists, `forRepo()` returns null and every repo keeps using GITHUB_TOKEN.
  router.get("/installed", async (req, res) => {
    // A non-admin asking an org owner to approve the install. There is no
    // installation yet; writing a row now would invent one.
    if (req.query.setup_action === "request") {
      res.redirect(302, "/repos?install=pending");
      return;
    }

    const installations = store();
    if (!installations) {
      res.status(400).json({ error: `Set ${ENCRYPTION_KEY_ENV} before installing the GitHub App.` });
      return;
    }

    const app = installations.getApp();
    if (!app) {
      res.status(400).json({ error: "No GitHub App is registered on this deployment yet." });
      return;
    }

    const installationId = Number(req.query.installation_id);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      res.status(400).json({ error: "GitHub did not return a valid installation_id." });
      return;
    }

    try {
      const record = await fetchInstallationRecord(app, installationId, { fetchImpl });
      installations.saveInstallation(record); // fires onChange → resetProviderCache(), markDirty()
      await persist(flushSnapshot);
      res.redirect(302, `/repos?installed=${installationId}`);
    } catch (err) {
      res.status(502).json({ error: safeMessage(err) });
    }
  });

  return router;
}

export const githubAppRouter = createGithubAppRouter();
