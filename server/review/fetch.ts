import type { GitProvider, RepoRef } from "../providers/types.js";
import { parseReviewArtifact, type ReviewArtifact } from "./artifact.js";

// T2-5 / T2-4 (tickets #15, #34) — fetch a PR's review artifact from the repo.
//
// The artifact is committed IN the repo (no external dashboard), on the PR's own
// head — it is NOT on the default branch until merge. So this reads at the PR
// **head ref** (#34); reading the default branch, as the first cut did, would
// never see an open PR's review and would block every Ship. Both the v2
// (`.TerMinal/reviews/`) and legacy v1 (`.reviews/`) layouts are tried. Nothing
// here touches Octokit directly — it goes through the readFile/listFiles seam.
//
// The CI names each artifact `<reviewed-short-sha>.md` and commits it on top of
// the code, which shifts the head to the artifact commit — but that commit's
// tree still CONTAINS the `<sha>.md`, so listing the review dir at the head ref
// finds it. When several reviews have accumulated (re-pushes), the most recently
// `generated:` one wins; the check gate already stops a stale review from
// shipping (a new code push leaves its review check pending).

const DIRS = [".TerMinal/reviews", ".reviews"] as const;

function generatedAt(md: string): string {
  return md.match(/^generated:\s*(.+)$/m)?.[1]?.trim() ?? "";
}

/**
 * Read the newest complete review artifact for `prNumber` at the PR head ref.
 * Returns null when no complete artifact is found in any known layout — the
 * caller's gate treats null as "blocked" (fail-closed).
 */
export async function fetchReview(
  provider: GitProvider,
  ref: RepoRef,
  prNumber: number,
  headSha: string
): Promise<ReviewArtifact | null> {
  for (const dir of DIRS) {
    const base = `${dir}/${prNumber}`;
    const names = await provider.listFiles(ref, base, headSha);
    const mdFiles = names.filter((n) => n.endsWith(".md"));
    if (mdFiles.length === 0) continue;

    const findingsJson = await provider.readFile(ref, `${base}/findings.json`, headSha);

    let best: ReviewArtifact | null = null;
    let bestGen = "";
    for (const name of mdFiles) {
      const md = await provider.readFile(ref, `${base}/${name}`, headSha);
      const review = md ? parseReviewArtifact(md, findingsJson) : null;
      if (!review || !md) continue;
      const gen = generatedAt(md);
      if (!best || gen > bestGen) {
        best = review;
        bestGen = gen;
      }
    }
    if (best) return best;
  }
  return null;
}
