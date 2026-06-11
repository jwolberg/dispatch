---
name: prd-compile
description: >-
  Compile a PRD into a running, production-grade, delightful system with minimal human time —
  by routing every claim to its cheapest re-runnable check and building the dominant oracle
  first. Use this whenever a project has a PRD.md / spec / requirements doc to build or execute
  ("build this per the PRD", "execute the spec", "turn these requirements into a working
  system"), when scaffolding or resuming a greenfield build from a requirements document, or in
  a build's closing phase to harvest corrections back into the method. Pairs with
  frontend-design, run/verify, and claude-api.
---

# prd-compile

Turn a PRD into a working system that **self-verifies**, surfacing the human only where no
machine can decide. The aim is not zero human corrections — some are irreducible taste, or
intent discovered mid-build — but zero *preventable* ones. This skill encodes the preventable.

It inherits the global manifesto (least code, simplest architecture, maximal correctness,
no docs unless asked). This is the *how-to-build*; the manifesto is *what good looks like*.

**Input:** a project dir with `PRD.md` + a project `CLAUDE.md` (stack, hosting, boundaries).
**Output:** code — a typed boundary contract, *failing* oracle stubs, and the answered batched
forks. Not documentation.

## The one routing question

For every **claim** the system makes, ask:

> What is the cheapest re-runnable check that this claim is correct? If none exists, it's a
> human call.

This is a question, not a fixed oracle list — so it absorbs oracle flavors you haven't met.
Common ones, cheapest first: **deterministic** (a unit test) · **eval** (a labeled/grounded
check over a small golden set) · **human-judgment** (taste or trust no machine can settle) ·
**trust** (reversible glue not worth a check). Route the *claim*, not the feature; a single
feature usually splits across several oracles. Build the **dominant** oracle first.

## The loop

1. **Compile the PRD into claims.** Turn every must-have — and every graded bonus — into an
   explicit claim, each tagged with the oracle that proves it. This list *is* the done-criterion;
   you return to it in step 8.
2. **Batched forks — ask once, up front** (see below). Default everything else.
3. **Define the boundary contract.** One typed contract at the cross-process / cross-language
   seam, the single source of truth, mirrored on both sides. It is the spine everything else
   hangs on and the thing most likely to survive a rewrite underneath it.
4. **Write *failing* oracle stubs** for the dominant oracle, cheapest first. Red before green.
5. **Manual proof-of-life, then automate.** Get one real input → one real output on screen and
   eyeball it *before* you codify the oracle. Automating an unproven path encodes its bugs.
6. **Build to green.** The human appears only at the non-codifiable residue and the step-2 forks.
7. **Run the real system as the joint oracle.** Integration and infra correctness only show up
   in the running system, never in unit checks — exercise it for real, including the non-happy
   states (loading, empty, error, out-of-scope), not just the golden path.
8. **Audit against the PRD, then bind the gate.** Re-grade the running system against the claim
   list from step 1 — *you* run this false-green checkpoint, the human shouldn't have to ask.
   Once green, bind `verify` to a project `Stop` hook so it can never silently rot. Ratchet.

## Preventions baked into the loop

These are defaults, not extra steps — each one is a correction a prior build paid for once.

- **Boundary discipline (step 3, 6).** Validate every external / LLM output against the typed
  contract *at the seam*: parse-or-fallback, guard truncation / refusal / shape-drift, and
  re-check any derived claim before serving it. An unvalidated external payload flowing inward
  is the classic production crash. (This is the manifesto's "validate at the edge," applied to
  the model and the network as adversaries.)
- **Keep the Stop gate deterministic and fast (step 8).** The `verify` bound to the `Stop` hook
  runs *only* offline, deterministic checks — typecheck, lint, types, unit, and a recorded /
  offline eval-smoke. Live, networked, LLM, or deploy oracles run **on demand**, never on every
  Stop. A gate that is flaky or takes minutes is worse than no gate: it trains you to ignore it.
- **Select taste, don't correct it (step 2, 7).** Before building any human-facing or taste
  surface, gather references and have the human *pick* a direction up front. The only real lever
  on irreducible taste is a tighter reference loop — let them select rather than correct.
- **Right-size to stakes; no CI.** Build the smallest correct slice for the stated stakes; note
  the rest as scale-path, don't build it. Local `verify` + the `Stop` hook is the safety net —
  don't add CI/CD unless the PRD demands it.

## The batched forks

Only these genuinely need a human and can't be safely defaulted. Ask them **once, together,
up front** — then proceed. Everything else, take the simpler default and move.

1. **Stakes & scope** — POC or production-grade? What's the smallest correct slice, and what is
   explicitly scale-path (noted, not built)?
2. **Ground truth** — for each non-deterministic claim, what is the labeled / golden oracle:
   does it already exist, or do we build a small one now — and which examples go in it?
3. **Taste references** — for each human-facing surface, what reference(s) define "good"?
4. **Deploy** — is a live deployment in scope (a hard oracle), or is a productionization
   description sufficient? (Often answerable from the PRD — confirm, don't assume.)

## Composes with

- **frontend-design** — the taste surface; pairs with the taste-references fork.
- **run / verify** — driving the running system as the final human oracle (step 7).
- **claude-api** — any LLM work: prompt caching, model choice, and the boundary guard above.

## Closing harvest (self-improvement)

At the end of every build, review the human's corrections and **cluster them by root cause** —
several corrections usually trace to one missing step; fix the 2–3 roots, not the ten symptoms.
Classify each root:

- **Project-specific** → stays in that project's code / `CLAUDE.md`. It must **never** enter this
  skill — that is the overfitting death.
- **Method / process gap** → fold into this skill, as the *earliest* of: a better default that
  removes the need to ask · a tighter batched fork · a done-check · a right-sizing rule.
- **Universal quality standard** → the global manifesto, not here.

Fold conservatively and reversibly — a bad fold regresses the method. Prefer fewer root-cause
fixes over many patches, and keep this skill almost embarrassingly thin: the invariant is small,
and each new project should have to *earn* any addition by proving a third, unlike project would
need it too.
