import { useParams } from "react-router-dom";
import { Page } from "../components/Page.js";
import { usePolling } from "../hooks/usePolling.js";
import { ticketsApi, type Check, type TicketDetail } from "../api/tickets.js";
import { ChangeSummaryCard } from "../components/ChangeSummaryCard.js";
import { VerdictChip } from "../components/VerdictChip.js";
import type { Column } from "../lib/verdict.js";
import { SteerBox } from "../components/SteerBox.js";
import { SkillBar } from "../components/SkillBar.js";
import { ShipButton } from "../components/ShipButton.js";
import { RevertButton } from "../components/RevertButton.js";
import { ago } from "../lib/time.js";

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

const RUN_CLS: Record<string, string> = {
  success: "text-status-ok",
  failure: "text-status-fail",
  queued: "text-status-wait",
  in_progress: "text-status-wait",
  neutral: "text-gray-400",
};

type Status = NonNullable<TicketDetail["status"]>;

// What to do next, in one sentence. The VERDICT (green/red/pending) is not
// decided here — `VerdictChip` derives it from the column alone, so there is
// exactly one implementation of "are we green" (T1-6). This only picks the
// sentence, which may legitimately consult runs and the plan comment.
function nextHint(s: Status): string {
  const running = s.runs.some((r) => r.state === "queued" || r.state === "in_progress");
  switch (s.column) {
    case "Deployed":
      return "Merged and deployed — nothing left to do.";
    case "Merged":
      return "Merged. Waiting on the default-branch deploy to finish.";
    case "Ready to test":
      return "Checks are green. Preview the PR, then Ship.";
    case "Blocked":
      return "A check or run failed. Click Debug to push a fix.";
    case "Building":
      return s.pr
        ? "Claude opened a PR — checks are running. Wait for them to finish."
        : "Claude is working — a run is in progress.";
    default: // Queued / Spec
      if (running) return "A run is in progress…";
      if (s.progressComment)
        return "Claude posted a plan below. Review it, then click Implement to build.";
      return "Not started. Click Implement to build — or Plan first.";
  }
}

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
        {/* No status chip here: the hero's VerdictChip is the card's single
            verdict (T1-6). Two colored chips saying the same thing is the noise
            this ticket removes. StatusChip still labels the Board columns. */}
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
        {data.updated_at && (
          <span className="text-label text-gray-500" title={new Date(data.updated_at).toLocaleString()}>
            updated {ago(data.updated_at)}
          </span>
        )}
      </div>

      {!status ? (
        <p className="text-body text-gray-500">Syncing with provider…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* The hero (T1-6): one verdict and the plain-language summary, above
              the fold. The reader cannot read a diff, and a list of check names
              tells them nothing. Everything else on this card is detail. */}
          <section className="lg:col-span-2 rounded-lg border border-border bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <VerdictChip column={status.column as Column} />
              <span className="text-label text-gray-400">{nextHint(status)}</span>
            </div>
            <ChangeSummaryCard ticketId={ticket.id} headSha={status.pr?.headSha ?? null} />
          </section>

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
                {/* Demoted behind a disclosure (T1-6). The verdict chip above
                    already answers "can I ship this"; seven check names answer a
                    question the reader did not ask. Collapsed by default. */}
                {status.pr.checks.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-label text-gray-500 hover:text-gray-300">
                      Show {status.pr.checks.length} check
                      {status.pr.checks.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-1.5 flex flex-col gap-1">
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
                    </ul>
                  </details>
                ) : (
                  <p className="mt-2 text-label text-gray-500">No checks reported.</p>
                )}
                <ShipButton
                  ticketId={ticket.id}
                  pr={status.pr}
                  repoPath={repo.path}
                  mergeMethod={repo.merge_method}
                  ready={status.column === "Ready to test"}
                  onMerged={() => void refetch()}
                />
                {/* Recovery, not a second way to ship: only once the PR merged (T1-8). */}
                {status.pr.merged && (
                  <RevertButton
                    ticketId={ticket.id}
                    pr={status.pr}
                    repoPath={repo.path}
                    provider={repo.provider}
                    revertPr={status.revertPr}
                  />
                )}
              </>
            ) : (
              <p className="text-body text-gray-500">No linked PR yet.</p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-2 text-body font-semibold text-gray-200">
              {status.column === "Merged" || status.column === "Deployed"
                ? "Deploy runs"
                : "Workflow runs"}
            </h2>
            {status.runs.length ? (
              <ul className="flex flex-col gap-1.5">
                {status.runs.map((r) => {
                  // Show the repo and what the run is (event + title), not the
                  // generic workflow name ("Claude Code"). Fall back to name when
                  // event/title are absent so the row is never empty.
                  const repoName = repo.path.split("/").pop() || repo.path;
                  const label =
                    [repoName, r.event, r.title].filter(Boolean).join(" · ") || r.name;
                  return (
                  <li key={r.id} className="flex items-center gap-2 text-label">
                    <span className={`w-20 shrink-0 ${RUN_CLS[r.state] ?? "text-gray-400"}`}>
                      {r.state.replace("_", " ")}
                    </span>
                    {r.url ? (
                      <a className="flex-1 truncate text-gray-200 underline" href={r.url} target="_blank" rel="noreferrer" title={label}>
                        {label}
                      </a>
                    ) : (
                      <span className="flex-1 truncate text-gray-200" title={label}>{label}</span>
                    )}
                    <span className="shrink-0 text-gray-500" title={new Date(r.createdAt).toLocaleString()}>
                      {ago(r.createdAt)}
                    </span>
                  </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-body text-gray-500">No runs yet.</p>
            )}
          </section>

          <div className="lg:col-span-2">
            <SkillBar
              ticketId={ticket.id}
              column={status.column}
              hasPR={Boolean(status.pr)}
              onRan={() => void refetch()}
            />
          </div>

          <div className="lg:col-span-2">
            <SteerBox ticketId={ticket.id} hasPR={Boolean(status.pr)} />
          </div>
        </div>
      )}
    </Page>
  );
}
