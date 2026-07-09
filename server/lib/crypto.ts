import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope encryption for the one confidential column in SQLite: the GitHub App
// private key (#2, ADR-0006 [6.2]).
//
// Why this exists at all. `server/db/snapshot.ts` does `VACUUM INTO` a temp file
// and uploads the resulting bytes to GCS — the whole database, verbatim. The
// bucket is locked down, but `DEPLOY.md` enables object versioning on purpose, so
// anything written there is readable in an old object version until a lifecycle
// rule expires it. Encrypting the column means the ciphertext is what leaves the
// process, and a rotated key stops mattering once the snapshot that held it ages
// out.
//
// Why not GCP Secret Manager: it needs `roles/secretmanager.admin` on the runtime
// service account, and it couples a deploy-anywhere tool to one cloud.
// ADR-0006 [6.1] rejects it on both grounds.
//
// AES-256-GCM, from `node:crypto`. No new dependency. GCM rather than CBC because
// the auth tag is the difference between "this snapshot was edited" and "this
// private key silently decrypts to garbage."

export const ENCRYPTION_KEY_ENV = "DISPATCH_ENCRYPTION_KEY";

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard; 96 bits is the size the mode is defined for
const VERSION = "v1";

/**
 * How to make one. Quoted verbatim into the missing-key error, because an
 * operator hitting that error at boot should not have to open the docs.
 */
const KEYGEN_HINT = "openssl rand -base64 32";

/**
 * Decode and validate the at-rest encryption key.
 *
 * Takes the environment as an argument rather than reading `process.env` so the
 * failure paths are testable without mutating global state — the same shape as
 * `ephemeralDbWarning`'s probe in `env.ts`.
 *
 * Every throw here is a refusal to store a private key in plaintext. None of them
 * include the offending value: an error message is exactly the thing that ends up
 * in a log line, and `redactSecrets()` cannot help — this key is what protects the
 * secrets, and is never itself registered.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Buffer {
  const raw = env[ENCRYPTION_KEY_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `Missing ${ENCRYPTION_KEY_ENV}. A GitHub App private key is stored in SQLite ` +
        `and must be encrypted at rest before it reaches the GCS snapshot. ` +
        `Generate one with: ${KEYGEN_HINT}`
    );
  }

  const key = Buffer.from(raw, "base64");

  // Node's base64 decoder ignores junk, so "!!!!" yields a 0-byte buffer rather
  // than throwing. Re-encoding and comparing is the only way to catch it.
  if (key.toString("base64") !== raw) {
    throw new Error(`${ENCRYPTION_KEY_ENV} is not valid base64. Generate one with: ${KEYGEN_HINT}`);
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Generate one with: ${KEYGEN_HINT}`
    );
  }

  return key;
}

/**
 * Encrypt `plaintext` into a self-describing envelope: `v1.<iv>.<tag>.<ciphertext>`,
 * each field base64url.
 *
 * The version prefix is not decoration. It is the thing that lets a future key
 * rotation or cipher change be *detected* rather than mis-parsed, and it is why
 * `decryptSecret` can fail closed on a value that was never encrypted at all.
 *
 * A fresh random IV per call. Reusing an IV under one key breaks GCM's
 * confidentiality outright, so this is never derived from the plaintext.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    "."
  );
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}.
 *
 * Fails closed on anything it does not recognize — wrong version, wrong field
 * count, wrong IV/tag length, tampered bytes, wrong key. In particular a *plaintext*
 * PEM that somehow reached the column throws rather than being returned, because
 * "the column contains something we did not encrypt" is a bug worth surfacing, not
 * a value worth trusting.
 *
 * Errors carry no plaintext and no key material.
 */
export function decryptSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted value: expected 4 envelope fields");
  }

  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Unsupported encrypted value version: ${JSON.stringify(version)}`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");

  if (iv.length !== IV_BYTES) throw new Error("Malformed encrypted value: bad IV length");
  if (tag.length !== 16) throw new Error("Malformed encrypted value: bad auth tag length");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // `final()` throws when the tag does not verify — wrong key, or edited bytes.
    // Swallow the original: it is uninformative, and re-throwing it risks carrying
    // library-supplied detail into a log line.
    throw new Error("Failed to decrypt: wrong key, or the value was tampered with");
  }
}
