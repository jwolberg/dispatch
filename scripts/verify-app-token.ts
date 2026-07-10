/**
 * Ticket #22 AC 6 — prove a tracked repo polls with a minted *installation
 * token*, not GITHUB_TOKEN.
 *
 * Runs the real resolution path (`openInstallationStore` → `setInstallationStore`
 * → `getProviderForRepo`) with a deliberately corrupted GITHUB_TOKEN in this
 * process only. Your running dev server is untouched.
 *
 * The conditional-request cache is intentionally NOT wired: a replayed ETag
 * could serve a cached 200 and mask a 401, which would fake the result.
 *
 *   npx tsx scripts/verify-app-token.ts
 */
import "dotenv/config";
import { openInstallationStore } from "../server/db/installations.js";
import {
  setInstallationStore,
  resetProviderCache,
  getProviderForRepo,
  getAccountProviders,
} from "../server/providers/index.js";

const BAD = "ghp_deliberately_invalid_dispatch_ac6";

// Must happen before any resolve() builds an EnvTokenSource. requireEnv reads
// this lazily, and the provider cache starts empty, so this is the whole trick.
process.env.GITHUB_TOKEN = BAD;

const INSIDE = "jwolberg/situation"; // owned by the installation account
const OUTSIDE = "octocat/Hello-World"; // outside every installation → env token

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function attempt(what: string, fn: () => Promise<string>) {
  try {
    line(what, `OK   ${await fn()}`);
    return true;
  } catch (err) {
    line(what, `FAIL ${(err as Error).message.split("\n")[0].slice(0, 90)}`);
    return false;
  }
}

async function main() {
  const store = openInstallationStore(process.env, resetProviderCache);
  if (!store) throw new Error("no installation store — is DISPATCH_ENCRYPTION_KEY set?");
  setInstallationStore(store);

  const app = store.getApp();
  console.log(`\napp: ${app?.slug} (id ${app?.appId})`);
  console.log(`GITHUB_TOKEN in this process: corrupted on purpose\n`);

  console.log("[1] repo INSIDE the installation → expect OK (installation token)");
  const inside = await attempt(INSIDE, async () => {
    const p = getProviderForRepo({ provider: "github", path: INSIDE });
    const runs = await p.getWorkflowRuns({ provider: "github", path: INSIDE }, "main");
    const rl = await p.getRateLimit();
    return `${runs.length} workflow runs; rate limit ${rl.limit}`;
  });

  console.log("\n[2] repo OUTSIDE every installation → expect FAIL (bad env token)");
  const outside = await attempt(OUTSIDE, async () => {
    const p = getProviderForRepo({ provider: "github", path: OUTSIDE });
    const runs = await p.getWorkflowRuns({ provider: "github", path: OUTSIDE }, "master");
    return `${runs.length} workflow runs — UNEXPECTED`;
  });

  console.log("\n[3] account-level credentials (getAccountProviders)");
  const accounts = getAccountProviders("github");
  for (const a of accounts) {
    await attempt(`${a.kind}:${a.label}`, async () => {
      const rl = await a.provider.getRateLimit();
      return `rate limit ${rl.limit}, remaining ${rl.remaining}`;
    });
  }

  const pass = inside && !outside;
  console.log(
    `\n=== AC 6 ${pass ? "PROVEN" : "NOT PROVEN"} ===\n` +
      (pass
        ? `${INSIDE} fetched while GITHUB_TOKEN was garbage. Only an installation\n` +
          `token could have done that. ${OUTSIDE} correctly failed on the env token.\n`
        : `Expected inside=OK and outside=FAIL; got inside=${inside} outside=${outside}.\n`)
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nharness error: ${(e as Error).message}`);
  process.exit(2);
});
