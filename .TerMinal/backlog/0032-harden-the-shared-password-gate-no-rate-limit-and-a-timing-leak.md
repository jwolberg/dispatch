---
id: 32
title: "Harden the shared-password gate: it is the only control on a public, credential-holding service"
status: open
priority: high
horizon: now
hitl: false
type: security
source: "found while redeploying to Cloud Run on 2026-07-10"
created: 2026-07-10
updated: 2026-07-10
prs: []
refs:
  - "server/lib/auth.ts"
  - "server/index.ts:68"
  - "#19"
  - "#16"
depends_on: []
acceptance:
  - "A burst of failed Basic-auth attempts from one IP is throttled — the Nth consecutive failure within a window returns 429, not 401, and a test proves it"
  - "safeEqual no longer returns early on a length mismatch: both sides are hashed to fixed-width digests before timingSafeEqual, so response time does not vary with the supplied password's length"
  - "The comment in server/lib/auth.ts no longer claims a constant-time compare that the code does not perform"
  - "GET /api/health is reachable without the password (uptime checks), while every other /api/* route stays gated — or the ticket records a deliberate decision to keep health gated"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

`basicAuthGate` (`server/lib/auth.ts`, mounted first at `server/index.ts:68`) is
the **only** control on the production Cloud Run service. `allUsers` holds
`roles/run.invoker`, so `https://dispatch-4mq3uiar6q-uc.a.run.app` is reachable by
anyone on the internet and every request lands on Express.

Behind that one password sit a `GITHUB_TOKEN` that can merge PRs and an
`ANTHROPIC_API_KEY` with a live budget.

This is a **deliberate** trade — public browser access without the `gcloud` proxy —
reaffirmed by the user on 2026-07-10 after the alternative (IAM-gating the service)
was tried and rejected as too much friction. The trade is only sound if the gate
itself is strong. It currently is not.

## Two defects

### 1. No rate limiting, no lockout

Nothing in `server/` throttles inbound requests. Every `rate limit` symbol in the
tree refers to *GitHub's* API quota (`server/lib/ratelimit.ts`,
`server/poller/scheduler.ts`), not to inbound HTTP. `package.json` has no
`express-rate-limit`, no `helmet`, nothing equivalent.

So an attacker gets **unlimited, anonymous guesses**, each answered with a clean
`401`. The password's entropy is the entire defense. `--max-instances 1` caps
throughput incidentally, but that is a billing setting, not a security control —
and a brute-force attempt would also saturate the single instance and take the
board down.

### 2. The constant-time compare is not constant-time

```ts
// server/lib/auth.ts:11
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;   // ← returns before timingSafeEqual
  return timingSafeEqual(ab, bb);
}
```

The early return leaks the real password's **length** through response timing.
`timingSafeEqual` throws on unequal-length buffers, so the guard is *necessary* —
which is exactly why the standard fix is to hash both sides first:

```ts
const ah = createHash("sha256").update(a).digest();
const bh = createHash("sha256").update(b).digest();
return timingSafeEqual(ah, bh);   // always 32 bytes
```

The comment on line 7 — "the password is compared in constant time" — currently
over-claims. Severity is low (remote timing across TLS and internet jitter), but
the fix costs three lines and the comment is actively misleading.

## What is already fine — do not "fix" these

- **The `401` body is correct.** `{"error":"Authentication required"}` is returned
  identically for a missing header and a wrong password, so there is no oracle.
  The username is discarded (`decoded.slice(sep + 1)`), so there is nothing to
  enumerate. Leave it generic.
- **The empty-password path is not a bypass.** `if (!password) next()` disables the
  gate entirely, and a credential-less request yields `supplied === ""`, which can
  only match when the gate is already off.

## Note on `/api/health`

`basicAuthGate` mounts ahead of the `/api` router, so `/api/health` is gated too.
That is defensible, but it means no external uptime check can watch this service.
Decide deliberately rather than by accident.

## Relationship to #19 and #16 — do not merge these

Three tickets, three different jobs. Keep them apart:

- **#19** — the *doc* lies. `DEPLOY.md` names IAM as the safety control and never
  mentions `DISPATCH_PASSWORD` or the `dispatch-password` secret. #19 closes the
  gap between doc and reality and writes down the threat model. It is `hitl: true`
  and it already records (2026-07-09) that the owner deliberately chose this
  posture. **Nothing in this ticket belongs there.**
- **#16** — the *durable* fix: OIDC replaces HTTP Basic for the deployed path.
  Until it lands, the password gate is what protects production.
- **#32** (this) — the gate itself is weak *as code*, independent of what any doc
  says and of whether OIDC ever ships. Rate limiting and the timing leak are real
  defects in `server/lib/auth.ts`.

#19 asked the owner to choose: remove `allUsers`, or correct the doc. On
**2026-07-10** the choice was re-litigated in practice — `allUsers` was removed,
bare-browser access broke, and it was put back on the explicit requirement to reach
`https://dispatch-4mq3uiar6q-uc.a.run.app` from any browser at any time. That
settles #19's fork toward "correct the doc." It also means this ticket is now the
*only* thing standing between a guessable password and a PR-merging token.

## Out of scope

Rotating `dispatch-password` to a high-entropy value. That is an operator action,
not a code change — but this ticket is worth little if the password is guessable.
Verify it independently.
