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

/** Test hook — inject a fake SDK client. Production code never calls this. */
export function __setClientForTest(c: Anthropic | null): void {
  client = c;
}

/**
 * A tool loop multiplies Anthropic calls per user turn, so it is bounded. On the
 * final allowed round tools are withheld, forcing the model to answer with what
 * it has rather than spin (#27). The per-turn file-read cap lives in the tool
 * runner; this is the outer bound.
 */
export const MAX_TOOL_ITERATIONS = 8;

export interface ToolOptions {
  tools?: Anthropic.Tool[];
  runTool?: (name: string, input: unknown) => Promise<string>;
}

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
function recordCall(kind: SpendKind, usage: Anthropic.Usage, ticketId?: number): void {
  try {
    recordSpend({ model: MODEL, kind, ticketId, usage: toTokenUsage(usage), at: new Date() });
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
 * Non-streaming completion (used for ticket generation and change summaries).
 * Retries once with backoff on transient Anthropic errors (overloaded / 5xx /
 * rate limit), per S4.
 *
 * `ticketId` attributes the spend to one ticket when the call is made on its
 * behalf (T1-5's summaries; read by #14). Attribution is best-effort — see
 * recordSpend — and its absence never blocks the call.
 */
export async function createMessage(
  system: string,
  messages: ChatTurn[],
  maxTokens: number = MAX_TOKENS,
  kind: SpendKind = "chat",
  ticketId?: number,
  toolOpts?: ToolOptions
): Promise<string> {
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const canUseTools = Boolean(toolOpts?.tools?.length && toolOpts.runTool);

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    // Budget-check every round: a tool loop is many calls, and each must be
    // stopped the moment the day's cap is hit, not just the first.
    assertWithinBudget(new Date());

    // Withhold tools on the final round so the model must conclude rather than
    // request an (N+1)th tool the loop would not honour.
    const offerTools = canUseTools && iter < MAX_TOOL_ITERATIONS - 1;
    const res = await sendWithRetry({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: convo,
      ...(offerTools ? { tools: toolOpts!.tools } : {}),
    });
    recordCall(kind, res.usage, ticketId);

    if (offerTools && res.stop_reason === "tool_use") {
      convo.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type === "tool_use") {
          const content = await toolOpts!.runTool!(block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content });
        }
      }
      convo.push({ role: "user", content: results });
      continue;
    }

    return textOf(res);
  }

  return ""; // Unreachable: the final round withholds tools and returns above.
}

/** Concatenate the text blocks of a message, ignoring tool_use/other blocks. */
function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** One create() call, retried once on a transient Anthropic error (S4). */
async function sendWithRetry(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  try {
    return await getClient().messages.create(params);
  } catch (err) {
    if (isRetryable(err)) {
      await sleep(800);
      return await getClient().messages.create(params);
    }
    throw err;
  }
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; path?: string };

/**
 * Stream a spec-chat turn that may use tools. Yields text deltas as they arrive
 * and a `tool` event per tool call (so the route can render "reading X"), looping
 * while the model requests tools, bounded by {@link MAX_TOOL_ITERATIONS}. All
 * Anthropic calls stay on this choke point, so every round is budget-checked and
 * its usage recorded.
 */
export async function* streamChat(
  system: string,
  messages: ChatTurn[],
  toolOpts?: ToolOptions
): AsyncGenerator<ChatEvent> {
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const canUseTools = Boolean(toolOpts?.tools?.length && toolOpts.runTool);

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    assertWithinBudget(new Date());
    const offerTools = canUseTools && iter < MAX_TOOL_ITERATIONS - 1;

    const stream = getClient().messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: convo,
      ...(offerTools ? { tools: toolOpts!.tools } : {}),
    });

    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        yield { type: "text", text: ev.delta.text };
      }
    }

    const msg = await stream.finalMessage();
    recordCall("chat", msg.usage);

    if (offerTools && msg.stop_reason === "tool_use") {
      convo.push({ role: "assistant", content: msg.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const path =
            block.input && typeof block.input === "object" && "path" in block.input
              ? String((block.input as { path: unknown }).path)
              : undefined;
          yield { type: "tool", tool: block.name, path };
          const content = await toolOpts!.runTool!(block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content });
        }
      }
      convo.push({ role: "user", content: results });
      continue;
    }
    return;
  }
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
