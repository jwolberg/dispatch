import { useParams } from "react-router-dom";
import { Page } from "../components/Page.js";
import { StatusChip } from "../components/StatusChip.js";
import { usePolling } from "../hooks/usePolling.js";
import { ticketsApi, type Check } from "../api/tickets.js";
import { SteerBox } from "../components/SteerBox.js";
import { ShipButton } from "../components/ShipButton.js";

const CHECK_CLS: Record<Check["state"], string> = {
  success: "text-status-ok",
  failure: "text-status-fail",
  pending: "text-status-wait",
  neutral: "text-gray-400",
};
const CHECK_ICON: Record<Check["state"], string> = {
  success: "✓",
  failure: "✕",
  pending: "◐",
  neutral: "•",
};

// Render Claude's progress comment, reflecting markdown checkboxes as ☑ / ☐.
function ProgressBody({ body }: { body: string }) {
  return (
    <div className="text-body text-gray-200">
      {body.split("\n").map((line, i) => {
        const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
        if (m) {
          const checked = m[1].toLowerCase() === "x";
          return (
            <div key={i} className="flex items-start gap-2">
              <span className={checked ? "text-status-ok" : "text-gray-500"}>
                {checked ? "☑" : "☐"}
              </span>
              <span className={checked ? "text-gray-300 line-through" : ""}>{m[2]}</span>
            </div>
          );
        }
        return (
          <div key={i} className="whitespace-pre-wrap">
            {line}
          </div>
        );
      })}
    </div>
  );
}

export function CardDetailPage() {
  const { id } = useParams();
  const ticketId = Number(id);
  const { data, error, refetch } = usePolling(() => ticketsApi.get(ticketId), 10_000);

  if (error) {
    return (
      <Page title="Ticket">
        <div className="rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-body text-status-fail">
          {error}
        </div>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Ticket">
        <p className="text-body text-gray-500">Loading…</p>
      </Page>
    );
  }

  const { status, repo, ticket } = data;

  return (
    <Page title={`#${ticket.issue_number}${status ? ` · ${status.issue.title}` : ""}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {status && <StatusChip column={status.column} />}
        <span className="text-label text-gray-500">{repo.path}</span>
        {status && (
          <a className="text-label text-status-info underline" href={status.issue.url} target="_blank" rel="noreferrer">
            Open issue ↗
          </a>
        )}
        {ticket.chat_id != null && (
          <a className="text-label text-gray-400 underline" href="/chat">
            spec chat
          </a>
        )}
      </div>

      {!status ? (
        <p className="text-body text-gray-500">Syncing with provider…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-2 text-body font-semibold text-gray-200">Issue</h2>
            <div className="whitespace-pre-wrap text-body text-gray-300">{status.issue.body}</div>
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-2 text-body font-semibold text-gray-200">Claude progress</h2>
            {status.progressComment ? (
              <ProgressBody body={status.progressComment.body} />
            ) : (
              <p className="text-body text-gray-500">No progress comment yet.</p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-2 text-body font-semibold text-gray-200">Pull request</h2>
            {status.pr ? (
              <>
                <a className="text-body text-status-info underline" href={status.pr.url} target="_blank" rel="noreferrer">
                  PR #{status.pr.number}: {status.pr.title} ↗
                </a>
                <div className="mt-1 text-label text-gray-400">
                  {status.pr.headBranch} → {status.pr.baseBranch}
                  {status.pr.changedFiles != null && ` · ${status.pr.changedFiles} files`}
                  {status.pr.additions != null && ` · +${status.pr.additions}/-${status.pr.deletions}`}
                </div>
                {(() => {
                  const live = status.pr.previewUrl;
                  const pattern = repo.preview_url_pattern
                    ? repo.preview_url_pattern.replace(/\{n\}/g, String(status.pr.number))
                    : null;
                  const url = live ?? pattern;
                  if (!url) return null;
                  return (
                    <a
                      className="mt-2 inline-block rounded bg-blue-600 px-3 py-1.5 text-label font-medium text-white hover:bg-blue-500"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Preview ↗{live ? "" : " (pattern)"}
                    </a>
                  );
                })()}
                <ul className="mt-2 flex flex-col gap-1">
                  {status.pr.checks.map((c, i) => (
                    <li key={i} className="flex items-center gap-2 text-label">
                      <span className={CHECK_CLS[c.state]}>{CHECK_ICON[c.state]}</span>
                      {c.url ? (
                        <a className="underline" href={c.url} target="_blank" rel="noreferrer">
                          {c.name}
                        </a>
                      ) : (
                        <span>{c.name}</span>
                      )}
                    </li>
                  ))}
                  {status.pr.checks.length === 0 && (
                    <li className="text-label text-gray-500">No checks reported.</li>
                  )}
                </ul>
                <ShipButton
                  ticketId={ticket.id}
                  pr={status.pr}
                  repoPath={repo.path}
                  mergeMethod={repo.merge_method}
                  ready={status.column === "Ready to test"}
                  onMerged={() => void refetch()}
                />
              </>
            ) : (
              <p className="text-body text-gray-500">No linked PR yet.</p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-2 text-body font-semibold text-gray-200">
              {status.column === "Shipped" ? "Deploy runs" : "Workflow runs"}
            </h2>
            {status.runs.length ? (
              <ul className="flex flex-col gap-1">
                {status.runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-label text-gray-300">
                    <span className="text-gray-500">{r.state}</span>
                    {r.url ? (
                      <a className="underline" href={r.url} target="_blank" rel="noreferrer">
                        {r.name}
                      </a>
                    ) : (
                      <span>{r.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-gray-500">No runs yet.</p>
            )}
          </section>

          <div className="lg:col-span-2">
            <SteerBox ticketId={ticket.id} hasPR={Boolean(status.pr)} />
          </div>
        </div>
      )}
    </Page>
  );
}
