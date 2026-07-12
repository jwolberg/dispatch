import { useEffect, useState } from "react";
import { ticketsApi, type Diff, type DiffFile, type DiffUnavailable } from "../api/tickets.js";
import { parsePatch, type DiffLineKind } from "../lib/diffLines.js";

// T2-1 (ticket #11) — the in-app diff view.
//
// The feature that keeps a professional from bouncing to github.com. It renders
// the unified diff the server already bounds (boundDiff): every file's path and
// line counts, and its patch coloured by direction. When the server clips a
// patch or the provider capped the file list, that truncation is SHOWN — never
// dropped silently — with a link out to the provider for the whole thing. This
// closes the common loop, not every loop (deep review still links out).

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

function FilePatch({ file }: { file: DiffFile }) {
  if (file.patch === null) {
    return (
      <p className="px-3 py-2 text-label text-gray-500">
        {file.additions === 0 && file.deletions === 0
          ? "Binary file — no text diff."
          : "Diff omitted (too large to show here). Open the PR for the full change."}
      </p>
    );
  }
  return (
    <pre className="overflow-x-auto text-label leading-relaxed">
      {parsePatch(file.patch).map((line, i) => (
        <div key={i} className={`px-3 ${LINE_CLS[line.kind]}`}>
          {line.text || " "}
        </div>
      ))}
      {file.patchTruncated && (
        <div className="px-3 py-1 text-label italic text-status-wait">
          … patch truncated — open the PR for the rest of this file.
        </div>
      )}
    </pre>
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
          <FilePatch file={file} />
        </div>
      ))}
    </div>
  );
}
