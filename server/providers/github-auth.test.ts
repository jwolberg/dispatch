import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "./github.js";
import { EnvTokenSource, type TokenSource } from "./token-source.js";

/**
 * The adapter is memoized for the life of the process but an installation token
 * expires hourly, so auth must resolve per request rather than at construction.
 * These tests drive the two request hooks that make that true.
 */

const RATE_LIMIT_BODY = JSON.stringify({
  resources: { core: { limit: 5000, remaining: 4999, reset: 1_700_000_000 } },
});

function okRateLimit() {
  return new Response(RATE_LIMIT_BODY, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized() {
  return new Response(JSON.stringify({ message: "Bad credentials" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/** A TokenSource whose value changes on invalidate(), so a retry is observable. */
function rotatingSource(): TokenSource & { invalidations: number } {
  let n = 1;
  return {
    invalidations: 0,
    async get() {
      return `tok_${n}`;
    },
    invalidate() {
      this.invalidations += 1;
      n += 1;
    },
  };
}

function authHeadersOf(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization") ?? "");
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHubProvider auth hooks", () => {
  it("resolves the token per request rather than baking it in at construction", async () => {
    const fetchMock = vi.fn(async () => okRateLimit());
    vi.stubGlobal("fetch", fetchMock);

    let current = "first_token";
    const src: TokenSource = { get: async () => current, invalidate: () => {} };
    const provider = new GitHubProvider(src);

    await provider.getRateLimit();
    current = "rotated_token"; // as a refresh would do, an hour in
    await provider.getRateLimit();

    expect(authHeadersOf(fetchMock)).toEqual(["token first_token", "token rotated_token"]);
  });

  it("sends the env token on the PAT path", async () => {
    const fetchMock = vi.fn(async () => okRateLimit());
    vi.stubGlobal("fetch", fetchMock);

    await new GitHubProvider(new EnvTokenSource("ghp_pat")).getRateLimit();

    expect(authHeadersOf(fetchMock)).toEqual(["token ghp_pat"]);
  });

  it("re-mints and retries exactly once on a 401", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(okRateLimit());
    vi.stubGlobal("fetch", fetchMock);

    const src = rotatingSource();
    const rl = await new GitHubProvider(src).getRateLimit();

    expect(rl.remaining).toBe(4999);
    expect(src.invalidations).toBe(1);
    expect(authHeadersOf(fetchMock)).toEqual(["token tok_1", "token tok_2"]);
  });

  it("surfaces a second 401 instead of retrying forever", async () => {
    const fetchMock = vi.fn(async () => unauthorized());
    vi.stubGlobal("fetch", fetchMock);

    const src = rotatingSource();
    await expect(new GitHubProvider(src).getRateLimit()).rejects.toThrow();

    expect(src.invalidations).toBe(1); // invalidated once, not once per attempt
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not invalidate the token on a non-401 failure", async () => {
    // A 404 or a 500 says nothing about the credential. Re-minting on every error
    // would hammer the token endpoint during an outage.
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const src = rotatingSource();
    await expect(new GitHubProvider(src).getRateLimit()).rejects.toThrow();

    expect(src.invalidations).toBe(0);
  });
});
