import Anthropic from "@anthropic-ai/sdk";

// PRD §4: model configurable, default claude-sonnet-4-6 (current Sonnet — cheaper
// than Opus tier at $3/$15 per MTok; replaces the now-deprecated
// claude-sonnet-4-20250514). Overridable via ANTHROPIC_MODEL without code changes.
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS ?? 4096);

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing required environment variable: ANTHROPIC_API_KEY");
    client = new Anthropic({ apiKey });
  }
  return client;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stream a spec-chat turn. The route pipes these events to the client as SSE. */
export function streamMessage(system: string, messages: ChatTurn[]) {
  return getClient().messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
  });
}

/**
 * Non-streaming completion (used for ticket generation). Retries once with
 * backoff on transient Anthropic errors (overloaded / 5xx / rate limit), per S4.
 */
export async function createMessage(
  system: string,
  messages: ChatTurn[],
  maxTokens: number = MAX_TOKENS
): Promise<string> {
  const send = () =>
    getClient().messages.create({ model: MODEL, max_tokens: maxTokens, system, messages });

  let res;
  try {
    res = await send();
  } catch (err) {
    if (isRetryable(err)) {
      await sleep(800);
      res = await send();
    } else {
      throw err;
    }
  }

  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      (typeof err.status === "number" && err.status >= 500)
    );
  }
  return false;
}
