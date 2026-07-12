import type { GitProvider, RepoRef } from "../providers/types.js";
import { parseReviewArtifact, type ReviewArtifact } from "./artifact.js";

// T2-5 (ticket #15) — fetch a PR's review artifact from the repo it describes.
//
// The artifact is committed IN the repo (no external dashboard), so Dispatch
// reads it through the provider seam's readFile — the same seam spec-chat uses
// (#27), so nothing here touches Octokit directly. Both the v2 (`.TerMinal/
// reviews/`) and legacy v1 (`.reviews/`) layouts are tried, since a target repo
// may be on either.

const DIRS = [".TerMinal/reviews", ".reviews"] as const;

/**
 * Read `<dir>/<pr>/<short_sha>.md` + `<dir>/<pr>/findings.json` and parse them.
 * Returns null when no complete artifact is found in any known layout — the
 * caller's gate treats null as "blocked" (fail-closed).
 */
export async function fetchReview(
  provider: GitProvider,
  ref: RepoRef,
  prNumber: number,
  headSha: string
): Promise<ReviewArtifact | null> {
  const shortSha = headSha.slice(0, 7);
  for (const dir of DIRS) {
    const [md, findingsJson] = await Promise.all([
      provider.readFile(ref, `${dir}/${prNumber}/${shortSha}.md`),
      provider.readFile(ref, `${dir}/${prNumber}/findings.json`),
    ]);
    const review = parseReviewArtifact(md, findingsJson);
    if (review) return review;
  }
  return null;
}
