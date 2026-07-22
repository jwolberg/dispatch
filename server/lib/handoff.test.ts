import { describe, it, expect } from "vitest";
import {
  TRANSCRIPT_MARKER,
  buildTranscriptComment,
  hasTranscriptComment,
  buildImportPrompt,
} from "./handoff.js";
import type { IssueComment } from "../providers/types.js";

// #42 — the Dispatch → TerMinal handoff, now via the issue URL (the inbox path
// was dead: the TerMinal watcher never drains). The things that must not
// regress: posting the transcript twice, and letting issue text reach a shell.

function comment(body: string): IssueComment {
  return { id: "1", author: "someone", body, createdAt: "2026-07-22T00:00:00Z", url: null };
}

describe("buildImportPrompt", () => {
  const url = "https://github.com/jwolberg/situation/issues/42";

  it("embeds the issue URL — the one thing the agent needs", () => {
    expect(buildImportPrompt(url)).toContain(url);
  });

  it("tells the agent how to import: read via gh, strip the trailer, file a ticket", () => {
    const p = buildImportPrompt(url).toLowerCase();
    expect(p).toContain("gh");
    expect(p).toContain("@claude"); // the trailer it must strip
    expect(p).toMatch(/backlog|\/ticket/); // where it files
  });

  it("carries no issue body, so a hostile issue cannot reach the shell", () => {
    // Only the URL is embedded; the agent fetches the body itself. A body of
    // `$(rm -rf ~)` never appears in the pasted text.
    const p = buildImportPrompt(url);
    expect(p).toContain(url);
    expect(p).not.toContain("rm -rf");
  });
});

describe("buildTranscriptComment", () => {
  const transcript = [
    { role: "user" as const, content: "the board is slow" },
    { role: "assistant" as const, content: "which view specifically?" },
  ];

  it("embeds the marker so a later handoff can detect it", () => {
    expect(buildTranscriptComment(transcript)).toContain(TRANSCRIPT_MARKER);
  });

  it("renders every turn, attributed", () => {
    const body = buildTranscriptComment(transcript)!;
    expect(body).toContain("the board is slow");
    expect(body).toContain("which view specifically?");
    expect(body.toLowerCase()).toContain("user");
    expect(body.toLowerCase()).toContain("assistant");
  });

  it("returns null for an empty transcript rather than posting an empty comment", () => {
    expect(buildTranscriptComment([])).toBeNull();
  });
});

describe("hasTranscriptComment", () => {
  it("detects a transcript Dispatch already posted", () => {
    // Round-trip the real thing rather than a hand-made marker string: the
    // detector and the builder must agree, and only the builder's output is
    // what a second handoff will actually encounter.
    const posted = buildTranscriptComment([{ role: "user", content: "hi" }])!;
    expect(hasTranscriptComment([comment("unrelated"), comment(posted)])).toBe(true);
  });

  it("is false when no comment carries the marker", () => {
    expect(hasTranscriptComment([comment("looks good to me"), comment("@claude go")])).toBe(
      false
    );
  });

  it("is false on an issue with no comments at all", () => {
    expect(hasTranscriptComment([])).toBe(false);
  });

  it("does not mistake a quotation of the marker in prose for the real thing", () => {
    // A human pasting the marker inside a code fence while discussing this
    // feature must not permanently suppress the real transcript post.
    expect(hasTranscriptComment([comment("we grep for `<!-- dispatch:spec-transcript -->`")])).toBe(
      false
    );
  });
});
