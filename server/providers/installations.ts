import type { ProviderId } from "./types.js";

/**
 * A GitHub App installation, and the credentials needed to mint tokens for it (#3).
 *
 * This type never escapes `server/providers/`. Callers name a *repo*; the factory
 * resolves the installation. That is the whole point of the injection in
 * `index.ts` — 14 call sites ask for a provider for a repo, and not one of them
 * should learn that installations exist.
 */
export interface Installation {
  /** GitHub's installation id. The memo discriminator. */
  installationId: number;
  appId: number;
  /** PEM. Held in memory only; never logged (see lib/redaction.ts). */
  privateKey: string;
}

/** The identity of a repo, as far as installation lookup is concerned. */
export interface RepoKey {
  provider: ProviderId;
  host?: string | null;
  path: string;
}

/**
 * Durable backing for installation lookup. Injected at boot by `server/index.ts`
 * so `providers/` never imports the db layer — the same shape, and the same
 * reason, as {@link CondCacheStore}.
 *
 * Unset (or returning `null`) means "no App installed": the factory falls back to
 * the `GITHUB_TOKEN`-backed adapter. That is the documented local-development
 * path, and it is the only path until #2 registers an App and persists rows here.
 */
export interface InstallationStore {
  forRepo(key: RepoKey): Installation | null;
}
