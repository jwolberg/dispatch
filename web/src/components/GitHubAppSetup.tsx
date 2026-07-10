import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { githubAppApi, submitManifest, type GithubAppState } from "../api/githubApp.js";

// #2 — register a GitHub App and install it, without a shell.
//
// Onboarding used to mean minting a fine-grained PAT against an exact scope
// matrix. This is the screen that removes it. There is no central Dispatch App:
// the operator registers their own, on their own account, and the one
// escalating-cost click happens on github.com (ADR-0006 [5]).

function KeyMissing() {
  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-4">
      <p className="mb-2 text-body font-medium text-amber-200">Set an encryption key first</p>
      <p className="mb-3 text-body text-gray-300">
        The App&apos;s private key is stored in Dispatch&apos;s database, so it has to be encrypted
        at rest before the database is ever snapshotted. Generate a key, set it as{" "}
        <code className="rounded bg-surface-2 px-1 text-label">DISPATCH_ENCRYPTION_KEY</code>, and
        restart.
      </p>
      <pre className="overflow-x-auto rounded bg-surface-2 p-2 text-label text-gray-200">
        openssl rand -base64 32
      </pre>
    </div>
  );
}

function Installations({ state }: { state: GithubAppState }) {
  if (state.installations.length === 0) {
    return (
      <p className="text-body text-gray-400">
        Not installed on any account yet. Install it to let Dispatch open pull requests and read
        checks without a personal access token.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {state.installations.map((i) => (
        <li
          key={i.installationId}
          className="flex items-center justify-between rounded border border-border bg-surface-2 px-3 py-2"
        >
          <span className="text-body text-white">
            {i.accountLogin}
            {i.accountType && <span className="ml-2 text-label text-gray-400">{i.accountType}</span>}
          </span>
          <span className="text-label text-gray-400">
            {i.repositorySelection === "all"
              ? "all repositories"
              : `${i.repoCount} ${i.repoCount === 1 ? "repository" : "repositories"}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function GitHubAppSetup() {
  const [state, setState] = useState<GithubAppState | null>(null);
  const [name, setName] = useState("Dispatch");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    githubAppApi
      .state()
      .then(setState)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      // Leaves the page: GitHub renders the App's permissions and the operator
      // confirms them there, on GitHub's own domain.
      submitManifest(await githubAppApi.manifest({ name: name.trim(), org: org.trim() || null }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  if (error && !state) return <p className="text-body text-red-400">{error}</p>;
  if (!state) return null;
  if (!state.encryptionKeyConfigured) return <KeyMissing />;

  if (state.registered && state.app) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-body font-medium text-white">{state.app.name}</p>
            <p className="text-label text-gray-400">App id {state.app.appId}</p>
          </div>
          {state.installUrl && (
            <a
              href={state.installUrl}
              className="rounded bg-blue-600 px-3 py-1.5 text-body text-white hover:bg-blue-500"
            >
              Install on repositories
            </a>
          )}
        </div>
        <Installations state={state} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div>
        <p className="text-body font-medium text-white">Connect GitHub</p>
        <p className="text-body text-gray-300">
          Register a GitHub App on your own account. Nothing about it is shared with anyone else, and
          you confirm its permissions on GitHub.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-label text-gray-400">App name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-border bg-surface-2 px-2 py-1.5 text-body text-white"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-label text-gray-400">
          Organization <span className="text-gray-500">(leave blank for your personal account)</span>
        </span>
        <input
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          placeholder="acme"
          className="rounded border border-border bg-surface-2 px-2 py-1.5 text-body text-white"
        />
      </label>

      {error && <p className="text-body text-red-400">{error}</p>}

      <button
        onClick={register}
        disabled={busy || !name.trim()}
        className="self-start rounded bg-blue-600 px-3 py-1.5 text-body text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {busy ? "Opening GitHub…" : "Register on GitHub"}
      </button>
    </div>
  );
}
