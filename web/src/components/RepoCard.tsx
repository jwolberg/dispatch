import type { TrackedRepo } from "../api/types.js";

function freshness(iso: string | null): string {
  if (!iso) return "never";
  const ageMs = Date.now() - Date.parse(iso);
  const mins = Math.round(ageMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Tracked-repo card (PRD F1.4) — also the "what does Claude know" view.
export function RepoCard({
  repo,
  busy,
  onRefresh,
  onUntrack,
  onSetup,
}: {
  repo: TrackedRepo;
  busy: boolean;
  onRefresh: () => void;
  onUntrack: () => void;
  onSetup: () => void;
}) {
  const noAutomation = repo.automation_detected === 0;
  // `claude-code-action` is GitHub-only; the setup route answers 501 for GitLab, so
  // do not offer a button that cannot work. The warning still tells the truth.
  const canSetUp = repo.provider === "github";
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-label uppercase tracking-wide text-gray-300">
          {repo.provider}
        </span>
        <span className="text-body font-medium text-white">{repo.path}</span>
      </div>

      {repo.description && (
        <p className="mb-2 text-body text-gray-300">{repo.description}</p>
      )}

      {repo.structure_summary.length > 0 && (
        <p className="mb-2 font-mono text-label text-gray-400">
          {repo.structure_summary.map((s) => `${s.dir}/`).join(" · ")}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-gray-400">
        <span className={repo.has_claude_md ? "text-status-ok" : "text-gray-500"}>
          {repo.has_claude_md ? "✓ CLAUDE.md" : "○ no CLAUDE.md"}
        </span>
        {repo.default_branch && <span>branch: {repo.default_branch}</span>}
        {repo.language && <span>{repo.language}</span>}
        <span>context: {freshness(repo.context_refreshed_at)}</span>
      </div>

      {noAutomation && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-status-wait/40 bg-status-wait/10 px-2.5 py-1.5 text-label text-status-wait">
          <span>
            ⚠ Tracked, but not onboarded — no Claude workflow in this repo, so{" "}
            <code>@claude</code> will not build anything.
          </span>
          {canSetUp ? (
            <button
              className="rounded bg-status-wait/20 px-2 py-0.5 font-medium text-status-wait hover:bg-status-wait/30 disabled:opacity-50"
              onClick={onSetup}
              disabled={busy}
            >
              Set up automation
            </button>
          ) : (
            <a
              className="underline"
              href="https://github.com/anthropics/claude-code-action#readme"
              target="_blank"
              rel="noreferrer"
            >
              Setup guide
            </a>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          className="rounded border border-border px-2.5 py-1 text-label text-gray-200 hover:bg-surface-2 disabled:opacity-50"
          onClick={onRefresh}
          disabled={busy}
        >
          Refresh context
        </button>
        <button
          className="rounded border border-border px-2.5 py-1 text-label text-status-fail hover:bg-surface-2 disabled:opacity-50"
          onClick={onUntrack}
          disabled={busy}
        >
          Untrack
        </button>
      </div>
    </div>
  );
}
