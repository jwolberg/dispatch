# Implementation

## Scope Implemented
- Requested scope: Monorepo scaffold + dev orchestration (the build plan's recommended next step; no ticket was named in the request)
- Related phase: Phase 1 — Skeleton (PRD M1)
- Related ticket(s): P1-T1

## Approach
- High-level strategy: Stand up the minimal runnable two-process foundation — Express backend on `:3001` and Vite SPA on `:5173` with `/api` proxied — plus the localhost bind guard (S1) and `.env` discipline. Everything later builds on this; nothing beyond the ticket's stated objective was added.
- Key decisions:
  - **Single root `package.json`** managing both `server/` and `web/` (one local app, no workspaces needed) with `concurrently` running `tsx watch` (backend) and `vite` (frontend). Keeps the dev loop to one `npm run dev`.
  - **`tsx` to run the TS backend directly** (no build step in dev) — simplest path to a runnable server.
  - **Bind guard in `server/lib/env.ts`:** host defaults to `127.0.0.1`; a non-local `HOST` throws unless `ALLOW_NONLOCAL=1`, satisfying S1 exactly.
  - **Vite config pinned via `--config web/vite.config.ts`** because the config lives under `web/` (not project root) where Vite looks by default; `root: "web"` then serves the SPA and proxies `/api`.
  - A throwaway `GET /api/ping` placeholder is mounted so the dev loop is verifiable end-to-end at boot; it is explicitly a placeholder for the real health route (P1-T5).
- Assumptions:
  - No `/docs/spec.md` exists; `PRD-dispatch.md` is treated as the spec and `ARCHITECTURE.md` as structural clarification (consistent with BUILD_PLAN's stated assumption).
  - TypeScript for both server and web (the architecture's file tree and interfaces are TS).
  - Node 22 is present locally; `engines` is set to `>=20` per the PRD without forcing a downgrade.
  - Tailwind, app shell, and routing are intentionally deferred to P1-T8; `web/src/main.tsx` is a bare placeholder.

---

## Implementation Plan
1. `.gitignore` and `.env.example` (gitignored secrets, documented keys).
2. Root `package.json` — deps, `dev`/`dev:server`/`dev:web`/`typecheck` scripts.
3. `server/tsconfig.json` and `web/tsconfig.json`.
4. `server/lib/env.ts` — config load + localhost bind guard (S1).
5. `server/index.ts` — Express bootstrap, `/api` router mount, graceful shutdown.
6. `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx` — minimal SPA with `/api` proxy.
7. Install, typecheck, and validate boot / bind guard / proxy.

Files to create: `.gitignore`, `.env.example`, `package.json`, `server/tsconfig.json`, `web/tsconfig.json`, `server/lib/env.ts`, `server/index.ts`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`.

---

## Code Changes

### File: .gitignore
- Change summary: Ignore `node_modules/`, `dist/`, `data/` (SQLite lives here later), `.env`, logs, `.DS_Store`.

### File: .env.example
- Change summary: Documented all env keys server-side only — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITLAB_HOST`, `PORT`, `HOST`, `ALLOW_NONLOCAL` — with notes on the bind guard.

### File: package.json
- Change summary: Root manifest. `type: module`, `engines.node >=20`. Scripts: `dev` (concurrently server+web), `dev:server` (`tsx watch server/index.ts`), `dev:web` (`vite --config web/vite.config.ts`), `typecheck`. Deps: express, dotenv. DevDeps: tsx, typescript, vite, react/react-dom + types, @vitejs/plugin-react, concurrently.

### File: server/tsconfig.json
- Change summary: Strict ES2022/ESNext config for the backend, `types: ["node"]`, `noEmit`.

### File: web/tsconfig.json
- Change summary: Strict ES2022 config with DOM libs and `jsx: react-jsx` for the SPA.

### File: server/lib/env.ts
- Change summary: `loadConfig()` reads `PORT`/`HOST`/`ALLOW_NONLOCAL` (via dotenv) and enforces the localhost bind guard.
- Code snippet:
  ```ts
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const allowNonLocal = process.env.ALLOW_NONLOCAL === "1";
  if (!LOCAL_HOSTS.has(host) && !allowNonLocal) {
    throw new Error(`Refusing to bind to non-local host "${host}". ... Set ALLOW_NONLOCAL=1 to override.`);
  }
  ```

### File: server/index.ts
- Change summary: Express bootstrap — JSON middleware, `/api` router with a placeholder `GET /api/ping`, listen on the guarded host/port, graceful SIGINT/SIGTERM shutdown.

### File: web/vite.config.ts
- Change summary: Vite + React, `root: "web"`, dev server on `:5173`, `/api` proxied to `http://127.0.0.1:${PORT}` so the browser uses a single origin.

### File: web/index.html
- Change summary: Minimal HTML entry (`<div id="root">`, module script to `/src/main.tsx`), `class="dark"` placeholder.

### File: web/src/main.tsx
- Change summary: Bare React root rendering a "scaffold is running" shell; placeholder until P1-T8.

---

## Acceptance Criteria Mapping
- Criterion: #1 — "From a fresh clone with a valid `.env`, `npm install && npm run dev` brings up the app … and a working health check."
  - Implementation: `npm install && npm run dev` starts both processes; Vite serves the SPA and proxies `/api`; backend responds on `/api`. **Partial:** the real `/api/health` is P1-T5 — this ticket provides the runnable two-process boot and a `/api/ping` placeholder; the empty board + health check complete later in Phase 1.
  - File(s): `package.json`, `server/index.ts`, `web/vite.config.ts`
- Criterion: S1 — "Backend binds to `127.0.0.1` only. Refuse to start if bound elsewhere without `ALLOW_NONLOCAL=1`."
  - Implementation: `loadConfig()` defaults to `127.0.0.1`, throws on a non-local `HOST` unless `ALLOW_NONLOCAL=1`. Verified all three cases.
  - File(s): `server/lib/env.ts`, `server/index.ts`
- Criterion: S2 — secrets in env, never to client (foundation only)
  - Implementation: `.env` gitignored, keys loaded server-side via dotenv; no secret is referenced in `web/`. Full redaction/health exposure is P1-T5/P6-T2.
  - File(s): `.gitignore`, `.env.example`, `server/lib/env.ts`

---

## Build Plan Mapping
- Ticket: P1-T1 — Monorepo scaffold + dev orchestration
- Status: Complete
- What was completed: `server/` + `web/` TS projects; root `package.json` with concurrent `dev` (Express + Vite `/api` proxy); `.env`/`.env.example` gitignored; localhost bind guard refusing non-local without `ALLOW_NONLOCAL=1`; Express bootstrap mounting the `/api` router.
- Remaining work (if any): None for this ticket. (The real health route, SQLite, provider seam, and Repos UI are separate Phase 1 tickets P1-T2..P1-T9.)

---

## Validation
- How tested: `npm install` (clean), `npm run typecheck` (server + web — no errors), and runtime checks against a live process.
- Lint/test results: No lint config or test suite exists yet (greenfield). `typecheck` passes for both tsconfigs.
- Manual verification steps + results:
  - Boot on default host → `GET /api/ping` returns `{"ok":true,"service":"dispatch"}` and logs `listening on http://127.0.0.1:3001`. ✅
  - `HOST=0.0.0.0` without `ALLOW_NONLOCAL` → process throws and refuses to start. ✅
  - `HOST=0.0.0.0 ALLOW_NONLOCAL=1` → binds and listens. ✅
  - `npm run dev` → Vite root `HTTP 200`, `/src/main.tsx` `HTTP 200`, `/api/ping` proxied through Vite returns the backend JSON. ✅
- Visible user outcome: `npm install && npm run dev` opens a running SPA at `http://localhost:5173` ("Dispatch — Control plane scaffold is running") whose `/api` calls reach the localhost-bound backend.

---

## Open Issues
- Known limitations: `/api/ping` is a placeholder; the real `/api/health` (token/rate-limit/DB) is P1-T5. SPA is a bare placeholder pending P1-T8 (Tailwind + shell + routing). No SQLite yet (P1-T2).
- Unresolved edge cases: None for scaffold scope.
- Blockers: None.

---

## BUILD_PLAN Update
- Current phase: Phase 1 — Skeleton
- Current ticket: P1-T2
- Updated ticket status: P1-T1 → Complete
- Blockers: None
- Recommended next ticket: P1-T2 — SQLite schema, migration, query modules
