---
title: OAuth callbacks are GETs that write — and the snapshot middleware skips GETs
date: 2026-07-10
tags: [snapshot, durability, cloud-run, oauth, github]
anchor: LRN-get-that-writes
---

## The finding

`server/db/snapshot.ts` uploads the SQLite file to GCS whenever an *irreplaceable*
table is written. The trigger is `snapshotMiddleware`, and it opens with:

```ts
if (!snapshotEnabled() || req.method === "GET" || req.method === "HEAD") return next();
```

That guard is correct and deliberate: the board polls constantly, and a `GET` must
never cost a snapshot upload. It encodes an assumption that is true of every route
Dispatch had until #2 — **GET requests do not write irreplaceable state.**

GitHub App registration breaks it. Both of the flow's write paths are `GET`s, because
they are *browser redirects GitHub controls*, not calls Dispatch makes:

| Route | Who calls it | What it writes |
|---|---|---|
| `GET /api/github/callback` | GitHub redirects the operator's browser (`redirect_url`) | the App: id, client secret, **private key** |
| `GET /api/github/installed` | GitHub redirects again (`setup_url`) | the installation: account, granted repos |

So on Cloud Run: the operator registers an App, the row lands in SQLite, and no
snapshot is ever uploaded. The next redeploy or instance recycle restores a snapshot
that has never heard of the App. Dispatch boots **clean** — no `github_app` row, so
the boot gate has nothing to complain about — and silently falls back to
`GITHUB_TOKEN`. That is the precise failure the boot gate was written to prevent,
reached by a door the boot gate does not watch.

It compounded with a second, simpler miss: `db/installations.ts` never called
`markDirty()` at all, so even a `POST` would not have uploaded.

## Why it is easy to miss

Every test passed. The routes are covered, the store is covered, the snapshot module
is covered. Nothing tests the *composition* — "a write on this path reaches GCS" —
because durability is a property of the deployment, not of any one unit. Locally
`snapshotEnabled()` is false and the whole concern is invisible.

You cannot see it by reading either file. You see it by asking, of a new write path:
**what makes this durable?**

## The fix

`markDirty()` in the store, next to the other irreplaceable tables — and the routes
flush for themselves, because the middleware will not:

```ts
installations.saveApp(app);        // markDirty() + resetProviderCache()
await persist(flushSnapshot);      // the middleware skips GET; do it here
res.redirect(302, installUrl);
```

A failed upload must not fail the operator's install. The row is committed locally
either way and stays dirty, so the next mutating request retries. Failing an install
over a transient GCS error is worse than a stale snapshot.

## The general rule

**A middleware that discriminates on HTTP method is asserting something about your
routes.** When a third party — an OAuth provider, a webhook, a payment processor —
gets to choose the method, that assertion is theirs to break, not yours to hold.

Whenever a route writes state the provider cannot rebuild, ask two questions the type
system will not ask for you:

1. Does the write mark the database dirty?
2. Is anything on this path actually going to *upload* it?

For a `POST` the answer to (2) is the middleware. For a redirect target, it is you.

## See also

- ADR-0005 — durable state via GCS snapshot, and why versioning is on.
- `DEPLOY.md` §4.1 — the lifecycle rule; versioning keeps the *old* ciphertext under
  the *old* key until noncurrent versions expire.
- Follow-up: the middleware's method guard is still a latent trap for the next
  redirect-target route.
