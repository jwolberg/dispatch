import { Router } from "express";
import { getDb } from "../db/migrate.js";
import { getProvider } from "../providers/index.js";
import type { ProviderId } from "../providers/index.js";
import { safeMessage } from "../lib/redaction.js";
import { getGauge } from "../lib/ratelimit.js";

export const healthRouter = Router();

interface ProviderHealth {
  provider: ProviderId;
  configured: boolean;
  valid: boolean;
  remaining: number | null;
  limit: number | null;
  reset: string | null;
  error: string | null;
}

async function checkProvider(provider: ProviderId, tokenEnv: string): Promise<ProviderHealth> {
  const configured = Boolean(process.env[tokenEnv]);
  if (!configured) {
    return { provider, configured: false, valid: false, remaining: null, limit: null, reset: null, error: null };
  }
  try {
    const rl = await getProvider(provider).getRateLimit();
    return {
      provider,
      configured: true,
      valid: true,
      remaining: rl.remaining,
      limit: rl.limit,
      reset: rl.reset,
      error: null,
    };
  } catch (err) {
    return {
      provider,
      configured: true,
      valid: false,
      remaining: null,
      limit: null,
      reset: null,
      error: safeMessage(err),
    };
  }
}

// GET /api/health — token validity, rate-limit remaining, DB status (PRD §6, S2).
healthRouter.get("/", async (_req, res) => {
  let dbOk = false;
  try {
    getDb().prepare("SELECT 1").get();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const providers = await Promise.all([
    checkProvider("github", "GITHUB_TOKEN"),
    checkProvider("gitlab", "GITLAB_TOKEN"),
  ]);

  const anthropicConfigured = Boolean(process.env.ANTHROPIC_API_KEY);

  res.json({
    ok: dbOk,
    db: { ok: dbOk },
    anthropic: { configured: anthropicConfigured },
    providers,
    rateLimit: getGauge(),
  });
});
