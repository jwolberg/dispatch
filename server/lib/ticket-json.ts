import type { SpecInput } from "../providers/types.js";

// Ticket-JSON parsing (PRD F2.3). Extracted from routes/chat.ts so the parser
// is testable without Express or the database. The route owns the retry policy;
// this module only answers "is this text a valid ticket?".

/** Strip a leading ```json fence and a trailing ``` fence, if present. */
export function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Parse a strict-JSON ticket, tolerating code fences and surrounding prose.
 *
 * Returns null rather than throwing: the caller (routes/chat.ts) treats null as
 * "retry once with a correction prompt", and a second null as a clean 502.
 * A ticket is valid only when `title` and `body_markdown` are both strings;
 * `labels` is best-effort and non-string entries are dropped.
 */
export function tryParseTicket(text: string): SpecInput | null {
  const cleaned = stripFences(text);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  const braces = first >= 0 && last > first ? cleaned.slice(first, last + 1) : null;
  for (const candidate of [cleaned, braces]) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof obj.title === "string" && typeof obj.body_markdown === "string") {
        const labels = Array.isArray(obj.labels)
          ? obj.labels.filter((l): l is string => typeof l === "string")
          : [];
        return { title: obj.title, body_markdown: obj.body_markdown, labels };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
