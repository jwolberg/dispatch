import { useState } from "react";
import { ticketsApi } from "../api/tickets.js";
import { ApiError } from "../api/client.js";

// ci-* ids (#28) — must match the deployed skill name: and the server SkillId.
type Skill = "ci-plan" | "ci-implement" | "ci-debug";

const SKILLS: { id: Skill; label: string; hint: string }[] = [
  { id: "ci-plan", label: "Plan", hint: "Post a step-by-step plan first — no PR yet" },
  { id: "ci-implement", label: "Implement", hint: "Build it and open a PR (promotes Queued → Building)" },
  { id: "ci-debug", label: "Debug", hint: "Reproduce, root-cause, then push a minimal fix" },
];

// Drive a Claude Code skill on this ticket. Each posts a tailored @claude comment
// that claude-code-action runs in CI — Implement on a Queued ticket is what moves
// it to Building.
export function SkillBar({
  ticketId,
  column,
  hasPR,
  onRan,
}: {
  ticketId: number;
  column: string;
  hasPR: boolean;
  onRan: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Skill | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(skill: Skill) {
    setBusy(skill);
    setMsg(null);
    try {
      await ticketsApi.skill(ticketId, { skill, note: note.trim() || undefined });
      setNote("");
      const label = SKILLS.find((s) => s.id === skill)?.label ?? skill;
      setMsg(`${label} requested — Claude picks it up in CI.`);
      onRan();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-1 text-body font-semibold text-gray-200">Skills</h2>
      <p className="mb-3 text-label text-gray-500">
        Direct Claude with an <code>@claude</code> comment that runs in CI.
        {column === "Queued" && " Implement promotes this ticket to Building."}
        {!hasPR && " Debug targets the issue until a PR exists."}
      </p>
      <textarea
        className="mb-2 min-h-[52px] w-full resize-y rounded border border-border bg-bg px-2.5 py-1.5 text-body text-gray-100"
        placeholder="Optional: extra context for Claude…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {SKILLS.map((s) => (
          <button
            key={s.id}
            title={s.hint}
            onClick={() => void run(s.id)}
            disabled={busy != null}
            className={`rounded px-3 py-1.5 text-label font-medium disabled:opacity-50 ${
              s.id === "ci-implement"
                ? "bg-blue-600 text-white hover:bg-blue-500"
                : "border border-border text-gray-200 hover:bg-surface-2"
            }`}
          >
            {busy === s.id ? "Posting…" : s.label}
          </button>
        ))}
        {msg && <span className="text-label text-gray-400">{msg}</span>}
      </div>
    </section>
  );
}
