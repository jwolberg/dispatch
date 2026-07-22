---
id: 41
title: "README's architecture PNG has no source file and cannot be maintained"
status: open
priority: low
horizon: next
hitl: true
type: docs
source: doc audit, #40
created: 2026-07-22
updated: 2026-07-22
prs: []
refs:
  - "docs/img/dispatch_arch.png"
  - "README.md:15"
depends_on: []
acceptance:
  - "The README hero diagram has a checked-in source file that can be edited and re-exported"
  - "The rendered image matches what the system actually does — polling, not webhooks"
agent_id: docs
agent_scope: global
agent_kind: classic
---

## Description

`docs/img/dispatch_arch.png` is the first thing a reader sees (`README.md:15`)
and it is an unmaintainable binary: there is no `.mmd`, `.drawio`,
`.excalidraw`, or `.puml` anywhere in the repo. Nobody can correct it without
redrawing it from scratch and guessing at the original intent.

It is very likely already wrong in the same way `pipeline-architecture-diagram.html`
was — depicting webhooks rather than the poller — but that cannot be confirmed
without opening the image and reading it by eye.

`hitl: true` because the fix is a design choice, not a mechanical one: either
redraw it in a source format (mermaid would render natively on GitHub and in
TerMinal), or drop the hero image and promote the HTML diagram, which *is*
maintainable and now accurate. That call is the owner's.
