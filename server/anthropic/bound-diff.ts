import type { PRDiff, PRFileDiff } from "../providers/types.js";

// T1-5 — bound a PR diff before it is sent to Anthropic.
//
// The file list is never truncated; only patches are. Paths and line counts are
// cheap and carry most of the signal ("it touched the auth middleware"), while
// patches are where the tokens go. Dropping a file from the list would let the
// model describe a change while blind to the file that mattered.
//
// Truncation is always reported. A partial diff presented as whole is worse than
// no diff at all: the model writes "low risk" about code it never saw.

/**
 * Bytes of patch text we are willing to send. ~24 KB is roughly 6k tokens —
 * enough for a real feature diff, small enough that one summary stays cheap
 * against DISPATCH_DAILY_BUDGET_USD.
 */
export const DEFAULT_PATCH_BUDGET_BYTES = 24_000;

/**
 * A patch fragment shorter than this teaches the model nothing and still costs
 * tokens. Below it we omit the patch entirely rather than emit a stub.
 */
export const MIN_USEFUL_PATCH_BYTES = 200;

export interface BoundedFile extends PRFileDiff {
  /** True when `patch` is a prefix of the real patch rather than the whole one. */
  patchTruncated: boolean;
}

export interface BoundedDiff {
  files: BoundedFile[];
  /** Any patch dropped or cut, or the provider itself capped the file list. */
  truncated: boolean;
  bytesUsed: number;
}

/**
 * Spend `budgetBytes` of patch text across `diff.files`, in provider order.
 *
 * Provider order is preserved deliberately — sorting by size would let a huge
 * generated file crowd out the two-line change that actually matters.
 */
export function boundDiff(diff: PRDiff, budgetBytes = DEFAULT_PATCH_BUDGET_BYTES): BoundedDiff {
  if (budgetBytes < 0) {
    throw new Error(`boundDiff: budgetBytes must be >= 0, got ${budgetBytes}`);
  }

  let remaining = budgetBytes;
  let bytesUsed = 0;
  // Carry the provider's own truncation forward: we were not given everything.
  let truncated = diff.truncated;

  const files: BoundedFile[] = diff.files.map((f) => {
    // A binary file has no patch to omit. Reporting truncation for it would make
    // the prompt claim we hid something we never had.
    if (f.patch === null) return { ...f, patchTruncated: false };

    if (f.patch.length <= remaining) {
      remaining -= f.patch.length;
      bytesUsed += f.patch.length;
      return { ...f, patchTruncated: false };
    }

    if (remaining >= MIN_USEFUL_PATCH_BYTES) {
      const cut = f.patch.slice(0, remaining);
      bytesUsed += cut.length;
      remaining = 0;
      truncated = true;
      return { ...f, patch: cut, patchTruncated: true };
    }

    truncated = true;
    return { ...f, patch: null, patchTruncated: false };
  });

  return { files, truncated, bytesUsed };
}
