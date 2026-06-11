import { useEffect, useMemo, useState } from "react";
import { Page } from "../components/Page.js";
import { RepoCard } from "../components/RepoCard.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { reposApi } from "../api/repos.js";
import { ApiError } from "../api/client.js";
import type { RepoSummary, TrackedRepo } from "../api/types.js";

type Provider = "github" | "gitlab";

export function ReposPage() {
  const [tracked, setTracked] = useState<TrackedRepo[]>([]);
  const [discovered, setDiscovered] = useState<RepoSummary[]>([]);
  const [provider, setProvider] = useState<Provider>("github");
  const [search, setSearch] = useState("");
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUntrack, setConfirmUntrack] = useState<TrackedRepo | null>(null);

  const trackedPaths = useMemo(
    () => new Set(tracked.map((r) => `${r.provider}:${r.path}`)),
    [tracked]
  );

  async function loadTracked() {
    const { repos } = await reposApi.list();
    setTracked(repos);
  }

  async function loadDiscovery(p: Provider) {
    setDiscoverError(null);
    try {
      const { repos } = await reposApi.discover(p);
      setDiscovered(repos);
    } catch (err) {
      setDiscovered([]);
      setDiscoverError(err instanceof ApiError ? err.message : String(err));
    }
  }

  useEffect(() => {
    loadTracked().catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadDiscovery(provider);
  }, [provider]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = discovered.filter((r) => !trackedPaths.has(`${r.provider}:${r.path}`));
    if (!q) return list;
    return list.filter(
      (r) =>
        r.path.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q)
    );
  }, [discovered, search, trackedPaths]);

  async function track(body: Parameters<typeof reposApi.track>[0], key: string) {
    setBusyId(key);
    setError(null);
    try {
      await reposApi.track(body);
      await loadTracked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function refresh(repo: TrackedRepo) {
    const key = `t:${repo.id}`;
    setBusyId(key);
    setError(null);
    try {
      const { repo: updated } = await reposApi.refresh(repo.id);
      setTracked((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function untrack(repo: TrackedRepo) {
    setBusyId(`t:${repo.id}`);
    try {
      await reposApi.untrack(repo.id);
      await loadTracked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
      setConfirmUntrack(null);
    }
  }

  return (
    <Page title="Repos">
      {error && (
        <div className="mb-4 rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-body text-status-fail">
          {error}
        </div>
      )}

      <h2 className="mb-2 text-body font-semibold text-gray-200">Tracked</h2>
      {tracked.length === 0 ? (
        <p className="mb-6 text-body text-gray-500">No repos tracked yet — track one below.</p>
      ) : (
        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          {tracked.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              busy={busyId === `t:${repo.id}`}
              onRefresh={() => refresh(repo)}
              onUntrack={() => setConfirmUntrack(repo)}
            />
          ))}
        </div>
      )}

      <h2 className="mb-2 text-body font-semibold text-gray-200">Discover</h2>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-border bg-surface px-2 py-1.5 text-body text-gray-200"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
        >
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
        </select>
        <input
          className="flex-1 rounded border border-border bg-surface px-2.5 py-1.5 text-body text-gray-100 placeholder:text-gray-500"
          placeholder="Filter by path or description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {discoverError && (
        <div className="mb-3 rounded border border-status-wait/40 bg-status-wait/10 px-3 py-2 text-label text-status-wait">
          {discoverError}
        </div>
      )}

      <div className="mb-6 divide-y divide-border overflow-hidden rounded-lg border border-border">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-body text-gray-500">No repos to show.</p>
        ) : (
          filtered.map((r) => {
            const key = `d:${r.provider}:${r.path}`;
            return (
              <div key={key} className="flex items-center gap-3 bg-surface px-3 py-2">
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-label uppercase text-gray-300">
                  {r.provider}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body text-white">{r.path}</div>
                  {r.description && (
                    <div className="truncate text-label text-gray-400">{r.description}</div>
                  )}
                </div>
                {r.lastActivity && (
                  <span className="hidden text-label text-gray-500 sm:inline">
                    {new Date(r.lastActivity).toLocaleDateString()}
                  </span>
                )}
                <button
                  className="rounded bg-blue-600 px-2.5 py-1 text-label font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  disabled={busyId === key}
                  onClick={() =>
                    track(
                      {
                        provider: r.provider,
                        host: r.host,
                        path: r.path,
                        default_branch: r.defaultBranch,
                        web_url: r.webUrl,
                      },
                      key
                    )
                  }
                >
                  {busyId === key ? "Tracking…" : "Track"}
                </button>
              </div>
            );
          })
        )}
      </div>

      <h2 className="mb-2 text-body font-semibold text-gray-200">Add manually</h2>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!manual.trim()) return;
          const value = manual.trim();
          const body = /^https?:\/\//i.test(value) ? { url: value } : { path: value };
          track(body, "manual").then(() => setManual(""));
        }}
      >
        <input
          className="flex-1 rounded border border-border bg-surface px-2.5 py-1.5 text-body text-gray-100 placeholder:text-gray-500"
          placeholder="owner/name or full repo URL (incl. self-hosted GitLab)"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button
          type="submit"
          className="rounded bg-blue-600 px-3 py-1.5 text-body font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={busyId === "manual"}
        >
          {busyId === "manual" ? "Adding…" : "Track"}
        </button>
      </form>

      <ConfirmModal
        open={confirmUntrack != null}
        title="Untrack repo?"
        danger
        confirmLabel="Untrack"
        busy={busyId === `t:${confirmUntrack?.id}`}
        onCancel={() => setConfirmUntrack(null)}
        onConfirm={() => confirmUntrack && untrack(confirmUntrack)}
      >
        Stop tracking <span className="font-medium text-white">{confirmUntrack?.path}</span>? Its
        tickets and chats are removed locally; nothing on the provider changes.
      </ConfirmModal>
    </Page>
  );
}
