import express from "express";
import { loadConfig } from "./lib/env.js";
import { getDb, DB_PATH } from "./db/migrate.js";
import { healthRouter } from "./routes/health.js";
import { discoverRouter } from "./routes/discover.js";

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
app.use(express.json());

const api = express.Router();
api.use("/health", healthRouter);
api.use("/discover", discoverRouter);
app.use("/api", api);

const server = app.listen(config.port, config.host, () => {
  console.log(`[dispatch] backend listening on http://${config.host}:${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`[dispatch] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
