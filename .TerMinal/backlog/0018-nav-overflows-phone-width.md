---
id: 18
title: "App nav overflows a phone-width viewport"
status: open
priority: medium
horizon: next
hitl: false
type: bug
source: T1-6 verification
created: 2026-07-09
updated: 2026-07-09
prs: []
refs:
  - "T1-6"
depends_on: []
acceptance:
  - "document.documentElement.scrollWidth === clientWidth at a 390px viewport on every route"
  - "Every nav destination remains reachable at phone width (wrap, scroll, or a menu — not truncation)"
  - "No horizontal page scroll on /board, /tickets/:id, /chat, /repos, /activity"
agent_id: 1000x-ai-engineer
agent_scope: global
agent_kind: classic
---

## Description

Found while verifying #7's "legible on a phone-width viewport" criterion. The
**card** is fine — nothing inside it overflows. The **app shell nav** is not.

At a 390x844 viewport, `document.documentElement.scrollWidth` is **483** against a
`clientWidth` of **390**. The offending element is the `<nav class="flex gap-1">`
in the app shell: its seven links lay out on one row and the last one
("Architecture") ends at x=483. The whole page therefore scrolls horizontally on
every route, and the last nav item is off-screen.

Pre-existing and unrelated to #7, which is why it was filed rather than fixed
there. Reproduced with:

```
[...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > innerWidth + 1)
// → NAV.flex gap-1 right=483
```

## Design notes

Responsive web is the mobile story (there is no native app), so this is a real
user-facing bug, not a cosmetic one. `flex-wrap` on the nav is the one-line fix;
a scrollable nav row or a menu are the alternatives worth weighing.
