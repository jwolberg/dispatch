---
id: 19
title: "DEPLOY.md claims IAM-gated access; production is allUsers + password"
status: open
priority: high
horizon: now
hitl: true
type: security
source: observed
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "DEPLOY.md"
  - "docs/runbooks/branch-protection.md"
depends_on: []
acceptance:
  - "DEPLOY.md and the live service agree on what actually gates access"
  - "The DISPATCH_PASSWORD env var and dispatch-password secret are documented (DEPLOY.md mentions neither)"
  - "Either allUsers is removed from roles/run.invoker, or DEPLOY.md is corrected to describe the password gate as the real control and says why IAM is not used"
  - "The threat model is stated: what an attacker who guesses DISPATCH_PASSWORD can do (merge PRs to production, file issues, spend the Anthropic budget)"
  - "Cross-referenced from #16 (real multi-user auth, OIDC)"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Observed 2026-07-09 while redeploying production (`dispatch-1-499113`,
`us-central1`).

`DEPLOY.md` opens with a bolded instruction:

> Deploy it **authenticated only** — never with `--allow-unauthenticated`.
> Access it through an IAM-gated proxy. Hosting it openly contradicts the
> local-first design and is unsafe.

The live service does not match. `roles/run.invoker` is granted to
`allUsers`, and ingress is `all`:

```
roles/run.invoker  ['allUsers', 'user:jmwolberg@gmail.com']
```

It is not unprotected — `GET /` returns `401`, because the app checks a
`DISPATCH_PASSWORD` sourced from a `dispatch-password` secret. But
`DEPLOY.md` documents **neither** that env var nor that secret, and names IAM
as the safety control. A reader following the doc would form a false model of
how production is protected.

The owner confirmed (2026-07-09) that the current posture is intentional and
chose to leave it in place. This ticket is about closing the gap between the
doc and reality, and stating the threat model honestly.

## Design notes

Dispatch holds `GITHUB_TOKEN` (can merge PRs to production), `ANTHROPIC_API_KEY`
(can spend budget), and a Slack webhook. The password is therefore the only thing
between the open internet and those capabilities. That is a defensible choice for
a single-user tool reached from a phone — but it should be written down as a
choice, not left as a contradiction.

Related: #16 replaces this with real auth (OIDC) and is the durable fix. This
ticket is the honest interim.
