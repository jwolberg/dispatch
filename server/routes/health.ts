import { Router } from "express";
import { getDb } from "../db/migrate.js";
import { getAccountProviders } from "../providers/index.js";
import type { AccountProvider, ProviderId } from "../providers/index.js";
import { safeMessage } from "../lib/redaction.js";
import { getGauge, leastRemaining } from "../lib/ratelimit.js";

const PROVIDERS: ProviderId[] = ["github", "gitlab"];

/** One credential's view of the provider. `label` is an account login or env var. */
interface AccountHealth {
  label: string;
  kind: "env" | "app";
  valid: boolean;
  remaining: number | null;
  limit: number | null;
  reset: string | null;
  error: string | null;
}

interface ProviderHealth {
  provider: ProviderId;
  /** True when *any* credential exists — a GitHub App counts, not just an env token. */
  configured: boolean;
  /** True when at least one credential works. */
  valid: boolean;
  /** The binding constraint: the smallest remaining budget across credentials. */
  remaining: number | null;
  limit: number | null;
  reset: string | null;
  error: string | null;
  accounts: AccountHealth[];
}

export interface HealthDeps {
  accounts: (provider: ProviderId) => AccountProvider[];
}

async function checkAccount(account: AccountProvider): Promise<AccountHealth> {
  try {
    const rl = await account.provider.getRateLimit();
    return { label: account.label, kind: account.kind, valid: true, ...rl, error: null };
  } catch (err) {
    return {
      label: account.label,
      kind: account.kind,
      valid: false,
      remaining: null,
      limit: null,
      reset: null,
      error: safeMessage(err),
    };
  }
}

/**
 * Ask every credential, then reduce.
 *
 * `configured` used to be `Boolean(process.env[tokenEnv])`, which reported
 * `configured: false` for a deployment that had a GitHub App registered and every
 * repo polling happily through it (#21). A credential is a credential.
 */
async function checkProvider(
  provider: ProviderId,
  accounts: AccountProvider[]
): Promise<ProviderHealth> {
  if (accounts.length === 0) {
    return {
      provider,
      configured: false,
      valid: false,
      remaining: null,
      limit: null,
      reset: null,
      error: null,
      accounts: [],
    };
  }

  const checked = await Promise.all(accounts.map(checkAccount));
  const working = checked.filter((a) => a.valid);
  const binding = leastRemaining(working);

  return {
    provider,
    configured: true,
    valid: working.length > 0,
    remaining: binding?.remaining ?? null,
    limit: binding?.limit ?? null,
    reset: binding?.reset ?? null,
    // Only a provider-level error when *nothing* works. One revoked installation
    // among three is a per-account failure, reported in `accounts`.
    error: working.length > 0 ? null : (checked.find((a) => a.error)?.error ?? null),
    accounts: checked,
  };
}

export function createHealthRouter(deps: Partial<HealthDeps> = {}): Router {
  const accounts = deps.accounts ?? getAccountProviders;
  const router = Router();

  // GET /api/health — credential validity, rate-limit remaining, DB status (PRD §6, S2).
  router.get("/", async (_req, res) => {
    let dbOk = false;
    try {
      getDb().prepare("SELECT 1").get();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const providers = await Promise.all(PROVIDERS.map((p) => checkProvider(p, accounts(p))));

    res.json({
      ok: dbOk,
      db: { ok: dbOk },
      anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY) },
      providers,
      rateLimit: getGauge(),
    });
  });

  return router;
}

export const healthRouter = createHealthRouter();
