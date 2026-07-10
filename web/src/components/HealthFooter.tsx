import type { Health, ProviderHealth } from "../api/types.js";

// Footer surfaces DB status + provider rate-limit remaining (PRD F4.2 footer).

/**
 * The footer shows one number, but a deployment can hold several credentials —
 * one per GitHub App installation, plus the env token (#21). The number shown is
 * the *smallest* remaining, so name the account it belongs to rather than leaving
 * the reader to guess whose budget is nearly gone.
 */
function budgetBreakdown(gh: ProviderHealth): string | undefined {
  if (gh.accounts.length < 2) return undefined;
  return gh.accounts
    .map((a) => `${a.label}: ${a.valid ? `${a.remaining ?? "?"} / ${a.limit ?? "?"}` : a.error ?? "invalid"}`)
    .join("\n");
}

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
            <span
              title={budgetBreakdown(gh)}
              className={gh.remaining != null && gh.remaining < 100 ? "text-status-wait" : "text-status-ok"}
            >
              ● {gh.remaining ?? "?"} / {gh.limit ?? "?"} left
              {gh.accounts.length > 1 && <span className="text-gray-500"> (lowest of {gh.accounts.length})</span>}
            </span>
          ) : (
            <span className="text-status-fail" title={gh.error ?? undefined}>
              ● no working credential
            </span>
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
