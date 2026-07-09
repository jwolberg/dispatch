import { boundDiff, type BoundedDiff } from "./bound-diff.js";
import { createMessage } from "./client.js";
import type { PRDiff } from "../providers/types.js";

// T1-5 — the plain-language change summary shown above the fold.
//
// The target user cannot read a diff. Three questions, in their order of
// urgency: what changed, what do I click to check it, and should I look closer.
//
// `risk` is a closed set, not free text, because #7 renders it as a chip and a
// chip needs a finite number of styles. A model asked for free text will happily
// return "medium-low", and the card would render nothing.

export const RISK_FLAGS = ["low", "review-this"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export interface ChangeSummary {
  /** What the change does, in plain English. No file paths, no jargon. */
  whatChanged: string;
  /** The concrete thing to click or run to see it working. */
  howToTest: string;
  risk: RiskFlag;
}

/** Enough for three short paragraphs; a summary that runs long is not a summary. */
const SUMMARY_MAX_TOKENS = 700;

const SYSTEM = `You are summarizing a pull request for someone who cannot read code. They are the person who asked for this change, and they are about to decide whether to ship it.

Answer three questions:
  whatChanged  — What the change does, in plain English. Describe behavior the person would notice, not files, functions, or implementation. Two or three sentences.
  howToTest    — The single most direct thing they can click, visit, or run to see it working. One or two sentences. If nothing is user-visible, say so plainly.
  risk         — Exactly one of: "low" | "review-this".

Choose "review-this" when the change touches authentication, permissions, payments, deletion of data, database migrations, or anything else where a mistake is expensive or hard to undo. Also choose "review-this" whenever the diff you were shown is marked as truncated and the parts you cannot see could plausibly change your answer — a partial view is not a low-risk view. Otherwise choose "low".

Reply with STRICT JSON and nothing else — no prose, no code fences:
{"whatChanged": string, "howToTest": string, "risk": "low" | "review-this"}`;

export class SummaryParseError extends Error {
  constructor(reason: string) {
    super(`Could not parse a change summary from the model response: ${reason}`);
    this.name = "SummaryParseError";
  }
}

function fileLine(f: BoundedDiff["files"][number]): string {
  const parts = [`- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`];
  if (f.patch === null) parts.push("[no patch shown: binary or omitted]");
  else if (f.patchTruncated) parts.push("[patch truncated]");
  return parts.join(" ");
}

/** Assemble the system + user prompt for one PR. */
export function buildSummaryPrompt(
  prTitle: string,
  bounded: BoundedDiff,
): { system: string; user: string } {
  const lines: string[] = [`Pull request title: ${prTitle}`, "", "Changed files:"];
  lines.push(...bounded.files.map(fileLine));

  if (bounded.truncated) {
    // Stated, not implied. A model that believes it saw the whole change will
    // write "low risk" about code that was never in its context window.
    lines.push(
      "",
      "NOTE: This diff is TRUNCATED. Some patches were cut short or omitted entirely, " +
        "and the file list itself may be incomplete. You are seeing a partial view of " +
        'this change. Weigh that when choosing the risk flag — prefer "review-this" if ' +
        "what you cannot see could matter.",
    );
  }

  const patches = bounded.files.filter((f) => f.patch !== null);
  if (patches.length) {
    lines.push("", "Diff:");
    for (const f of patches) lines.push("", `--- ${f.path} ---`, f.patch as string);
  }

  return { system: SYSTEM, user: lines.join("\n") };
}

/** Extract the first JSON object from a model response, tolerating fences and prose. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new SummaryParseError("no JSON object found");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new SummaryParseError(err instanceof Error ? err.message : "invalid JSON");
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SummaryParseError(`\`${field}\` must be a non-empty string`);
  }
  return value;
}

/**
 * Validate a model response into a ChangeSummary.
 *
 * Rejects rather than coerces. An unrecognized risk flag coerced to "low" is a
 * claim the user has no way to check; no summary at all is at least honest.
 * Only the three known fields survive — anything else the model invented never
 * reaches the cache or the card.
 */
export function parseSummary(text: string): ChangeSummary {
  const raw = extractJson(text) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null) throw new SummaryParseError("not an object");

  const risk = raw.risk;
  if (typeof risk !== "string" || !(RISK_FLAGS as readonly string[]).includes(risk)) {
    throw new SummaryParseError(
      `\`risk\` must be one of ${RISK_FLAGS.join(" | ")}, got ${JSON.stringify(risk)}`,
    );
  }

  return {
    whatChanged: requireText(raw.whatChanged, "whatChanged"),
    howToTest: requireText(raw.howToTest, "howToTest"),
    risk: risk as RiskFlag,
  };
}

/**
 * One Anthropic call: bound the diff, ask, parse.
 *
 * Callers own the cache and the budget gate — this function always bills. The
 * spend is attributed to `ticketId` so #14 can price a ticket end to end.
 */
export async function summarizeChange(
  prTitle: string,
  diff: PRDiff,
  ticketId: number,
): Promise<ChangeSummary> {
  const { system, user } = buildSummaryPrompt(prTitle, boundDiff(diff));
  const text = await createMessage(
    system,
    [{ role: "user", content: user }],
    SUMMARY_MAX_TOKENS,
    "summary",
    ticketId,
  );
  return parseSummary(text);
}
