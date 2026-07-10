import _sodium from "libsodium-wrappers";

/**
 * GitHub's Secrets API accepts only values encrypted with the repository's public
 * key using libsodium's **sealed box** (`crypto_box_seal`): an anonymous
 * X25519 + XSalsa20-Poly1305 construction where the sender is ephemeral, so only the
 * holder of the private key can open it — and GitHub never gives that out.
 *
 * Node's `crypto` cannot do this. It has X25519, but no XSalsa20 and no 24-byte
 * Blake2b (the sealed-box nonce is `blake2b(ephemeral_pk ‖ recipient_pk, 24)`).
 * Hence `libsodium-wrappers`, which GitHub's own documentation prescribes. It is
 * pure WASM — no native build, which matters for the Cloud Run image.
 *
 * The WASM module initializes asynchronously; `ready` is awaited on every call and
 * resolves instantly once warm.
 */
export async function sealSecret(publicKeyBase64: string, value: string): Promise<string> {
  await _sodium.ready;
  const sodium = _sodium;

  const publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), publicKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
