---
id: 0005
title: Durable state via a GCS snapshot, not a mounted volume
anchor: ADR-0005
status: accepted
date: 2026-07-09
supersedes:
superseded-by:
---

Closes #20, filed after the 2026-07-09 production redeploy reset the database.
`DEPLOY.md` §4 recommended Filestore. It was wrong by roughly two orders of
magnitude, and this ADR records why, so nobody re-derives it.

## [1] Context

Production runs on Cloud Run with `DISPATCH_DB_PATH=/data/dispatch.db` on the
container's ephemeral disk. Cloud Run's docs are explicit that this does not
survive: "all data is permanently deleted when the instance shuts down. This
includes shutdowns caused by: Instance crashes, Service scaling, Traffic
migration to a new revision." `min-instances=1` keeps an instance warm between
requests; it does nothing for a redeploy.

The 2026-07-09 deploy proved it, losing about a month of state. The server had
been warning about this on every boot since T0-10, unread.

## [2] What is actually at risk

Much less than it first appears. `server/db/schema.sql:1-5` states the design:

> The Git provider is the source of truth. `repos` + `tickets` rows plus the
> provider API must fully reconstruct the board; every `*_cache` table below is
> disposable.

And `server/poller/discover.ts` already re-adopts a repo's open issues into
`tickets`, idempotently. So `status_cache`, `http_cache`, `summary_cache` and
`activity` rebuild on the next poll, and open tickets re-adopt themselves.

Irreplaceable: **`repos`** (the registry — nothing points at a repo once its row
is gone), **`chats`**, **`spend`** (the budget cap's ledger; losing it silently
re-grants the day's budget), and the record of tickets whose issues are already
**closed**, which adoption does not walk.

That is a few kilobytes, written rarely, and — crucially — written **during a
request**.

## [3] Decision

Snapshot the SQLite file to a GCS object on write; restore it on boot.

- `markDirty()` is called only by writers of the four irreplaceable tables. A
  poll cycle writes caches and costs no upload.
- An Express middleware uploads a `VACUUM INTO` copy **before the response is
  acked**, on any mutating request that dirtied the DB.
- `restoreIfMissing()` runs before `getDb()` opens the file. `404` means first
  boot; any other status throws.
- Disabled entirely unless `DISPATCH_GCS_BUCKET` is set, so local development is
  untouched.
- No new dependency: the access token comes from the Cloud Run metadata server
  and the upload is a `fetch` to the GCS JSON API.

## [4] Why not the three obvious options

**Filestore (what `DEPLOY.md` recommended).** Its cheapest tier, Basic HDD, has a
**1 TiB minimum** — about **$164/month**, before the VPC and Direct VPC egress it
also requires — to protect a 4 KB file. The recommendation was written without
checking the minimum.

**Cloud Storage FUSE.** The obvious cheap answer, and it corrupts data. Google's
own documentation: Cloud Storage FUSE "does not support file locking or file
patching," is "not POSIX compliant," and "shouldn't be used as the backend for
storing a database." Cloud Run's volume-mount page adds that on concurrent writes
"the last write wins and all previous writes are lost." SQLite relies on POSIX
advisory locks to checkpoint safely. This would fail silently, which is the worst
way to fail.

**Litestream.** The standard, well-built answer for durable SQLite, and the wrong
one *for this service*. It replicates on a background ticker. Cloud Run's docs:
instance-based billing is what "allocates CPU even outside of request processing,
letting you execute short-lived background tasks," while under request-based
billing "idle instances, including those kept warm using minimum instances, can
be shut down at any time." Our service is request-based, so the ticker would not
reliably fire. Switching billing modes means being "charged for the entire
lifecycle of the instance" — continuously, all month, to protect 4 KB.
Litestream's replication is free; the CPU it needs is not.

Litestream becomes the right answer the moment the DB is large or hot enough that
snapshotting the whole file per write stops being cheap. It is not close to that
today.

## [5] Consequences

**The upload blocks the ack, deliberately.** A `res.on("finish")` upload could be
frozen by CPU throttling the instant the response returns, and the instance shut
down mid-flight. Paying ~50ms on a rare write buys durability-before-acknowledge.

**An upload failure does not fail the write.** The row is committed locally either
way. The DB stays dirty, so the next mutating request retries. The alternative —
500ing a write that actually succeeded — is worse.

**A non-404 restore error is fatal on purpose.** Treating a transient `503` as
"no snapshot" would boot an empty DB, which would then overwrite the good
snapshot on the very next write. Fail loudly instead.

**The poller can dirty state outside a request** (`discoverTickets` creates
tickets). That flushes on the next mutating request, or on `SIGTERM`, which Cloud
Run sends before shutting an instance down.

**Bucket hygiene.** Versioning is on and a lifecycle rule keeps the 10 most recent
prior versions, so a corrupt snapshot is recoverable. Uniform bucket-level access
and public-access-prevention are enforced. The runtime service account holds
`roles/storage.objectAdmin` on that one bucket.

**The boot warning now tells the truth.** `ephemeralDbWarning` stays silent when a
snapshot is configured and otherwise names `DISPATCH_GCS_BUCKET` as the remedy
alongside mounting a volume. A warning that fires on every boot of a correctly
configured service trains the reader to ignore the log.

## [6] Evidence

Verified against the live bucket with real credentials, read and write, before
shipping: a `404` on a missing object is handled as first boot; an upload
followed by a restore returns the exact bytes; and the `%2F` encoding of a
slashed object name resolves rather than 404ing. `VACUUM INTO` was checked
against a WAL-mode database with an open handle and produced a valid readable
copy.

Cost: a 4 KB standard-class object in `us-central1`, rewritten on rare writes.
It rounds to zero, versus ~$164/month for the option the docs recommended.
