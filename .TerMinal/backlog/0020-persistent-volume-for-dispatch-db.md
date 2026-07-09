---
id: 20
title: "Mount a persistent volume at /data — every redeploy wipes production"
status: open
priority: high
horizon: now
hitl: true
type: bug
source: observed
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "DEPLOY.md"
depends_on: []
acceptance:
  - "A redeploy of the Cloud Run service preserves the repo registry and the ticket↔issue mapping"
  - "DISPATCH_DB_PATH resolves to a mounted volume, not the container's ephemeral disk"
  - "The startup warning the server already emits ('not on a mounted volume') no longer fires in production"
  - "DEPLOY.md §2's primary deploy command includes the volume flags, rather than relegating them to a commented note in §4"
  - "The cost of the chosen mechanism (Filestore monthly minimum, or an alternative) is recorded in the ticket or an ADR"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Observed 2026-07-09: redeploying production to pick up Tier 0 + Tier 1 reset the
database, because `DISPATCH_DB_PATH=/data/dispatch.db` sits on the container's
ephemeral disk and no volume is mounted. The previous revision
(`dispatch-00015-tif`) had been live since 2026-06-12, so roughly a month of
state was lost: tracked repos, the ticket↔issue mapping, chats, and the spend
ledger.

The loss was accepted knowingly by the owner at deploy time. It should not be
accepted twice.

The server already knows this is wrong and says so on every boot:

```
[dispatch] WARNING: /data/dispatch.db is not on a mounted volume. In a container
this file is lost on redeploy or instance recycle, taking the repo registry and
filed tickets with it. Derived state rebuilds from the provider, but tracked
repos do not. Mount a volume at /data — see DEPLOY.md §4.
```

A warning that fires on every production boot and is never actioned is worse
than no warning — it trains the reader to ignore the log.

## Design notes

`DEPLOY.md` §4 already sketches the fix and buries it in a comment:

```
#   --add-volume=name=data,type=nfs,location=<FS_IP>:/<share> \
#   --add-volume-mount=volume=data,mount-path=/data
```

Filestore (NFS) is the SQLite-friendly option; GCS/gcsfuse is called out as
unsuitable because of file-locking semantics. Filestore carries a real monthly
minimum, which is why this is `hitl: true` — it is a spend decision, not just a
config change.

Note there is **no backup path today**: Cloud Run offers no shell, so the live
DB cannot be exported before a redeploy. Until a volume exists, every deploy is
destructive and unrecoverable. That asymmetry is the argument for doing this
before the next deploy rather than after.

Worth considering as part of the same decision: whether `repos` and `tickets`
should be reconstructible from the provider (issues are already labeled
`dispatch`, and the adapters can `listOpenIssues` to adopt them). If adoption
covered repos too, the blast radius of losing the DB would drop to "re-add the
repo," which may be cheaper than Filestore.
