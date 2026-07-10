import { listTickets } from "../db/tickets.js";
import { listRepos } from "../db/repos.js";
import { getStatus } from "../db/status.js";
import { safeReconcile } from "./reconcile.js";
import { discoverAllRepos } from "./discover.js";
import { getAccountProviders } from "../providers/index.js";
import { isPaused, leastRemaining, updateRateLimit } from "../lib/ratelimit.js";
import { safeMessage } from "../lib/redaction.js";

const ACTIVE_INTERVAL_MS = 20_000; // 20s for repos with active tickets (PRD F4.2)
const IDLE_INTERVAL_MS = 5 * 60_000; // 5min otherwise

let activeTimer: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let busy = false;

/** A ticket is "active" until its cached column reaches Shipped. */
function isActive(ticketId: number): boolean {
  const row = getStatus(ticketId);
  if (!row) return true; // never polled → poll it
  try {
    return (JSON.parse(row.payload_json) as { column?: string }).column !== "Shipped";
  } catch {
    return true;
  }
}

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

  for (const result of settled) {
    if (result.status === "rejected") {
      console.warn(`[poller] rate-limit check failed: ${safeMessage(result.reason)}`);
    }
  }

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
