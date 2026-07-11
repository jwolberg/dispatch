---
id: 7
slug: harden-password-gate
anchor: SES-0007
title: "#32 — Harden the shared-password gate (rate-limit + timing leak)"
status: closed
started: 2026-07-11T22:30:00Z
ended: 2026-07-11T23:00:00Z
goal: "Harden the shared-password gate (#32): add inbound rate-limiting/lockout on failed Basic-auth, fix the non-constant-time safeEqual length leak, correct the misleading comment, and un-gate GET /api/health for uptime checks"
tickets: [32]
branches:
  - fix/32-harden-password-gate
prs:
  - "https://github.com/jwolberg/dispatch/pull/41"
related_research: []
related_docs:
  - docs/BUILD_PLAN-v2.md
prior_sessions: [6]
---

## [1] Goal

Fix **#32** (security, high/now). `basicAuthGate` (`server/lib/auth.ts`, mounted
first at `server/index.ts:68`) is the **only** control on the public Cloud Run
service (`allUsers` holds `roles/run.invoker`), and behind it sit a PR-merging
`GITHUB_TOKEN` and a live-budget `ANTHROPIC_API_KEY`. The public-browser trade is
deliberate and reaffirmed by the owner — but it's only sound if the gate is
strong, and today it isn't.

**Done** = two real code defects fixed + one honesty fix + one ops fix:
1. **Rate-limit / lockout** on failed Basic-auth (unlimited anonymous guesses
   today — the password's entropy is the entire defense).
2. **`safeEqual` timing leak** — it returns early on a length mismatch, leaking
   the real password's length; hash both sides to fixed-width before
   `timingSafeEqual`.
3. **Correct the comment** that claims a constant-time compare the code doesn't do.
4. **Un-gate `GET /api/health`** so external uptime checks work (it returns only
   booleans + rate-limit counts — no secrets).

## [2] Context & pointers

### [2.1] Ticket in scope

**#32 — harden password gate** (`open` → in-progress, high/now, no deps).
Acceptance criteria (verbatim):
- Nth consecutive failed Basic-auth from one IP within a window → **429**, not
  401, with a test.
- `safeEqual` hashes both sides to fixed-width digests before `timingSafeEqual`
  (no early length return); response time independent of supplied password length.
- The `auth.ts` comment no longer claims a constant-time compare it doesn't perform.
- `GET /api/health` reachable without the password while every other `/api/*`
  stays gated — **or** record a deliberate decision to keep health gated.

Explicitly **not** in scope (ticket says do not touch): the generic `401` body
(no oracle — keep it), the empty-password path (`!password → next()` is off-switch,
not bypass), and rotating the password value (operator action).

### [2.2] Current state (read this session)

- `server/lib/auth.ts:11` — `safeEqual` returns `false` before `timingSafeEqual`
  on length mismatch (the leak). Comment at line 7 over-claims constant-time.
- `server/index.ts:68` — `app.use(basicAuthGate)` mounts **before** `express.json`
  and the `/api` router; `api.use("/health", healthRouter)` at :75 is therefore
  gated. No `app.set("trust proxy", ...)` — so `req.ip` is the immediate peer, not
  the Cloud Run client. For per-IP limiting behind Cloud Run's proxy, trust proxy
  (or read `X-Forwarded-For`) — but the leftmost XFF hop is client-spoofable, a
  caveat to document.
- **No inbound rate limiting anywhere** — every `rate limit` symbol is GitHub's
  API quota. `package.json` has no `express-rate-limit`/`helmet`.
- `server/routes/health.ts` returns `{ configured, remaining, ... }` — booleans +
  numbers, **no secrets** → safe to un-gate.
- **No `auth.test.ts` exists** — this gate has never had a test.

### [2.3] Decisions to make

- **No new dependency.** A small in-memory per-IP failure tracker (single instance,
  `--max-instances 1`) is enough and testable with an injected clock — prefer it
  over pulling `express-rate-limit` (global §engineering: no deps unless justified).
- **Un-gate health** rather than keep it gated: a public service with no uptime
  check is the worse posture, and health leaks nothing.

### [2.4] Prior sessions

- **SES-0006** (#27) — just closed, merged. Board is clean (`in-progress` empty
  after the #27/#28 reconcile). #32 is the top buildable `now` ticket; #19/#16 are
  the *doc* and *durable-OIDC* siblings and are deliberately kept separate.

### [2.5] Git/PR state

Branch `main`, synced with origin, green at 624 tests. This session branches
`fix/32-harden-password-gate` off it. One tiny reconcile PR (#40) may still be in
flight; it touches only ticket files, no conflict.

## [3] Checklist

TDD-first. Branch `fix/32-harden-password-gate`.

### [3.1] safeEqual timing leak + comment
- [x] write behaviour test: `safeEqual` accepts the exact password and rejects wrong ones of **equal and unequal length**, without throwing
- [x] hash both sides (sha256 → 32 bytes) before `timingSafeEqual`; drop the early length return
- [x] rewrite the line-7 comment to state what the code actually does

### [3.2] Rate-limit / lockout on failed auth
- [x] write failing test: after N consecutive failed auths from one IP within the window, the gate returns **429** (injected clock); a success before the cap resets the counter; the window expiring clears the block
- [x] implement an in-memory per-IP failure limiter (injected `now`), wire it into `basicAuthGate`; set `trust proxy` so `req.ip` is the client
- [x] a correct password is never rate-limited; 429 body is generic (no oracle)

### [3.3] Un-gate health
- [x] write failing test: `GET /api/health` returns 200 without credentials while another `/api/*` route still 401s when `DISPATCH_PASSWORD` is set
- [x] mount health ahead of the gate (or exempt its path); leave every other route gated

### [3.4] Ship
- [x] `npm run verify` green
- [x] note in the ticket: independently verify `dispatch-password` is high-entropy (operator action, out of scope but load-bearing)
- [x] open PR + link into ticket #32 `prs:`

## [4] Log

### [4.1] 2026-07-11 — session opened

Board clean post-#27/#28 merge. #32 is a contained `auth.ts` security fix + a
small in-memory limiter + a health un-gate. Verified: no inbound rate limiting
exists, `safeEqual` leaks length, health carries no secrets. Chose a hand-rolled
limiter over a new dep (single-instance service). trust-proxy/XFF spoof caveat to
document.

### [4.2] 2026-07-11 — shipped, PR #41

TDD-first: limiter → safeEqual+gate → health un-gate. `npm run verify` green at
**638 tests**. No new dependency (hand-rolled limiter); no NUL-byte fixture
issues this time.

## [5] Decisions

1. **Hand-rolled in-memory limiter over `express-rate-limit`.** The service runs
   `--max-instances 1`, so a shared store buys nothing and a `Map` keyed on IP
   (with an injected clock for tests) is enough — and avoids a new dependency
   (global §engineering).
2. **Only a *supplied wrong password* counts as a failure.** A credential-less
   request is the browser's pre-prompt hit; counting it would lock out ordinary
   page loads. This keeps the limiter aimed at actual guesses.
3. **Block-first once over the cap:** a blocked IP 429s without its guess being
   checked, so brute force truly stops rather than continuing to probe.
4. **Un-gate health, not keep it gated** (the AC offered either): a public service
   with no uptime check is the worse posture, and health leaks nothing.
5. **`trust proxy: true`** so `req.ip` is the client behind Cloud Run — accepting
   the documented XFF-spoof caveat, since OIDC (#16) is the real fix.

## [6] Outcomes

- **PR #41 opened** (`fix/32-harden-password-gate`, Closes #32) — 2 commits.
  Ticket #32 → `in-progress`, PR linked.
- New: `server/lib/auth-limiter.ts` (+ test). Rewrote `server/lib/auth.ts`
  (`safeEqual` hashes both sides; `makeBasicAuthGate` with limiter; exported for
  tests) + `auth.test.ts`. `server/index.ts` sets `trust proxy` and mounts health
  ungated. `health-gate.test.ts` proves the mount order.
- `npm run verify` green: **638 tests**, seam clean, templates match.

## [7] Follow-ups

- **[#19] Update DEPLOY.md** — #19 (the doc-truth ticket, HITL) should now also
  document the rate-limit behavior and the ungated `/api/health`, alongside the
  `DISPATCH_PASSWORD` threat model. Not touched here (kept out of #32's scope).
- **[operator] Verify `dispatch-password` entropy** — load-bearing but out of
  scope (an operator action, noted in the ticket).
- **[#16] OIDC** remains the durable replacement for HTTP Basic; the XFF-spoof
  limitation of the per-IP limiter is a reason it matters.

## [8] Documentation

- Captured in the ticket's implementation note + PR #41. No ADR needed — this
  hardens an existing control rather than changing the documented design.
- **Doc candidate (deferred):** a `docs/learnings/` note — "a single-instance
  Cloud Run service can rate-limit inbound auth with an in-memory per-IP Map; XFF
  is client-spoofable so it's defense-in-depth, not a wall." Pairs with the
  security-boundary learnings noted in SES-0006.
