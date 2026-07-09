import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppTokenSource, EnvTokenSource, signAppJwt, JWT_LIFETIME_S, JWT_BACKDATE_S } from "./token-source.js";
import { safeMessage, __resetRegisteredSecrets } from "../lib/redaction.js";

const APP_ID = 12345;
const INSTALLATION_ID = 678;
const HOUR_MS = 60 * 60 * 1000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** A fake clock. `now()` returns ms, like Date.now(). */
function clockAt(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** A fake GitHub token endpoint. Each call issues a distinct token. */
function fakeMint(opts: { expiresInMs?: number; status?: number } = {}) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  let issued = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get("authorization") });
    if (opts.status && opts.status >= 400) {
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: opts.status });
    }
    issued += 1;
    return new Response(
      JSON.stringify({
        token: `ghs_minted_token_${issued}`,
        expires_at: new Date(Date.now() + (opts.expiresInMs ?? HOUR_MS)).toISOString(),
      }),
      { status: 201 }
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function appSource(deps: { fetchImpl: typeof fetch; now: () => number }) {
  return new AppTokenSource(
    { appId: APP_ID, privateKey, installationId: INSTALLATION_ID },
    { fetchImpl: deps.fetchImpl, now: deps.now }
  );
}

describe("signAppJwt", () => {
  it("produces a JWT that verifies under the App's public key", () => {
    const nowMs = 1_700_000_000_000;
    const jwt = signAppJwt(APP_ID, privateKey, nowMs);
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeTruthy();

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    const ok = verifier.verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("backdates iat to absorb clock skew between us and GitHub", () => {
    // GitHub rejects a JWT whose iat is in *its* future. Our clock running a few
    // seconds fast is the common case and it produces a 401 that looks like a bad
    // key. Backdating is the documented remedy, not a superstition.
    const nowMs = 1_700_000_000_000;
    const nowS = Math.floor(nowMs / 1000);
    const payload = JSON.parse(
      Buffer.from(signAppJwt(APP_ID, privateKey, nowMs).split(".")[1], "base64url").toString()
    );

    expect(payload.iat).toBe(nowS - JWT_BACKDATE_S);
    expect(payload.exp).toBe(nowS + JWT_LIFETIME_S);
    expect(payload.iss).toBe(String(APP_ID));
  });

  it("never signs a JWT that outlives GitHub's 10-minute ceiling", () => {
    expect(JWT_LIFETIME_S).toBeLessThanOrEqual(600 - JWT_BACKDATE_S);
  });
});

describe("EnvTokenSource", () => {
  it("returns its token and never mints", async () => {
    const src = new EnvTokenSource("ghp_env_token");
    expect(await src.get()).toBe("ghp_env_token");
    expect(await src.get()).toBe("ghp_env_token");
  });

  it("survives invalidate() — there is nothing to re-mint", async () => {
    const src = new EnvTokenSource("ghp_env_token");
    src.invalidate();
    expect(await src.get()).toBe("ghp_env_token");
  });
});

describe("AppTokenSource", () => {
  beforeEach(() => __resetRegisteredSecrets());
  afterEach(() => __resetRegisteredSecrets());

  it("does not mint until the first get()", () => {
    const mint = fakeMint();
    appSource({ fetchImpl: mint.impl, now: () => Date.now() });
    expect(mint.calls).toHaveLength(0);
  });

  it("mints against the installation's access_tokens endpoint, bearing a signed JWT", async () => {
    const mint = fakeMint();
    const src = appSource({ fetchImpl: mint.impl, now: () => Date.now() });

    expect(await src.get()).toBe("ghs_minted_token_1");
    expect(mint.calls).toHaveLength(1);
    expect(mint.calls[0].url).toBe(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
    );
    expect(mint.calls[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("reuses the cached token while it is comfortably unexpired", async () => {
    const clock = clockAt(Date.now());
    const mint = fakeMint({ expiresInMs: HOUR_MS });
    const src = appSource({ fetchImpl: mint.impl, now: clock.now });

    expect(await src.get()).toBe("ghs_minted_token_1");
    clock.advance(30 * 60 * 1000); // 30 min in, 30 min left
    expect(await src.get()).toBe("ghs_minted_token_1");
    expect(mint.calls).toHaveLength(1);
  });

  it("re-mints once the token is inside the refresh margin", async () => {
    // Refreshing at 59:59 races the request in flight. The margin is the point.
    const clock = clockAt(Date.now());
    const mint = fakeMint({ expiresInMs: HOUR_MS });
    const src = appSource({ fetchImpl: mint.impl, now: clock.now });

    expect(await src.get()).toBe("ghs_minted_token_1");
    clock.advance(55 * 60 * 1000); // 5 min left — inside a 10 min margin
    expect(await src.get()).toBe("ghs_minted_token_2");
    expect(mint.calls).toHaveLength(2);
  });

  it("does not re-mint just outside the refresh margin", async () => {
    const clock = clockAt(Date.now());
    const mint = fakeMint({ expiresInMs: HOUR_MS });
    const src = appSource({ fetchImpl: mint.impl, now: clock.now });

    await src.get();
    clock.advance(49 * 60 * 1000); // 11 min left — outside a 10 min margin
    expect(await src.get()).toBe("ghs_minted_token_1");
    expect(mint.calls).toHaveLength(1);
  });

  it("invalidate() forces exactly one re-mint on the next get()", async () => {
    const clock = clockAt(Date.now());
    const mint = fakeMint({ expiresInMs: HOUR_MS });
    const src = appSource({ fetchImpl: mint.impl, now: clock.now });

    expect(await src.get()).toBe("ghs_minted_token_1");
    src.invalidate();
    expect(await src.get()).toBe("ghs_minted_token_2");
    expect(await src.get()).toBe("ghs_minted_token_2"); // cached again, not re-minted
    expect(mint.calls).toHaveLength(2);
  });

  it("registers the minted token so it can never reach a log line", async () => {
    const mint = fakeMint();
    const src = appSource({ fetchImpl: mint.impl, now: () => Date.now() });
    const token = await src.get();

    expect(safeMessage(new Error(`request failed with ${token}`))).toBe(
      "request failed with «redacted»"
    );
  });

  it("unregisters the superseded token when it re-mints", async () => {
    // Otherwise the redactor accumulates one dead token per hour, forever.
    const clock = clockAt(Date.now());
    const mint = fakeMint({ expiresInMs: HOUR_MS });
    const src = appSource({ fetchImpl: mint.impl, now: clock.now });

    const first = await src.get();
    src.invalidate();
    const second = await src.get();

    expect(safeMessage(`stale ${first}`)).toBe(`stale ${first}`);
    expect(safeMessage(`live ${second}`)).toBe("live «redacted»");
  });

  it("throws on a failed mint without leaking the JWT it presented", async () => {
    const mint = fakeMint({ status: 401 });
    const src = appSource({ fetchImpl: mint.impl, now: () => Date.now() });

    await expect(src.get()).rejects.toThrow(/401/);
    await expect(src.get()).rejects.not.toThrow(/BEGIN|eyJ/); // no PEM, no JWT
  });

  describe("concurrency", () => {
    /** A mint endpoint whose responses are released by hand, so order is controllable. */
    function deferredMint() {
      const releases: Array<(token: string) => void> = [];
      const impl = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releases.push((token) =>
              resolve(
                new Response(
                  JSON.stringify({
                    token,
                    expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
                  }),
                  { status: 201 }
                )
              )
            );
          })
      );
      return { impl: impl as unknown as typeof fetch, releases, calls: impl.mock.calls };
    }

    it("coalesces concurrent get() calls into a single mint", async () => {
      // A poll cycle fans out ~20 requests through one memoized adapter. Twenty
      // mints for one credential is both a stampede on GitHub and the setup for
      // the out-of-order race below.
      const mint = deferredMint();
      const src = appSource({ fetchImpl: mint.impl, now: () => Date.now() });

      const all = Promise.all([src.get(), src.get(), src.get()]);
      await vi.waitFor(() => expect(mint.releases).toHaveLength(1));
      mint.releases[0]("ghs_single_flight");

      expect(await all).toEqual(["ghs_single_flight", "ghs_single_flight", "ghs_single_flight"]);
      expect(mint.calls).toHaveLength(1);
    });

    it("a caller waiting on an in-flight mint never has its token unregistered under it", async () => {
      // The bug this guards. mint() used to unregister `this.token` — a shared
      // field read AFTER its own await — rather than the token it superseded. With
      // two mints in flight, the later-resolving one stripped redaction from the
      // newer token that the other caller was already using, and every log line in
      // the app runs through safeMessage().
      //
      // Single-flight is what makes that unreachable: a second get() during a mint
      // joins the first rather than starting a rival. Asserting it here, on the
      // value the *concurrent caller* holds, is what the old code failed.
      const mint = deferredMint();
      const src = appSource({ fetchImpl: mint.impl, now: () => Date.now() });

      const first = src.get();
      await vi.waitFor(() => expect(mint.releases).toHaveLength(1));
      const joined = src.get(); // arrives mid-mint

      mint.releases[0]("ghs_shared_token");
      const [a, b] = await Promise.all([first, joined]);

      expect(a).toBe(b);
      expect(mint.calls).toHaveLength(1); // no rival mint, so no out-of-order retire
      expect(safeMessage(`still using ${b}`)).toBe("still using «redacted»");
    });

    it("invalidate() from a stale holder does not discard a freshly minted token", async () => {
      // N concurrent requests 401 on one dead token. The first re-mints; the rest
      // must be no-ops, or each discards its predecessor's fresh token forever.
      const clock = clockAt(Date.now());
      const mint = fakeMint({ expiresInMs: HOUR_MS });
      const src = appSource({ fetchImpl: mint.impl, now: clock.now });

      const dead = await src.get(); // ghs_minted_token_1
      src.invalidate(dead); // first 401 handler: legitimate
      const fresh = await src.get(); // ghs_minted_token_2

      src.invalidate(dead); // second 401 handler, still holding the dead token
      src.invalidate(dead); // third

      expect(await src.get()).toBe(fresh);
      expect(mint.calls).toHaveLength(2); // not 4
    });
  });

  it("retries the mint on the next get() after a failure rather than caching the error", async () => {
    let fail = true;
    const impl = vi.fn(async () => {
      if (fail) return new Response("{}", { status: 500 });
      return new Response(
        JSON.stringify({ token: "ghs_after_recovery", expires_at: new Date(Date.now() + HOUR_MS).toISOString() }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const src = appSource({ fetchImpl: impl, now: () => Date.now() });
    await expect(src.get()).rejects.toThrow();
    fail = false;
    expect(await src.get()).toBe("ghs_after_recovery");
  });
});
