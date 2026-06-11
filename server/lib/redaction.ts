// Keep secrets out of responses and logs (S2). Replace any env-secret value
// that leaks into a string with a placeholder.

const SECRET_ENV_KEYS = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GITLAB_TOKEN"];

export function redactSecrets(input: string): string {
  let out = input;
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 4) {
      out = out.split(value).join("«redacted»");
    }
  }
  return out;
}

/** Extract a safe, redacted message from any thrown value. */
export function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg);
}
