import type { IssueComment } from "../providers/types.js";
import type { ChatMessage } from "../db/chats.js";

// #38/#42 — Dispatch → TerMinal handoff.
//
// The laptop never talks to Dispatch. The handoff pushes the spec-chat
// transcript onto the issue (the only artifact that exists solely in Dispatch),
// which makes the *issue URL* a complete, per-user-authenticated record. You
// paste that URL into a Claude/Codex tab in TerMinal and the agent files a local
// backlog ticket from it — no TerMinal receiver, no queue, nothing hosted here.
//
// #42 replaced the original last mile (an envelope enqueued into TerMinal's
// automation inbox): the TerMinal watcher was verified never to drain `new/`,
// and its app code is frozen. The provider-as-bus thesis (ADR-0007) is unchanged;
// only the delivery is.

/**
 * Hidden marker opening every transcript comment Dispatch posts. It is how a
 * second handoff knows the transcript is already carried, so no new column is
 * needed to record that — the issue is the record.
 */
export const TRANSCRIPT_MARKER = "<!-- dispatch:spec-transcript -->";

/**
 * The paste-ready instruction the human copies into a TerMinal agent tab. It
 * embeds only the issue URL — never any issue text — so a body containing
 * `$(...)` or backticks cannot execute; the agent fetches the body itself.
 */
export function buildImportPrompt(issueUrl: string): string {
  return (
    `Import this Dispatch issue as a TerMinal backlog ticket in the current repo:\n` +
    `${issueUrl}\n\n` +
    `Read it with \`gh issue view\`, drop the trailing "@claude …" implementation ` +
    `block Dispatch appended, infer the ticket type from its labels, and file it ` +
    `with the /ticket workflow (status: open). The full spec chat, if any, is in ` +
    `the issue comments for context.`
  );
}

/**
 * Render the spec chat as an issue comment, or null when there is nothing to
 * carry — an empty transcript should post no comment at all.
 */
export function buildTranscriptComment(transcript: ChatMessage[]): string | null {
  if (transcript.length === 0) return null;
  const turns = transcript
    .map((m) => `**${m.role === "user" ? "User" : "Assistant"}:**\n\n${m.content.trim()}`)
    .join("\n\n---\n\n");
  return (
    `${TRANSCRIPT_MARKER}\n` +
    `## Spec chat transcript\n\n` +
    `_Carried over from the Dispatch spec chat that produced this issue._\n\n` +
    `${turns}\n`
  );
}

/**
 * Has Dispatch already posted the transcript here?
 *
 * The marker must open the comment. Matching it anywhere would let someone
 * quoting the marker while discussing this feature permanently suppress the
 * real post.
 */
export function hasTranscriptComment(comments: IssueComment[]): boolean {
  return comments.some((c) => c.body.trimStart().startsWith(TRANSCRIPT_MARKER));
}
