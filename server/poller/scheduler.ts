import { listTickets } from "../db/tickets.js";
import { listRepos } from "../db/repos.js";
import { getStatus } from "../db/status.js";
import { safeReconcile } from "./reconcile.js";
import { discoverAllRepos } from "./discover.js";
import { getAccountProviders } from "../providers/index.js";
import { isPaused, leastRemaining, updateRateLimit } from "../lib/ratelimit.js";
import { safeMessage } from "../lib/redaction.js";
import { ProbeLog } from "./probe-log.js";

const ACTIVE_INTERVAL_MS = 20_000; // 20s for repos with active tickets (PRD F4.2)
const IDLE_INTERVAL_MS = 5 * 60_000; // 5min otherwise

let activeTimer: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let busy = false;

// Terminal columns: once a ticket is here, the fast 20s tick stops and the 5min
// pollAll takes over. Merged is terminal too (T2-3) even though a deploy may
// still be pending — otherwise a repo with no deploy pipeline would fast-poll
// forever. The pollAll sweep still flips Merged → Deployed within ≤5min, and
// catches reopened/reverted cards (S6).
const TERMINAL_COLUMNS = new Set(["Merged", "Deployed"]);

/** A ticket is "active" (fast-polled) until its cached column is terminal. */
function isActive(ticketId: number): boolean {
  const row = getStatus(ticketId);
  if (!row) return true; // never polled → poll it
  try {
    const column = (JSON.parse(row.payload_json) as { column?: string }).column;
    return !column || !TERMINAL_COLUMNS.has(column);
  } catch {
    return true;
  }
}

/** Suppresses repeat warnings from a persistently-failing credential (#39). */
const probeLog = new ProbeLog();

// Refresh the rate-limit gauge before a cycle. GitHub's /rate_limit endpoint
// is free (doesn't consume core quota), so this is cheap insurance (S3).
//
// Every credential has its own budget (#21): two App installations have two, and
// each is exhausted independently. The gauge holds one number, so it holds the
// binding one — the smallest remaining, which is the budget that will pause
// polling first. Gating on `process.env.GITHUB_TOKEN` used to mean an App-only
// deployment never fed the gauge at all.
async function refreshRateLimit(): Promise<void> {
  if (!listRepos().some((r) => r.provider === "github")) return;

  const accounts = getAccountProviders("github");
  if (accounts.length === 0) return; // no credential; nothing to measure

  const settled = await Promise.allSettled(accounts.map((a) => a.provider.getRateLimit()));
  const measured = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

  // #39 — transition-only. An expired credential fails every cycle; warning each
  // time buried the log. `label` is documented as safe to render, and naming the
  // credential is what makes the warning actionable when a deployment holds
  // several (a PAT plus one per App installation).
  settled.forEach((result, i) => {
    const account = accounts[i];
    const credential = `${account.kind}:${account.label}`;
    if (result.status === "rejected") {
      if (probeLog.failed(credential, safeMessage(result.reason))) {
        console.warn(
          `[poller] rate-limit check failed for ${credential}: ${safeMessage(result.reason)} ` +
            `(silencing repeats until it changes)`
        );
      }
    } else if (probeLog.recovered(credential)) {
      console.info(`[poller] rate-limit check recovered for ${credential}`);
    }
  });

  const binding = leastRemaining(measured);
  if (binding) updateRateLimit(binding);
}

async function pollActive(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await refreshRateLimit();
    if (isPaused()) return; // S3: pause polling when the budget is low
    for (const ticket of listTickets()) {
      if (isActive(ticket.id)) await safeReconcile(ticket);
    }
  } finally {
    busy = false;
  }
}

async function pollAll(): Promise<void> {
  // Catches reopened/reverted shipped tickets (S6). Skipped while a fast tick runs.
  if (busy) return;
  busy = true;
  try {
    await refreshRateLimit();
    if (isPaused()) return;
    // Adopt any newly-created open issues across tracked repos before reconciling
    // so they appear on the board without being re-filed through the app.
    await discoverAllRepos();
    for (const ticket of listTickets()) await safeReconcile(ticket);
  } finally {
    busy = false;
  }
}

export function startPoller(): void {
  if (activeTimer) return;
  // Kick once on boot so the board rebuilds from the provider after a cache wipe.
  void pollAll();
  activeTimer = setInterval(() => void pollActive(), ACTIVE_INTERVAL_MS);
  idleTimer = setInterval(() => void pollAll(), IDLE_INTERVAL_MS);
}

export function stopPoller(): void {
  if (activeTimer) clearInterval(activeTimer);
  if (idleTimer) clearInterval(idleTimer);
  activeTimer = null;
  idleTimer = null;
}
