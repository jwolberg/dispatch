// T2-2 (ticket #12) — anchor a diff-line comment to an @claude steer instruction.
//
// Pure, so the anchor rules are pinned independently of the DiffView that renders
// them. The load-bearing rule (design note): a comment must never silently point
// at the wrong line after a push. Two defenses live here — the comment carries
// the code snippet (so the agent sees WHAT was meant even if lines shift) and the
// sha it was made against (so the UI can mark it outdated once the head moves).

/**
 * The new-file line number for the rendered patch line at `index`, or null when
 * that line has no new-file line: a hunk header (`@@`), any file/meta line, or a
 * deletion (`-`), which exists only in the old file. Returns null if the patch
 * has no hunk header to count from.
 */
export function newLineNumberAt(patch: string, index: number): number | null {
  const lines = patch.split("\n");
  if (index < 0 || index >= lines.length) return null;

  let newLine = 0;
  let started = false;
  for (let i = 0; i <= index; i++) {
    const line = lines[i];
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      // The next added/context line is `+c`; set the counter one before it.
      newLine = Number(hunk[1]) - 1;
      started = true;
      if (i === index) return null; // the hunk header itself anchors nothing
      continue;
    }
    if (!started) {
      if (i === index) return null; // before any hunk — nothing to anchor
      continue;
    }
    // File headers / no-newline markers advance nothing.
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) {
      if (i === index) return null;
      continue;
    }
    if (line.startsWith("-")) {
      if (i === index) return null; // a deletion has no new-file line
      continue;
    }
    // A context (" ") or added ("+") line occupies the next new-file line.
    newLine++;
    if (i === index) return newLine;
  }
  return null;
}

export interface DiffAnchor {
  file: string;
  line: number;
  /** The line's content (marker stripped) — carried so the anchor survives a shift. */
  code: string;
  /** The head sha the diff was viewed at — names the commit this comment is about. */
  headSha: string;
}

/**
 * The @claude steer comment for a diff-line note. Anchored to `file:line` at a
 * specific short sha, and it quotes the code so a later push that renumbers lines
 * cannot silently retarget it.
 */
export function formatSteerComment(anchor: DiffAnchor, note: string): string {
  const trimmed = note.trim();
  if (!trimmed) throw new Error("formatSteerComment: refusing to post an empty instruction");
  return [
    `@claude re \`${anchor.file}\` line ${anchor.line} (at ${anchor.headSha.slice(0, 7)}):`,
    "",
    "```",
    anchor.code,
    "```",
    "",
    trimmed,
  ].join("\n");
}

/** True when the head has moved past the sha a comment was anchored to. */
export function isAnchorOutdated(anchorSha: string, currentHeadSha: string | null): boolean {
  return currentHeadSha != null && anchorSha !== currentHeadSha;
}
