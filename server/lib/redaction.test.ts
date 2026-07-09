import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  redactSecrets,
  safeMessage,
  registerSecret,
  unregisterSecret,
  __resetRegisteredSecrets,
} from "./redaction.js";

const REDACTED = "«redacted»";

describe("redactSecrets", () => {
  beforeEach(() => __resetRegisteredSecrets());
  afterEach(() => __resetRegisteredSecrets());

  describe("env-scanned secrets (existing behavior, must not regress)", () => {
    const original = process.env.GITHUB_TOKEN;
    afterEach(() => {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    });

    it("redacts a value read from process.env", () => {
      process.env.GITHUB_TOKEN = "ghp_env_token_value";
      expect(redactSecrets("auth failed for ghp_env_token_value")).toBe(`auth failed for ${REDACTED}`);
    });

    it("leaves a message alone when the env secret is unset", () => {
      delete process.env.GITHUB_TOKEN;
      expect(redactSecrets("auth failed for ghp_env_token_value")).toBe(
        "auth failed for ghp_env_token_value"
      );
    });
  });

  describe("registered secrets (#3 — a minted installation token never reaches process.env)", () => {
    it("redacts a registered value that appears nowhere in process.env", () => {
      const minted = "ghs_installation_token_abc123";
      expect(Object.values(process.env)).not.toContain(minted);

      registerSecret(minted);

      expect(redactSecrets(`GET /repos failed: bad credentials (${minted})`)).toBe(
        `GET /repos failed: bad credentials (${REDACTED})`
      );
    });

    it("redacts every occurrence, not just the first", () => {
      registerSecret("ghs_token");
      expect(redactSecrets("ghs_token then ghs_token")).toBe(`${REDACTED} then ${REDACTED}`);
    });

    it("redacts several registered secrets in one message", () => {
      registerSecret("ghs_one_token");
      registerSecret("ghs_two_token");
      expect(redactSecrets("ghs_one_token and ghs_two_token")).toBe(`${REDACTED} and ${REDACTED}`);
    });

    it("stops redacting a value once it is unregistered", () => {
      // A refreshed installation token replaces its predecessor. Without this the
      // registry grows without bound across a long-lived process (a token per hour).
      registerSecret("ghs_expired_token");
      unregisterSecret("ghs_expired_token");
      expect(redactSecrets("stale: ghs_expired_token")).toBe("stale: ghs_expired_token");
    });

    it("ignores values too short to be a credential", () => {
      // Guarding this matters: registering "a" would redact every letter 'a' in
      // every log line the process ever writes.
      registerSecret("abc");
      registerSecret("");
      expect(redactSecrets("a basic cab")).toBe("a basic cab");
    });

    it("ignores null and undefined", () => {
      expect(() => registerSecret(null)).not.toThrow();
      expect(() => registerSecret(undefined)).not.toThrow();
      expect(redactSecrets("nothing to redact")).toBe("nothing to redact");
    });
  });
});

describe("safeMessage", () => {
  beforeEach(() => __resetRegisteredSecrets());
  afterEach(() => __resetRegisteredSecrets());

  it("redacts a registered token embedded in a thrown Error", () => {
    const minted = "ghs_installation_token_xyz789";
    registerSecret(minted);
    const err = new Error(`request failed: Authorization: Bearer ${minted}`);
    expect(safeMessage(err)).toBe(`request failed: Authorization: Bearer ${REDACTED}`);
  });

  it("redacts a registered token thrown as a bare string", () => {
    registerSecret("ghs_bare_throw_token");
    expect(safeMessage("ghs_bare_throw_token leaked")).toBe(`${REDACTED} leaked`);
  });
});
