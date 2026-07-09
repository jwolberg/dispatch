import { verdictFor, TONE_CLS, type Column } from "../lib/verdict.js";

/**
 * The one verdict a non-engineer reads (T1-6). Derived from the column the
 * server already computed — see lib/verdict.ts for why it never reads
 * `pr.checks` itself.
 */
export function VerdictChip({ column }: { column: Column }) {
  const v = verdictFor(column);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-body font-semibold ${TONE_CLS[v.tone]}`}
    >
      <span aria-hidden>{v.icon}</span>
      {v.label}
    </span>
  );
}
