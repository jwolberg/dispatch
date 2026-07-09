// Keep secrets out of responses and logs (S2).
//
// Two sources, because secrets reach this process two different ways:
//
//  1. **From the environment**, read at boot — API keys, PATs, webhook URLs.
//     Scanned by name out of `process.env`.
//  2. **Minted at runtime**, never in the environment (#3) — GitHub App
//     installation tokens, which `providers/` mints and refreshes hourly. There
//     is no env var to look them up under, so they must *register their value*
//     with the redactor when they are created.
//
// Source 2 is why this module cannot simply iterate a list of env keys. A minted
// token that leaks into an Octokit error message would otherwise be returned
// verbatim by `safeMessage()` and written to a log line.

const SECRET_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "SLACK_WEBHOOK_URL",
];

const PLACEHOLDER = "«redacted»";

/**
 * Below this, a "secret" is more likely to be a substring of ordinary prose than
 * a credential. Registering `"abc"` would redact those three letters out of every
 * message the process ever emits. Matches the env path's existing guard.
 */
const MIN_SECRET_LENGTH = 4;

/**
 * Values registered by whoever holds them. Not keyed by name: the redactor only
 * ever needs to ask "does this string contain that string".
 */
const registered = new Set<string>();

/**
 * Track `value` so it is scrubbed from every future log line and error message.
 *
 * Call this the moment a secret exists outside the environment. Safe to call
 * repeatedly with the same value.
 */
export function registerSecret(value: string | null | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) return;
  registered.add(value);
}

/**
 * Stop tracking `value`.
 *
 * Call this when a secret is superseded — an installation token is re-minted
 * roughly hourly, and without this the registry grows by one entry per hour for
 * the life of the process. A dead token appearing in a log is not a disclosure;
 * an unbounded set is a leak of a different kind.
 */
export function unregisterSecret(value: string | null | undefined): void {
  if (!value) return;
  registered.delete(value);
}

/** Test hook. Production code never calls this. */
export function __resetRegisteredSecrets(): void {
  registered.clear();
}

/** Every secret value currently known, from either source. */
function knownSecrets(): string[] {
  const values: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= MIN_SECRET_LENGTH) values.push(value);
  }
  values.push(...registered);
  return values;
}

export function redactSecrets(input: string): string {
  let out = input;
  for (const value of knownSecrets()) {
    out = out.split(value).join(PLACEHOLDER);
  }
  return out;
}

/** Extract a safe, redacted message from any thrown value. */
export function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg);
}
