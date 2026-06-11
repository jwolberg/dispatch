import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/env.js";
import { getDb, DB_PATH } from "./db/migrate.js";
import { healthRouter } from "./routes/health.js";
import { discoverRouter } from "./routes/discover.js";
import { reposRouter } from "./routes/repos.js";
import { chatRouter } from "./routes/chat.js";
import { ticketsRouter } from "./routes/tickets.js";
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

// Open + migrate the local store on boot. Idempotent; recreates the file if it
// was deleted (the board then rebuilds from the provider on first poll).
getDb();
console.log(`[dispatch] sqlite ready at ${DB_PATH}`);

const app = express();
// Shared-password gate (no-op unless DISPATCH_PASSWORD is set) — runs before
// everything so unauthenticated requests never reach routes or static assets.
app.use(basicAuthGate);
app.use(express.json());

const api = express.Router();
api.use("/health", healthRouter);
api.use("/discover", discoverRouter);
api.use("/repos", reposRouter);
api.use("/chat", chatRouter);
api.use("/tickets", ticketsRouter);
api.use("/board", boardRouter);
api.use("/activity", activityRouter);
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
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
