// Prompt assembly for spec chat (PRD F2.1–F2.3). All Anthropic calls are
// stateless — every request carries its own injected repo context.

import { getSpecSkill, type SpecSkill } from "./spec-skills.js";

export interface InjectableContext {
  path: string;
  description: string | null;
  claudeMd: string | null;
  readmeExcerpt: string | null;
  fileTree: string[];
}

function section(title: string, body: string | null): string {
  if (!body || !body.trim()) return "";
  return `\n\n## ${title}\n${body.trim()}`;
}

/**
 * Build the system prompt for a repo-scoped spec chat (F2.1): the spec-shaping
 * skill first (#37 — the method), then the injected repo facts it works on.
 */
export function buildSystemPrompt(
  ctx: InjectableContext,
  skill: SpecSkill = getSpecSkill()
): string {
  const tree = ctx.fileTree.length ? ctx.fileTree.join("\n") : null;
  return (
    skill.body +
    `\n\n--- Repository context for ${ctx.path} ---` +
    section("Description", ctx.description) +
    section("CLAUDE.md", ctx.claudeMd) +
    section("README (excerpt)", ctx.readmeExcerpt) +
    section("File tree (depth 2)", tree)
  );
}

// Appended as a final user turn when generating the ticket JSON (F2.3).
export const GENERATE_TICKET_INSTRUCTION = `Based on the conversation so far, produce the final issue spec as STRICT JSON and nothing else (no prose, no code fences). Use exactly this shape:
{"title": "<one-line title>", "body_markdown": "<full spec: problem statement, acceptance criteria checklist, affected files, test plan, out-of-scope>", "labels": ["<label>", ...]}`;

// Re-issued on a parse failure (F2.3: retry once with an error-correction prompt).
export const GENERATE_TICKET_RETRY = `Your previous response was not valid JSON. Reply with ONLY the JSON object — no code fences, no commentary — matching exactly:
{"title": string, "body_markdown": string, "labels": string[]}`;
