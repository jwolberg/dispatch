// T2-1 (ticket #11) — classify unified-diff lines for the in-app diff view.
//
// Pure by design (vitest.config.ts): the colouring rule is testable in isolation
// so the DiffView component can stay a thin renderer. "Direction" is the thing
// that must not drift — a `+` painted as a deletion tells the reviewer the code
// removed a line it actually added.

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

function classify(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  // File headers and the no-newline marker are structural, not changed content.
  // Check the two-plus/two-minus headers BEFORE the single +/- so they are not
  // read as additions or deletions.
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("\\")) return "meta"; // "\ No newline at end of file"
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Split a unified patch into typed lines. An empty patch yields no lines. */
export function parsePatch(patch: string): DiffLine[] {
  if (patch === "") return [];
  return patch.split("\n").map((text) => ({ kind: classify(text), text }));
}
