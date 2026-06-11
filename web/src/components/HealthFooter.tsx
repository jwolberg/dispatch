import type { Health } from "../api/types.js";

// Footer surfaces DB status + provider rate-limit remaining (PRD F4.2 footer).
export function HealthFooter({ health }: { health: Health | null }) {
  const gh = health?.providers.find((p) => p.provider === "github");

  return (
    <footer className="flex items-center gap-4 border-t border-border bg-surface px-5 py-2 text-label text-gray-400">
      <span>
        DB:{" "}
        <span className={health?.db.ok ? "text-status-ok" : "text-status-fail"}>
          {health ? (health.db.ok ? "● ok" : "● error") : "…"}
        </span>
      </span>
      <span>
        GitHub:{" "}
        {gh?.configured ? (
          gh.valid ? (
            <span className={gh.remaining != null && gh.remaining < 100 ? "text-status-wait" : "text-status-ok"}>
              ● {gh.remaining ?? "?"} / {gh.limit ?? "?"} left
            </span>
          ) : (
            <span className="text-status-fail">● token invalid</span>
          )
        ) : (
          <span className="text-gray-500">not configured</span>
        )}
      </span>
      <span>
        AI:{" "}
        {health ? (
          health.anthropic.configured ? (
            <span className="text-status-ok">● ok</span>
          ) : (
            <span className="text-status-wait">● not configured</span>
          )
        ) : (
          "…"
        )}
      </span>
    </footer>
  );
}
