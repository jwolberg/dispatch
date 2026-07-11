import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, warnIfEphemeralDb } from "./lib/env.js";
import { getDb, DB_PATH } from "./db/migrate.js";
import { restoreIfMissing, snapshotEnabled, snapshotMiddleware, flush, isDirty } from "./db/snapshot.js";
import { sqliteCondCacheStore } from "./db/http-cache.js";
import { openInstallationStore } from "./db/installations.js";
import { setCondCacheStore, setInstallationStore, resetProviderCache } from "./providers/index.js";
import { githubAppRouter } from "./routes/github-app.js";
import { healthRouter } from "./routes/health.js";
import { discoverRouter } from "./routes/discover.js";
import { reposRouter } from "./routes/repos.js";
import { chatRouter } from "./routes/chat.js";
import { ticketsRouter } from "./routes/tickets.js";
import { summaryRouter } from "./routes/summary.js";
import { startPoller } from "./poller/scheduler.js";
import { boardRouter } from "./routes/board.js";
import { safeMessage } from "./lib/redaction.js";
import { activityRouter } from "./routes/activity.js";
import { basicAuthGate } from "./lib/auth.js";

// Bootstrap the Dispatch backend. Route groups (discover, repos, chat, tickets,
// board, activity, health) are mounted under /api by later tickets; this
// scaffold establishes the process, the localhost bind guard, and the API mount
// point.
const config = loadConfig();

// Restore the GCS snapshot BEFORE opening the DB — Cloud Run's disk is
// ephemeral, so on a fresh revision the file is simply absent (#20). No-op
// locally, and when DISPATCH_GCS_BUCKET is unset.
await restoreIfMissing(DB_PATH);

// Open + migrate the local store on boot. Idempotent; recreates the file if it
// was deleted (the board then rebuilds from the provider on first poll).
getDb();
console.log(`[dispatch] sqlite ready at ${DB_PATH}`);
// Announce non-durable storage at boot rather than after a redeploy wipes it.
warnIfEphemeralDb(DB_PATH, snapshotEnabled());
if (snapshotEnabled()) console.log(`[dispatch] snapshotting state to gs://${process.env.DISPATCH_GCS_BUCKET}`);

// Back the adapters' conditional-request cache with SQLite so a restart (or a
// Cloud Run cold start) replays ETags instead of re-fetching everything (T0-9).
setCondCacheStore(sqliteCondCacheStore);

// Resolve each repo's credential through its GitHub App installation, when one
// exists (#2). Without this line #3's seam is dead code and AppTokenSource is
// never constructed in production — every repo silently falls back to
// GITHUB_TOKEN.
//
// `onChange` is resetProviderCache: adapters memoize one AppTokenSource, holding
// one private key, for the life of the process. A regenerated key or a reinstall
// must drop them, or they mint against dead credentials until a restart.
//
// Throws when an App is registered but DISPATCH_ENCRYPTION_KEY is gone. That is
// deliberate: reverting to GITHUB_TOKEN there would silently stop using the App.
const installations = openInstallationStore(process.env, resetProviderCache);
setInstallationStore(installations ?? undefined);
if (installations) {
  const app = installations.getApp();
  if (app) console.log(`[dispatch] github app "${app.slug}" (id ${app.appId}) registered`);
}

const app = express();
// Behind Cloud Run's proxy the client IP arrives in X-Forwarded-For; trust it so
// req.ip is the client, which the failed-auth limiter keys on (#32). The leftmost
// XFF hop is client-influenced — a known limitation, raised in auth-limiter.ts.
app.set("trust proxy", true);

// Health is reachable WITHOUT the password so an external uptime check can watch
// the public service (#32). It exposes only booleans + rate-limit counts — no
// secrets — so it is mounted ahead of the gate; everything else stays gated.
app.use("/api/health", healthRouter);

// Shared-password gate (no-op unless DISPATCH_PASSWORD is set) — runs before
// everything else so unauthenticated requests never reach routes or static assets.
app.use(basicAuthGate);
app.use(express.json());
// Upload a snapshot before acking any request that changed irreplaceable state.
// Must run before the routers so it can wrap the response (#20).
app.use(snapshotMiddleware());

const api = express.Router();
api.use("/discover", discoverRouter);
api.use("/repos", reposRouter);
api.use("/chat", chatRouter);
api.use("/tickets", ticketsRouter);
api.use("/tickets", summaryRouter); // T1-5: GET /tickets/:id/summary
api.use("/board", boardRouter);
api.use("/activity", activityRouter);
api.use("/github", githubAppRouter); // #2: manifest registration + install callback
app.use("/api", api);

// Production: serve the built SPA + client-side routing fallback when a web
// build is present (created by `npm run build`). Dev is unaffected — Vite
// serves the SPA there, and web/dist doesn't exist.
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // Any non-/api path returns index.html (SPA routes resolve client-side).
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(webDist, "index.html")));
  console.log(`[dispatch] serving SPA from ${webDist}`);
}

// Last-resort error handler: redact secrets from any uncaught error before it
// reaches the client or the logs (S2).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = safeMessage(err);
  console.error("[dispatch] unhandled error:", message);
  if (!res.headersSent) res.status(500).json({ error: message });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[dispatch] backend listening on http://${config.host}:${config.port}`);
  // Background reconciliation of provider state → status_cache (PRD F4.2).
  startPoller();
});

const shutdown = (signal: string) => {
  console.log(`[dispatch] received ${signal}, shutting down`);
  // Last chance to persist: the poller writes tickets outside any request, so a
  // redeploy could otherwise drop work adopted since the last mutating call.
  const persist = isDirty()
    ? flush().catch((err) => console.warn(`[dispatch] final snapshot failed: ${safeMessage(err)}`))
    : Promise.resolve();
  void persist.finally(() => server.close(() => process.exit(0)));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
