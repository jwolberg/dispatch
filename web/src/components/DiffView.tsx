import { useEffect, useState } from "react";
import { ticketsApi, type Diff, type DiffFile, type DiffUnavailable } from "../api/tickets.js";
import { parsePatch, type DiffLineKind } from "../lib/diffLines.js";
import { newLineNumberAt, formatSteerComment } from "../lib/steerAnchor.js";
import { ApiError } from "../api/client.js";

// T2-1 (ticket #11) — the in-app diff view.
//
// The feature that keeps a professional from bouncing to github.com. It renders
// the unified diff the server already bounds (boundDiff): every file's path and
// line counts, and its patch coloured by direction. When the server clips a
// patch or the provider capped the file list, that truncation is SHOWN — never
// dropped silently — with a link out to the provider for the whole thing. This
// closes the common loop, not every loop (deep review still links out).
//
// T2-2 (ticket #12) — and steer from it: click a diff line to post an @claude
// comment anchored to that file:line at the current head sha, through the same
// POST /comment path the SteerBox uses. The comment quotes the code so a later
// push cannot silently retarget it (see lib/steerAnchor).

/** Inline composer under a clicked diff line — posts an @claude steer comment. */
function LineComment({
  ticketId,
  file,
  line,
  code,
  headSha,
  onClose,
}: {
  ticketId: number;
  file: string;
  line: number;
  code: string;
  headSha: string;
  onClose: (posted: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post() {
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await ticketsApi.comment(ticketId, {
        body: formatSteerComment({ file, line, code, headSha }, note),
        target: "pr",
      });
      onClose(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-y border-border bg-surface px-3 py-2">
      <div className="mb-1 text-label text-gray-500">
        Steer @claude on <span className="font-mono text-gray-300">{file}</span> line {line}
      </div>
      <textarea
        autoFocus
        className="w-full resize-y rounded border border-border bg-bg px-2 py-1 text-label text-gray-200 placeholder:text-gray-500"
        rows={2}
        placeholder="What should Claude change here?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <div className="mt-1 text-label text-status-fail">{error}</div>}
      <div className="mt-1 flex gap-2">
        <button
          className="rounded bg-blue-600 px-2.5 py-1 text-label font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          disabled={busy || !note.trim()}
          onClick={() => void post()}
        >
          {busy ? "Posting…" : "Post @claude comment"}
        </button>
        <button
          className="rounded px-2.5 py-1 text-label text-gray-400 hover:text-gray-200"
          onClick={() => onClose(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const LINE_CLS: Record<DiffLineKind, string> = {
  add: "bg-status-ok/10 text-status-ok",
  del: "bg-status-fail/10 text-status-fail",
  hunk: "bg-surface-2 text-gray-400",
  meta: "text-gray-500",
  context: "text-gray-300",
};

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  renamed: "renamed",
};

// Never surface a raw error to someone who cannot act on it — a quiet line.
const UNAVAILABLE_TEXT: Record<DiffUnavailable, string> = {
  "no-pr": "No diff yet — Claude hasn't opened a pull request.",
  error: "Couldn't load the diff. Reload to try again.",
};

function FilePatch({
  file,
  ticketId,
  headSha,
}: {
  file: DiffFile;
  ticketId: number;
  headSha: string | null;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  if (file.patch === null) {
    return (
      <p className="px-3 py-2 text-label text-gray-500">
        {file.additions === 0 && file.deletions === 0
          ? "Binary file — no text diff."
          : "Diff omitted (too large to show here). Open the PR for the full change."}
      </p>
    );
  }
  const patch = file.patch;
  const lines = parsePatch(patch);

  return (
    <div className="overflow-x-auto text-label leading-relaxed">
      {lines.map((line, i) => {
        const commentable = line.kind === "add" || line.kind === "context" || line.kind === "del";
        const lineNo = newLineNumberAt(patch, i);
        const canSteer = commentable && headSha != null;
        return (
          <div key={i}>
            <div
              className={`group flex ${LINE_CLS[line.kind]} ${canSteer ? "cursor-pointer" : ""}`}
              onClick={canSteer ? () => setOpenAt(openAt === i ? null : i) : undefined}
              title={canSteer ? "Comment on this line to steer @claude" : undefined}
            >
              {canSteer && (
                <span className="w-5 shrink-0 select-none text-center text-gray-600 group-hover:text-blue-400">
                  +
                </span>
              )}
              <span className={`flex-1 px-1 ${canSteer ? "" : "pl-6"}`}>{line.text || " "}</span>
            </div>
            {openAt === i && canSteer && headSha && (
              <LineComment
                ticketId={ticketId}
                file={file.path}
                line={lineNo ?? 0}
                code={line.text.replace(/^[+\- ]/, "")}
                headSha={headSha}
                onClose={() => setOpenAt(null)}
              />
            )}
          </div>
        );
      })}
      {file.patchTruncated && (
        <div className="px-3 py-1 text-label italic text-status-wait">
          … patch truncated — open the PR for the rest of this file.
        </div>
      )}
    </div>
  );
}

/**
 * Fetch once per (ticket, head SHA) — deliberately NOT on the card's 10s poll,
 * mirroring the summary. The server bounds the payload and the provider seam
 * caches it by ETag, so a re-open of an unchanged PR costs no fresh download.
 */
export function DiffView({ ticketId, headSha }: { ticketId: number; headSha: string | null }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [unavailable, setUnavailable] = useState<DiffUnavailable | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!headSha) {
      setDiff(null);
      setUnavailable("no-pr");
      return;
    }

    let active = true;
    setLoading(true);
    ticketsApi
      .diff(ticketId)
      .then((res) => {
        if (!active) return;
        setDiff(res.diff);
        setUnavailable(res.unavailable);
      })
      .catch(() => {
        if (active) setUnavailable("error");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [ticketId, headSha]);

  if (loading) return <p className="text-body text-gray-500">Loading the diff…</p>;

  if (!diff) {
    if (!unavailable || unavailable === "no-pr")
      return <p className="text-body text-gray-500">No linked PR yet.</p>;
    return <p className="text-label text-gray-500">{UNAVAILABLE_TEXT[unavailable]}</p>;
  }

  if (diff.files.length === 0) {
    return <p className="text-body text-gray-500">This PR changes no files.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {diff.truncated && (
        <p className="rounded border border-status-wait/40 bg-status-wait/10 px-3 py-2 text-label text-status-wait">
          This diff is truncated — some files or patches were clipped to keep the page fast.
          Open the PR for the complete change.
        </p>
      )}
      {diff.files.map((file) => (
        <div key={file.path} className="overflow-hidden rounded border border-border">
          <div className="flex flex-wrap items-baseline gap-x-2 border-b border-border bg-surface-2 px-3 py-1.5">
            <span className="text-label font-mono text-gray-200">{file.path}</span>
            <span className="text-label text-gray-500">{STATUS_LABEL[file.status]}</span>
            <span className="text-label text-status-ok">+{file.additions}</span>
            <span className="text-label text-status-fail">−{file.deletions}</span>
          </div>
          <FilePatch file={file} ticketId={ticketId} headSha={headSha} />
        </div>
      ))}
    </div>
  );
}
