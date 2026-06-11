import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { Health } from "../api/types.js";

// Footer surfaces DB status + provider rate-limit remaining (PRD F4.2 footer).
// The low-rate-limit banner itself is added in P6-T1.
export function HealthFooter() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const h = await api.get<Health>("/health");
        if (active) setHealth(h);
      } catch {
        /* footer is best-effort */
      }
    };
    poll();
    const timer = setInterval(poll, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

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
            <span className="text-status-ok">● {gh.remaining ?? "?"} / {gh.limit ?? "?"} left</span>
          ) : (
            <span className="text-status-fail">● token invalid</span>
          )
        ) : (
          <span className="text-gray-500">not configured</span>
        )}
      </span>
    </footer>
  );
}
