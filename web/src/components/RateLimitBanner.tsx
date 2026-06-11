import type { Health } from "../api/types.js";

// Prominent banner when polling is paused / the budget is low (S3). Paired with
// an icon + text, not color alone (§4).
export function RateLimitBanner({ health }: { health: Health | null }) {
  const rl = health?.rateLimit;
  const low = rl && (rl.paused || (rl.remaining != null && rl.remaining < 100));
  if (!low) return null;
  return (
    <div className="flex items-center gap-2 border-b border-status-wait/40 bg-status-wait/10 px-5 py-2 text-body text-status-wait">
      <span aria-hidden>⚠</span>
      <span>
        {rl?.reason ?? `Rate limit low (${rl?.remaining ?? "?"} remaining) — polling paused`}
        {rl?.reset && ` · resets ${new Date(rl.reset).toLocaleTimeString()}`}
      </span>
    </div>
  );
}
