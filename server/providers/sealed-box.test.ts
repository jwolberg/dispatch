import { describe, expect, it } from "vitest";
import _sodium from "libsodium-wrappers";
import { sealSecret } from "./sealed-box.js";

// #4 AC 4 — the Claude auth secret is written via GitHub's Secrets API, which
// accepts only libsodium sealed-box ciphertext. Asserting "it returned base64"
// would pass for `Buffer.from(value).toString('base64')`, which GitHub would
// accept the write of and then fail to decrypt — silently, at workflow runtime.
//
// So these tests *open* the ciphertext with the private key. That is the only
// assertion that distinguishes real encryption from an encoding.

async function keypair() {
  await _sodium.ready;
  return { sodium: _sodium, ...(_sodium.crypto_box_keypair() as { publicKey: Uint8Array; privateKey: Uint8Array }) };
}

describe("sealSecret", () => {
  it("produces ciphertext the matching private key can open", async () => {
    const { sodium, publicKey, privateKey } = await keypair();
    const pkB64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);

    const sealed = await sealSecret(pkB64, "sk-ant-oat-hunter2");

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      publicKey,
      privateKey
    );
    expect(sodium.to_string(opened)).toBe("sk-ant-oat-hunter2");
  });

  it("is not merely base64 of the plaintext", async () => {
    const { sodium, publicKey } = await keypair();
    const pkB64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);

    const sealed = await sealSecret(pkB64, "hunter2");
    expect(sealed).not.toBe(Buffer.from("hunter2").toString("base64"));
    expect(Buffer.from(sealed, "base64").toString("utf8")).not.toContain("hunter2");
  });

  it("is anonymous — sealing twice yields different ciphertext", async () => {
    // crypto_box_seal generates a fresh ephemeral keypair per call. Deterministic
    // output would mean the ephemeral key was reused, which leaks.
    const { sodium, publicKey } = await keypair();
    const pkB64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);

    expect(await sealSecret(pkB64, "same")).not.toBe(await sealSecret(pkB64, "same"));
  });

  it("round-trips a value containing every byte class", async () => {
    const { sodium, publicKey, privateKey } = await keypair();
    const pkB64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);
    const value = 'tok_+/=\n"é🔑';

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(await sealSecret(pkB64, value), sodium.base64_variants.ORIGINAL),
      publicKey,
      privateKey
    );
    expect(sodium.to_string(opened)).toBe(value);
  });
});
