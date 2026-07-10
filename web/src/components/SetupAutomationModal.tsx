import { useState } from "react";
import { reposApi, type SetupResult } from "../api/repos.js";
import { ApiError } from "../api/client.js";
import type { TrackedRepo } from "../api/types.js";

/**
 * Onboard a tracked repo from the browser — the last shell step in the loop (#4).
 *
 * The token is held in component state for the duration of one POST and never
 * written to storage. Dispatch seals it with the repo's public key server-side and
 * writes exactly one secret; no GitHub credential enters the target repo.
 */
export function SetupAutomationModal({
  repo,
  onClose,
  onDone,
}: {
  repo: TrackedRepo;
  onClose: () => void;
  onDone: (repo: TrackedRepo) => void;
}) {
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<"oauth" | "apikey">("oauth");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await reposApi.setup(repo.id, { token: token.trim(), mode });
      setToken(""); // do not keep it in memory past the request
      setResult(res);
      onDone(res.repo);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-[15px] font-semibold text-white">Set up Claude automation</h2>
        <p className="mb-4 text-body text-gray-400">
          Commits <code className="text-gray-300">claude.yml</code>, a CI gate, and the
          plan/implement/debug skills to <span className="text-gray-200">{repo.path}</span>, and
          writes one secret: your Claude auth token.
        </p>

        {result ? (
          <div className="mb-5">
            <p className="mb-2 text-body text-status-ok">Done. Stack detected: {result.stack}.</p>
            <ul className="mb-3 flex flex-col gap-1 text-label text-gray-300">
              {result.files.map((f) => (
                <li key={f.path}>
                  <span className={f.committed ? "text-status-ok" : "text-gray-500"}>
                    {f.committed ? "committed" : "unchanged"}
                  </span>{" "}
                  {f.path}
                </li>
              ))}
            </ul>
            <p className="text-label text-gray-400">
              Secret set: {result.secrets.set.join(", ")}
              {result.secrets.deleted.length > 0 && ` · removed: ${result.secrets.deleted.join(", ")}`}
            </p>
          </div>
        ) : (
          <>
            <label className="mb-3 flex flex-col gap-1">
              <span className="text-label text-gray-400">Claude auth token</span>
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={mode === "oauth" ? "from `claude setup-token`" : "sk-ant-…"}
                className="rounded border border-border bg-surface-2 px-2 py-1.5 text-body text-white"
              />
            </label>

            <fieldset className="mb-4 flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-body text-gray-200">
                <input
                  type="radio"
                  checked={mode === "oauth"}
                  onChange={() => setMode("oauth")}
                />
                Subscription token (recommended)
              </label>
              <label className="flex items-center gap-2 text-body text-gray-200">
                <input
                  type="radio"
                  checked={mode === "apikey"}
                  onChange={() => setMode("apikey")}
                />
                API key (metered)
              </label>
              <p className="text-label text-gray-500">
                {mode === "oauth"
                  ? "Bills your Claude subscription. Any existing ANTHROPIC_API_KEY secret is removed — it outranks this token and would keep billing the API."
                  : "Bills the metered Anthropic API per build."}
              </p>
            </fieldset>
          </>
        )}

        {error && <p className="mb-3 text-body text-status-fail">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            className="rounded border border-border px-3 py-1.5 text-body text-gray-200 hover:bg-surface-2"
            onClick={onClose}
            disabled={busy}
          >
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button
              className="rounded bg-blue-600 px-3 py-1.5 text-body font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              onClick={submit}
              disabled={busy || !token.trim()}
            >
              {busy ? "Setting up…" : "Set up"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
