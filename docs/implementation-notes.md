# Implementation Notes

Running log of decisions, deviations, and tradeoffs for human review.

## 2026-06-11 — P1-T1 (Skeleton: scaffold + dev orchestration)
- **No `/docs/spec.md`.** Treated `PRD-dispatch.md` as the spec and `ARCHITECTURE.md` as structural clarification (matches BUILD_PLAN assumption). No scope added.
- **Single root `package.json`** (not workspaces) running both `server/` and `web/` via `concurrently`. Simplest for a single local app.
- **Backend run with `tsx`** (no dev build step); **Vite config kept at `web/vite.config.ts`** and referenced explicitly via `dev:web: vite --config web/vite.config.ts` — Vite otherwise looks for the config in cwd (project root) and silently ran with defaults (no proxy / wrong root). Caught during validation.
- **`/api/ping` placeholder** added so the dev loop is verifiable at boot; it is a stand-in for the real `/api/health` (P1-T5), not part of the spec API surface.
- **Node 22 local; `engines` pinned `>=20`** per PRD without forcing a downgrade.
- **Deferred (by ticket boundary, not omission):** Tailwind/app-shell/routing (P1-T8), SQLite (P1-T2), provider seam (P1-T3/T4).
- **Follow-up:** This is not a git repository, so the per-ticket commit rule could not be applied. Initialize git before continuing if commit-per-ticket is desired.
