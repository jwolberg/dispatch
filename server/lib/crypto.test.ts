import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ENCRYPTION_KEY_ENV,
  decryptSecret,
  encryptSecret,
  loadEncryptionKey,
  safeEqual,
} from "./crypto.js";

/** A well-formed key, as `openssl rand -base64 32` would produce it. */
function freshKeyB64(): string {
  return randomBytes(32).toString("base64");
}

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAxfakefakefakefakefakefakefakefakefakefakefakefake",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("loadEncryptionKey", () => {
  it("decodes a 32-byte base64 key", () => {
    const b64 = freshKeyB64();
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: b64 });
    expect(key).toHaveLength(32);
    expect(key.toString("base64")).toBe(b64);
  });

  it("refuses a missing key, and names the variable and how to make one", () => {
    // The failure mode this guards is silent plaintext storage of an App private
    // key. It must be loud, and it must tell the operator what to do.
    expect(() => loadEncryptionKey({})).toThrow(/DISPATCH_ENCRYPTION_KEY/);
    expect(() => loadEncryptionKey({})).toThrow(/openssl rand -base64 32/);
  });

  it("refuses an empty or whitespace-only key", () => {
    expect(() => loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: "" })).toThrow(/DISPATCH_ENCRYPTION_KEY/);
    expect(() => loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: "   " })).toThrow(
      /DISPATCH_ENCRYPTION_KEY/
    );
  });

  it("refuses a key that is not 32 bytes, and says how long it actually was", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: short })).toThrow(/32 bytes/);
    expect(() => loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: short })).toThrow(/16/);

    const long = randomBytes(64).toString("base64");
    expect(() => loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: long })).toThrow(/32 bytes/);
  });

  it("refuses a key that is not valid base64", () => {
    // "!!!!" decodes to empty under Node's lenient base64, which would otherwise
    // sail through as a 0-byte key. Reject on the round-trip, not on the decode.
    expect(() => loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: "!!!!" })).toThrow(/base64/);
  });

  it("never echoes the key value in the error it throws", () => {
    const short = randomBytes(16).toString("base64");
    try {
      loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: short });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a PEM private key", () => {
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    expect(decryptSecret(encryptSecret(PEM, key), key)).toBe(PEM);
  });

  it("round-trips unicode and empty strings", () => {
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    expect(decryptSecret(encryptSecret("héllo — 🔑", key), key)).toBe("héllo — 🔑");
    expect(decryptSecret(encryptSecret("", key), key)).toBe("");
  });

  it("produces a versioned envelope, and never the plaintext", () => {
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    const envelope = encryptSecret(PEM, key);

    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope.split(".")).toHaveLength(4); // v1.iv.tag.ciphertext
    expect(envelope).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(envelope).not.toContain(PEM);
  });

  it("uses a fresh IV per call, so the same plaintext never encrypts alike", () => {
    // GCM catastrophically loses confidentiality on IV reuse under one key. This
    // asserts the IV is random per call, not derived or fixed.
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    const a = encryptSecret(PEM, key);
    const b = encryptSecret(PEM, key);

    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(decryptSecret(a, key)).toBe(decryptSecret(b, key));
  });

  it("refuses to decrypt under the wrong key", () => {
    const k1 = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    const k2 = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    expect(() => decryptSecret(encryptSecret(PEM, k1), k2)).toThrow();
  });

  it("refuses a tampered ciphertext", () => {
    // The auth tag is the reason to prefer GCM over CBC here: the snapshot in GCS
    // is a file someone could in principle edit, and a silently-mangled private
    // key is indistinguishable from a rotated one.
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    const [v, iv, tag, ct] = encryptSecret(PEM, key).split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 0x01;

    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), key)).toThrow();
  });

  it("refuses a tampered auth tag", () => {
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    const [v, iv, tag, ct] = encryptSecret(PEM, key).split(".");
    const flipped = Buffer.from(tag, "base64url");
    flipped[0] ^= 0x01;

    expect(() => decryptSecret([v, iv, flipped.toString("base64url"), ct].join("."), key)).toThrow();
  });

  it("refuses an unknown envelope version", () => {
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    const rest = encryptSecret(PEM, key).split(".").slice(1).join(".");
    expect(() => decryptSecret(`v2.${rest}`, key)).toThrow(/version/i);
  });

  it("refuses a malformed envelope rather than reading past its end", () => {
    const key = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    expect(() => decryptSecret("", key)).toThrow();
    expect(() => decryptSecret("v1.", key)).toThrow();
    expect(() => decryptSecret("v1.aaaa.bbbb", key)).toThrow();
    expect(() => decryptSecret("not-an-envelope", key)).toThrow();
    // A plaintext PEM that somehow reached the column must fail closed, not be
    // returned as if it had been decrypted.
    expect(() => decryptSecret(PEM, key)).toThrow();
  });

  it("never echoes the plaintext or the key in a decryption error", () => {
    const k1 = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: freshKeyB64() });
    const k2b64 = freshKeyB64();
    const k2 = loadEncryptionKey({ [ENCRYPTION_KEY_ENV]: k2b64 });
    try {
      decryptSecret(encryptSecret(PEM, k1), k2);
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(PEM);
      expect(msg).not.toContain(k2b64);
    }
  });
});

describe("safeEqual", () => {
  it("matches identical strings", () => {
    expect(safeEqual("state-abc123", "state-abc123")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(safeEqual("state-abc123", "state-abc124")).toBe(false);
  });

  it("rejects strings of different length without throwing", () => {
    // timingSafeEqual() throws on a length mismatch. A CSRF `state` comparison is
    // reached with attacker-controlled input, so this must return false, not 500.
    expect(safeEqual("short", "considerably-longer")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });

  it("matches two empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
  });

  it("compares by bytes, not by code units", () => {
    expect(safeEqual("é", "é")).toBe(true);
    expect(safeEqual("é", "e")).toBe(false);
  });
});
