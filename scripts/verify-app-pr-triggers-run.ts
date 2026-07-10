/**
 * Ticket #22 AC 13 / ADR-0006 [8] — does a pull request opened by an *App
 * installation token* trigger `pull_request` workflow runs without approval?
 *
 * Mints the token through Dispatch's own AppTokenSource, then:
 *   1. branches from main
 *   2. commits a trivial `on: pull_request` workflow ON THE BRANCH ONLY
 *      (for `pull_request`, GitHub reads the workflow from the head — main is
 *      never touched)
 *   3. opens the PR with that token
 *   4. polls /actions/runs and reports status / actor / triggering_actor
 *
 *   npx tsx scripts/verify-app-pr-triggers-run.ts <owner/repo>
 *   npx tsx scripts/verify-app-pr-triggers-run.ts <owner/repo> --cleanup
 */
import "dotenv/config";
import { openInstallationStore } from "../server/db/installations.js";
import { AppTokenSource } from "../server/providers/token-source.js";

const API = "https://api.github.com";
const REPO = process.argv[2] ?? "jwolberg/cohort-bot";
const CLEANUP = process.argv.includes("--cleanup");
const BRANCH = "dispatch-ac13-installation-token";
const WF_PATH = ".github/workflows/dispatch-ac13.yml";

const WORKFLOW = `name: dispatch-ac13
on: pull_request
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - run: echo "triggered by \${{ github.event_name }} / actor \${{ github.actor }}"
`;

let TOKEN = "";
async function gh(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? text}`);
  return json as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const store = openInstallationStore(process.env, () => {});
  if (!store) throw new Error("no installation store");
  const app = store.getApp()!;
  const inst = store.forRepo({ provider: "github", host: null, path: REPO });
  if (!inst) throw new Error(`${REPO} is not covered by any installation`);

  TOKEN = await new AppTokenSource({
    appId: app.appId,
    privateKey: app.privateKey,
    installationId: inst.installationId,
  }).get();
  console.log(`minted installation token for ${REPO} (app ${app.slug}, inst ${inst.installationId})\n`);

  if (CLEANUP) {
    const prs = await gh("GET", `/repos/${REPO}/pulls?head=${REPO.split("/")[0]}:${BRANCH}&state=open`);
    for (const pr of prs) {
      await gh("PATCH", `/repos/${REPO}/pulls/${pr.number}`, { state: "closed" });
      console.log(`closed PR #${pr.number}`);
    }
    await gh("DELETE", `/repos/${REPO}/git/refs/heads/${BRANCH}`).catch(() => console.log("branch already gone"));
    console.log(`deleted branch ${BRANCH}\nmain was never modified.\n`);
    return;
  }

  const repo = await gh("GET", `/repos/${REPO}`);
  const base = repo.default_branch as string;
  const baseRef = await gh("GET", `/repos/${REPO}/git/ref/heads/${base}`);
  const baseSha = baseRef.object.sha as string;
  console.log(`base ${base} @ ${baseSha.slice(0, 7)}`);

  await gh("POST", `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: baseSha });
  console.log(`created branch ${BRANCH}`);

  const put = await gh("PUT", `/repos/${REPO}/contents/${WF_PATH}`, {
    message: "ci: trivial pull_request workflow to observe ADR-0006 [8]",
    content: Buffer.from(WORKFLOW, "utf8").toString("base64"),
    branch: BRANCH,
  });
  const headSha = put.commit.sha as string;
  console.log(`committed ${WF_PATH} @ ${headSha.slice(0, 7)} (branch only; ${base} untouched)`);

  const pr = await gh("POST", `/repos/${REPO}/pulls`, {
    title: "AC 13: does an App installation token trigger pull_request runs?",
    head: BRANCH,
    base,
    body: "Opened by Dispatch's GitHub App installation token to close ADR-0006 [8]. Safe to close.",
  });
  console.log(`opened PR #${pr.number} by ${pr.user.login} (type ${pr.user.type})\n`);

  console.log("polling /actions/runs for a pull_request run…");
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const runs = await gh("GET", `/repos/${REPO}/actions/runs?event=pull_request&per_page=10`);
    const hit = runs.workflow_runs?.find((r: any) => r.head_branch === BRANCH);
    if (hit) {
      console.log(`\n=== RUN OBSERVED (after ~${(i + 1) * 3}s) ===`);
      console.log(`  status            ${hit.status}`);
      console.log(`  conclusion        ${hit.conclusion ?? "(pending)"}`);
      console.log(`  event             ${hit.event}`);
      console.log(`  actor             ${hit.actor?.login}`);
      console.log(`  triggering_actor  ${hit.triggering_actor?.login}`);
      console.log(`  url               ${hit.html_url}`);
      const approval = hit.status === "action_required";
      console.log(
        `\n=== ADR-0006 [8]: the arm ${approval ? "IS FALSE (approval required)" : "HOLDS"} ===\n` +
          (approval
            ? "A PR opened by an installation token was gated behind approval.\n"
            : "A PR opened by an installation token triggered pull_request without approval.\n")
      );
      console.log(`cleanup:\n  npx tsx scripts/verify-app-pr-triggers-run.ts ${REPO} --cleanup\n`);
      return;
    }
    process.stdout.write(".");
  }
  console.log(
    `\n\n=== NO RUN AFTER 60s ===\n` +
      `That is the 'arm is false' outcome: no pull_request run was created.\n` +
      `Check https://github.com/${REPO}/pull/${pr.number}/checks before concluding.\n`
  );
}

main().catch((e) => {
  console.error(`\nerror: ${(e as Error).message}`);
  process.exit(1);
});
