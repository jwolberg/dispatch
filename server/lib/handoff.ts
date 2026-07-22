import type { IssueComment } from "../providers/types.js";
import type { ChatMessage } from "../db/chats.js";

// #38 — Dispatch → TerMinal handoff.
//
// The laptop never talks to Dispatch. Cloud Run cannot reach a machine behind
// NAT, so rather than run a queue here and a credentialed poller there, the
// transcript is pushed to the issue (making it derivable by any client with
// provider auth) and the human carries one short command across.

/**
 * Hidden marker opening every transcript comment Dispatch posts. It is how a
 * second handoff knows the transcript is already carried, so no new column is
 * needed to record that — the issue is the record.
 */
export const TRANSCRIPT_MARKER = "<!-- dispatch:spec-transcript -->";

/**
 * The command the human copies. Coordinates only: no issue text crosses into a
 * shell string, so backticks or `$(...)` in a body cannot execute on the laptop.
 * `scripts/terminal-pickup.sh` fetches the issue itself.
 */
export function buildPickupCommand(repoPath: string, issueNumber: number): string {
  return `dispatch-pickup ${repoPath}#${issueNumber}`;
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
