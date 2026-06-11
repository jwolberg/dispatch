// Status colors are always paired with an icon + text, never color alone
// (PRD §4 / acceptance #10).
const STYLES: Record<string, { cls: string; icon: string }> = {
  Spec: { cls: "text-gray-300", icon: "◷" },
  Queued: { cls: "text-status-info", icon: "•" },
  Building: { cls: "text-status-wait", icon: "◐" },
  "Ready to test": { cls: "text-status-ok", icon: "✓" },
  Shipped: { cls: "text-status-ok", icon: "🚀" },
  Blocked: { cls: "text-status-fail", icon: "✕" },
};

export function StatusChip({ column }: { column: string }) {
  const s = STYLES[column] ?? { cls: "text-gray-300", icon: "•" };
  return (
    <span className={`inline-flex items-center gap-1 text-label ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {column}
    </span>
  );
}
