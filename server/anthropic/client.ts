import Anthropic from "@anthropic-ai/sdk";
import { assertWithinBudget, dailyBudgetUsd } from "./budget.js";
import { isPriceable, toTokenUsage } from "./pricing.js";
import { recordSpend, type SpendKind } from "../db/spend.js";

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

    // T1-9: a cap we cannot price is not a cap. Fail on the first call rather
    // than billing every request at $0 and letting the budget never trip. Only
    // fatal when a budget is actually configured — an uncapped deployment on a
    // brand-new model should still work.
    if (dailyBudgetUsd() !== undefined && !isPriceable(MODEL)) {
      throw new Error(
        `DISPATCH_DAILY_BUDGET_USD is set but ANTHROPIC_MODEL=${MODEL} has no entry in ` +
          `server/anthropic/pricing.ts. Refusing to run: the cap could never trip.`,
      );
    }

    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Price and persist one call's usage. Never throws into the request path. */
function recordCall(kind: SpendKind, usage: Anthropic.Usage): void {
  try {
    recordSpend({ model: MODEL, kind, usage: toTokenUsage(usage), at: new Date() });
  } catch (err) {
    // The money is already spent; losing the row understates the day's total.
    // Log loudly rather than failing a request the user has already paid for.
    console.error("[spend] failed to record usage — daily cap may under-count:", err);
  }
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream a spec-chat turn. The route pipes these events to the client as SSE.
 *
 * T1-9: the budget is checked *before* the request, so being over budget never
 * costs another call to discover. Usage arrives only on the final message —
 * a stream has no usage until it drains — so recording is attached here rather
 * than at the call site, keeping every Anthropic call on one choke point.
 */
export function streamMessage(system: string, messages: ChatTurn[]) {
  assertWithinBudget(new Date());

  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
  });

  stream.finalMessage().then(
    (msg) => recordCall("chat", msg.usage),
    () => {
      // The stream failed. Anthropic bills tokens already streamed, but a
      // failed stream reports no usage, so there is nothing to record. The
      // error itself surfaces through the route's own iteration of `stream`.
    },
  );

  return stream;
}

/**
 * Non-streaming completion (used for ticket generation). Retries once with
 * backoff on transient Anthropic errors (overloaded / 5xx / rate limit), per S4.
 */
export async function createMessage(
  system: string,
  messages: ChatTurn[],
  maxTokens: number = MAX_TOKENS,
  kind: SpendKind = "chat"
): Promise<string> {
  assertWithinBudget(new Date());

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

  // Only the successful attempt reports usage. A retried transient failure was
  // billed by Anthropic but is invisible to us — we under-count by that attempt.
  recordCall(kind, res.usage);

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
