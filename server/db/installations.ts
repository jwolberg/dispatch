import type Database from "better-sqlite3";
import { getDb } from "./migrate.js";
import { ENCRYPTION_KEY_ENV, decryptSecret, encryptSecret, loadEncryptionKey } from "../lib/crypto.js";
import { registerSecret } from "../lib/redaction.js";
import type { Installation, InstallationStore, RepoKey } from "../providers/index.js";

// Durable backing for GitHub App registration and installation lookup (#2).
//
// This is the store that makes #3's `InstallationStore` seam load-bearing:
// `server/index.ts` injects it at boot, and from then on a repo under an App
// installation polls with a minted installation token instead of GITHUB_TOKEN.
//
// Two tables, both CONFIDENTIAL (see schema.sql). Every secret column is an
// AES-256-GCM envelope; the plaintext exists only in memory, and only after being
// registered with the redactor so it can never reach a log line (ADR-0006 [6.3]).

export interface AppRecord {
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  /** PEM. Encrypted at rest; registered with the redactor whenever it is read. */
  privateKey: string;
  webhookSecret: string;
  htmlUrl?: string | null;
}

export interface InstallationRecord {
  installationId: number;
  accountLogin: string;
  accountType: string | null;
  repositorySelection: "all" | "selected";
  /** The repos GitHub granted, as `owner/name`. Empty when selection is 'all'. */
  repos: string[];
}

interface AppRow {
  app_id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret_enc: string;
  private_key_enc: string;
  webhook_secret_enc: string;
  html_url: string | null;
}

interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_type: string | null;
  repository_selection: string;
  repos_json: string;
}

/** Owner half of an `owner/name` path, lowercased. */
function ownerOf(path: string): string {
  return path.split("/")[0]?.toLowerCase() ?? "";
}

export class SqliteInstallationStore implements InstallationStore {
  /**
   * @param onChange Called after every write. Wired to `resetProviderCache()` at
   *   boot, and it is not optional housekeeping.
   *
   *   `providers/index.ts` memoizes one adapter — and therefore one
   *   `AppTokenSource` holding one `privateKey` — per
   *   `(provider, host, installationId)`, for the life of the process. If the
   *   operator regenerates the App's private key, or uninstalls and reinstalls,
   *   that memoized source keeps minting against credentials that no longer
   *   exist. A 401 triggers exactly one re-mint, and the re-mint reuses the same
   *   stale key, so the adapter fails permanently until the process restarts.
   *
   *   This store is the only thing that knows an installation changed.
   */
  constructor(
    private readonly db: Database.Database,
    private readonly key: Buffer,
    private readonly onChange: () => void
  ) {}

  // --- App (singleton) -----------------------------------------------------

  saveApp(app: AppRecord): void {
    this.db
      .prepare(
        `INSERT INTO github_app (
           id, app_id, slug, name, client_id,
           client_secret_enc, private_key_enc, webhook_secret_enc, html_url, created_at
         ) VALUES (1, @app_id, @slug, @name, @client_id,
           @client_secret, @private_key, @webhook_secret, @html_url, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           app_id = @app_id, slug = @slug, name = @name, client_id = @client_id,
           client_secret_enc = @client_secret, private_key_enc = @private_key,
           webhook_secret_enc = @webhook_secret, html_url = @html_url`
      )
      .run({
        app_id: app.appId,
        slug: app.slug,
        name: app.name,
        client_id: app.clientId,
        client_secret: encryptSecret(app.clientSecret, this.key),
        private_key: encryptSecret(app.privateKey, this.key),
        webhook_secret: encryptSecret(app.webhookSecret, this.key),
        html_url: app.htmlUrl ?? null,
        created_at: new Date().toISOString(),
      });

    this.onChange();
  }

  getApp(): AppRecord | null {
    const row = this.db.prepare("SELECT * FROM github_app WHERE id = 1").get() as AppRow | undefined;
    if (!row) return null;

    const privateKey = this.reveal(row.private_key_enc);
    return {
      appId: row.app_id,
      slug: row.slug,
      name: row.name,
      clientId: row.client_id,
      clientSecret: this.reveal(row.client_secret_enc),
      privateKey,
      webhookSecret: this.reveal(row.webhook_secret_enc),
      htmlUrl: row.html_url,
    };
  }

  /**
   * Decrypt, and tell the redactor about the plaintext before returning it.
   *
   * The registration is the point. `redactSecrets()` scans `SECRET_ENV_KEYS` out
   * of `process.env`, and a key that lives in SQLite is never in `process.env` —
   * so without this, `safeMessage()` returns a PEM verbatim into a log line or an
   * error response body.
   */
  private reveal(envelope: string): string {
    const plaintext = decryptSecret(envelope, this.key);
    registerSecret(plaintext);
    return plaintext;
  }

  // --- Installations -------------------------------------------------------

  saveInstallation(rec: InstallationRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO installations (
           installation_id, account_login, account_type,
           repository_selection, repos_json, created_at, updated_at
         ) VALUES (@id, @login, @type, @selection, @repos, @now, @now)
         ON CONFLICT(installation_id) DO UPDATE SET
           account_login = @login, account_type = @type,
           repository_selection = @selection, repos_json = @repos, updated_at = @now`
      )
      .run({
        id: rec.installationId,
        login: rec.accountLogin,
        type: rec.accountType,
        selection: rec.repositorySelection,
        repos: JSON.stringify(rec.repos),
        now,
      });

    this.onChange();
  }

  deleteInstallation(installationId: number): void {
    this.db.prepare("DELETE FROM installations WHERE installation_id = ?").run(installationId);
    this.onChange();
  }

  listInstallations(): InstallationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM installations ORDER BY installation_id")
      .all() as InstallationRow[];
    return rows.map(toRecord);
  }

  // --- The seam ------------------------------------------------------------

  /**
   * The installation covering `key`, or null to fall back to `GITHUB_TOKEN`.
   *
   * Resolution is by *account*, because that is the grain GitHub installs an App
   * at. The granted repo list narrows it: when the operator chose "only select
   * repositories" and this repo is not among them, we return null rather than
   * handing back a token that would 404 on every call — and a repo they were
   * already tracking with GITHUB_TOKEN keeps working.
   *
   * The cost of that choice is that `repos_json` going stale (they granted a repo
   * on github.com after installing) silently keeps that repo on the env token.
   * #17's webhooks are what will refresh it; until then, re-running the install
   * flow does.
   */
  forRepo(key: RepoKey): Installation | null {
    if (key.provider !== "github") return null; // GitLab has no App story

    const app = this.db.prepare("SELECT app_id, private_key_enc FROM github_app WHERE id = 1").get() as
      | Pick<AppRow, "app_id" | "private_key_enc">
      | undefined;
    if (!app) return null;

    const row = this.db
      .prepare("SELECT * FROM installations WHERE LOWER(account_login) = ?")
      .get(ownerOf(key.path)) as InstallationRow | undefined;
    if (!row) return null;

    const rec = toRecord(row);
    if (rec.repositorySelection === "selected" && !grants(rec, key.path)) return null;

    return {
      installationId: rec.installationId,
      appId: app.app_id,
      privateKey: this.reveal(app.private_key_enc),
    };
  }
}

function toRecord(row: InstallationRow): InstallationRecord {
  let repos: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.repos_json);
    if (Array.isArray(parsed)) repos = parsed.filter((r): r is string => typeof r === "string");
  } catch {
    /* corrupt row → treat as no grants; the install flow rewrites it */
  }

  return {
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection === "selected" ? "selected" : "all",
    repos,
  };
}

/** Case-insensitive, because GitHub paths are. */
function grants(rec: InstallationRecord, path: string): boolean {
  const wanted = path.toLowerCase();
  return rec.repos.some((r) => r.toLowerCase() === wanted);
}

/** True when this deployment has registered an App. */
export function hasRegisteredApp(db: Database.Database = getDb()): boolean {
  const row = db.prepare("SELECT 1 AS present FROM github_app WHERE id = 1").get();
  return row !== undefined;
}

/** Test + ops hook. Drops the App and every installation. */
export function clearInstallations(db: Database.Database = getDb()): void {
  db.exec("DELETE FROM installations; DELETE FROM github_app;");
}

/**
 * Build the store to inject at boot, or null when there is nothing to unlock.
 *
 * Three states, and the middle one is the whole reason this function exists:
 *
 *  - **No App, no key** → null. The documented local-development path. Booting
 *    must not demand a key nobody needs yet.
 *  - **An App, no key** → throw. Its private key is ciphertext we cannot read.
 *    Falling back to GITHUB_TOKEN here would silently stop using the App the
 *    operator registered, which is exactly the failure this ticket exists to
 *    prevent. Refuse to boot instead.
 *  - **A key** → a store. (An App may not be registered yet; the manifest
 *    callback needs somewhere to write it.)
 */
export function openInstallationStore(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  onChange: () => void,
  db: Database.Database = getDb()
): SqliteInstallationStore | null {
  const registered = hasRegisteredApp(db);
  if (!env[ENCRYPTION_KEY_ENV]?.trim()) {
    if (!registered) return null;
    throw new Error(
      `A GitHub App is registered but ${ENCRYPTION_KEY_ENV} is not set, so its private key ` +
        `cannot be decrypted. Refusing to start rather than silently falling back to ` +
        `GITHUB_TOKEN. Restore the key, or clear the github_app table to re-register.`
    );
  }

  return new SqliteInstallationStore(db, loadEncryptionKey(env), onChange);
}
