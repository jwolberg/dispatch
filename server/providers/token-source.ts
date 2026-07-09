import { createSign } from "node:crypto";
import { registerSecret, unregisterSecret } from "../lib/redaction.js";

/**
 * Where a provider adapter gets its bearer token (#3).
 *
 * Two implementations, and the seam exists so nothing outside `providers/` has
 * to know which one it got:
 *
 *  - {@link EnvTokenSource} — a static `GITHUB_TOKEN`/`GITLAB_TOKEN`. The
 *    documented local path, the whole GitLab story, and the fallback for any
 *    repo with no App installation.
 *  - {@link AppTokenSource} — a GitHub App installation token, minted on demand
 *    and expiring hourly.
 *
 * Hand-rolled rather than `@octokit/auth-app` (decided 2026-07-09): no new
 * dependency, `node:crypto` signs RS256 natively, and the refresh policy below
 * is ours to state and test rather than the library's to imply.
 */
export interface TokenSource {
  /** A currently-valid token, minting or refreshing as needed. */
  get(): Promise<string>;
  /**
   * Discard the cached token; the next `get()` re-mints. Called on a 401.
   *
   * `staleToken` is the token whose request actually failed. Pass it. When many
   * concurrent requests all 401 on the same dead token, the first `invalidate()`
   * re-mints and the rest must become no-ops — otherwise each one throws away the
   * fresh token its predecessor just minted, and the adapter never recovers.
   */
  invalidate(staleToken?: string): void;
}

/** GitHub caps an App JWT at 10 minutes. Stay under it, after backdating. */
export const JWT_LIFETIME_S = 9 * 60;

/**
 * GitHub rejects a JWT whose `iat` is in *its* future. Our clock running a few
 * seconds fast is the ordinary case, and it surfaces as a 401 that reads exactly
 * like a bad private key. Backdating is GitHub's documented remedy.
 */
export const JWT_BACKDATE_S = 60;

/** An installation token is good for an hour. Refresh with this much to spare. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

const GITHUB_API = "https://api.github.com";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign the App-level JWT that authenticates a mint request. */
export function signAppJwt(appId: number, privateKey: string, nowMs: number): string {
  const nowS = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iat: nowS - JWT_BACKDATE_S,
      exp: nowS + JWT_LIFETIME_S,
      iss: String(appId),
    })
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, "base64url")}`;
}

export class EnvTokenSource implements TokenSource {
  constructor(private readonly token: string) {}

  async get(): Promise<string> {
    return this.token;
  }

  /** Nothing to re-mint — a PAT is whatever the environment says it is. */
  invalidate(_staleToken?: string): void {}
}

export interface AppCredentials {
  appId: number;
  privateKey: string;
  installationId: number;
}

export interface AppTokenSourceDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Override for GitHub Enterprise. */
  apiBase?: string;
}

interface MintResponse {
  token?: string;
  expires_at?: string;
}

export class AppTokenSource implements TokenSource {
  private token: string | null = null;
  private expiresAtMs = 0;

  /**
   * The mint currently in flight, if any. Without this, a poll cycle firing
   * twenty concurrent requests as the token crosses the refresh margin sends
   * twenty POSTs to GitHub — and, worse, twenty `mint()` bodies race on
   * `this.token`, so a late one can unregister a *newer* token that another
   * caller is already using. See the "concurrent" tests.
   */
  private inflight: Promise<string> | null = null;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly apiBase: string;

  constructor(
    private readonly creds: AppCredentials,
    deps: AppTokenSourceDeps = {}
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.apiBase = deps.apiBase ?? GITHUB_API;
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAtMs - REFRESH_MARGIN_MS) return this.token;
    // Every concurrent caller awaits the one mint, and all of them get its token.
    this.inflight ??= this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Drop the cached token so the next `get()` re-mints.
   *
   * `staleToken` guards against the concurrent-401 stampede: N in-flight requests
   * bearing one dead token all fail, all call `invalidate()`, and only the caller
   * holding the token we currently believe in is allowed to discard it. Without
   * the guard, caller 2 discards the token caller 1 just minted, caller 3
   * discards caller 2's, and the adapter mints forever without converging.
   */
  invalidate(staleToken?: string): void {
    if (staleToken !== undefined && staleToken !== this.token) return;
    this.drop(this.token);
  }

  /**
   * Unregister a *specific* token value and clear the cache if it is still the
   * current one.
   *
   * Taking the value as a parameter rather than reading `this.token` is the whole
   * fix: `mint()` must retire the token *it* superseded, not whatever happens to
   * be in the field by the time its fetch resolves.
   *
   * Dropping the predecessor is not housekeeping — without it the redactor's
   * registry gains an entry every hour for the life of the process.
   */
  private drop(token: string | null): void {
    unregisterSecret(token);
    if (this.token === token) {
      this.token = null;
      this.expiresAtMs = 0;
    }
  }

  private async mint(): Promise<string> {
    const superseded = this.token; // captured now, not read after the await
    const url = `${this.apiBase}/app/installations/${this.creds.installationId}/access_tokens`;
    const jwt = signAppJwt(this.creds.appId, this.creds.privateKey, this.now());

    // The JWT is itself a credential, for the ~9 minutes it lives. Keep it out of
    // any error message raised while it is in flight.
    registerSecret(jwt);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!res.ok) {
        // Leave the previous token in place rather than caching the failure — the
        // next get() retries, which is what a transient 500 deserves.
        throw new Error(`installation token mint failed: ${res.status}`);
      }

      const body = (await res.json()) as MintResponse;
      if (!body.token || !body.expires_at) {
        throw new Error("installation token mint returned no token");
      }

      this.drop(superseded);
      this.token = body.token;
      this.expiresAtMs = Date.parse(body.expires_at);
      registerSecret(this.token);
      return this.token;
    } finally {
      unregisterSecret(jwt);
    }
  }
}
