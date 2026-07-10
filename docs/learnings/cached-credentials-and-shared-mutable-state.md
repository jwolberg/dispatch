---
title: A cached credential is shared mutable state, and the redactor is downstream of it
date: 2026-07-09
tags: [security, concurrency, providers, redaction]
anchor: LRN-cached-credentials
---

From SES-0001 / #3 (PR #10). Two bugs in `server/providers/token-source.ts`, both found
by an adversarial reviewer rather than by the tests I wrote for it. Neither is specific
to GitHub Apps; both recur wherever a process caches a credential it re-mints.

## [1] The finding

`AppTokenSource` caches an installation token and re-mints it near expiry. The first
implementation looked obviously correct:

```ts
private async mint() {
  const res = await fetch(...)          // ← the await
  this.forget()                         // unregister the token this supersedes
  this.token = body.token
  registerSecret(this.token)
}
private forget() { unregisterSecret(this.token); this.token = null }
```

`forget()` reads `this.token` — a **shared field, read after the await** — not the value
that *this* mint call superseded. With two mints in flight, whichever resolves last
unregisters whatever is in the field by then, which is the *other* mint's token: newer,
valid, and already handed to a caller who is using it.

## [2] Why it was a security bug and not a tidiness bug

`lib/redaction.ts` scrubs secrets from `safeMessage()`, and **every** error path in the
app funnels through it — `server/index.ts`, both pollers, three routes. Unregistering a
live token silently removes it from that scrub list. The next Octokit error that happens
to embed the `Authorization` header prints the credential.

So the blast radius of "we unregistered the wrong string" is a token in a log file. A
bookkeeping slip in the redactor is a disclosure, not an untidy `Set`.

## [3] The second bug, which the first one hides

`invalidate()` took no argument. N concurrent requests bearing one dead token all 401,
all call `invalidate()`, and each discards the fresh token its predecessor just minted.
The adapter mints forever and never converges. It only shows up under concurrency, and a
single-request test can never see it.

The fix is to name the failed credential: `invalidate(staleToken)` no-ops unless the
caller holds the token we currently believe in. That in turn forced the Octokit
`hook.before` + `hook.wrap` pair to collapse into a single `wrap`, because only the wrap
knows which token the failed request actually bore.

## [4] What actually fixes it

**Single-flight the mint.** `get()` memoizes the in-flight promise so concurrent callers
join one mint rather than racing rival ones. This does not merely reduce load — it makes
the out-of-order retire in [1] *unreachable by construction*, because two mints can never
overlap. Scoping `drop(token)` to a captured value is belt and braces.

Any cache of a remotely-minted credential wants all three:

1. single-flight, so N callers cause one mint;
2. operations scoped to a captured value, never to `this.<field>` read after an `await`;
3. invalidation that names *which* credential failed.

## [5] The testing lesson, which is the expensive one

My first regression test for [1] **passed against the buggy code.** It asserted on
`src.get()` — which returns the re-cached *old* token, still registered — instead of on
the token the concurrent caller was holding. It looked like a race test. It tested
nothing.

Then, verifying the fix, I ran the new tests against the *pre-fix* implementation and
found the third one couldn't fail: single-flight had made its scenario impossible to
construct. That is a fine outcome for the code and a useless test, so it was rewritten to
pin the invariant that makes the race impossible rather than the race itself.

**A test that guards a fix must be run red against the code it guards.** Not as ritual:
twice in one session it was the only thing that distinguished a real guard from a
comfortable one. Same with `expect(...).not.toThrow()` — two assertions in
`providers/index.test.ts` passed for a memoization bug they were written to catch, and
only a deliberate mutation of the memo key exposed them.

## [6] See also

- `server/providers/token-source.ts` — the implementation and its comments.
- `server/lib/redaction.ts` [1]–[2] — why a minted token cannot be found by scanning
  `process.env`, and must register its own value.
- ADR-0006 [6.3] — the same defect, spotted one ticket too late for the App private key.
- `docs/architecture.md` §5.1 — where this sits in the provider seam.
