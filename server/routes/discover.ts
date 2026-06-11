import { Router } from "express";
import { getProvider } from "../providers/index.js";
import type { ProviderId } from "../providers/index.js";
import { safeMessage } from "../lib/redaction.js";
import { httpStatus } from "../lib/errors.js";

export const discoverRouter = Router();

const VALID_PROVIDERS: ProviderId[] = ["github", "gitlab"];

// GET /api/discover?provider=github|gitlab — list every repo the token can
// reach, normalized to RepoSummary[] (PRD F1.0).
discoverRouter.get("/", async (req, res) => {
  const provider = String(req.query.provider ?? "github") as ProviderId;
  if (!VALID_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `Unknown provider: ${provider}` });
    return;
  }

  try {
    const repos = await getProvider(provider).discoverRepos();
    res.json({ provider, repos });
  } catch (err) {
    res.status(httpStatus(err) ?? 502).json({ error: safeMessage(err) });
  }
});
