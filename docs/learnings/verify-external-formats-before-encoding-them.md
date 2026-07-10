---
title: Verify an external format against the API before encoding it, not after
date: 2026-07-09
tags: [github, integrations, adr, process]
anchor: LRN-verify-external-formats
---

## The finding

While building #2, three separate claims about GitHub's App-manifest format — all
written down in an **accepted ADR**, all repeated into a ticket's acceptance
criteria — turned out to be wrong. Every one of them would have compiled, typechecked,
and passed a test suite written from the same wrong understanding.

| ADR-0006 [5] said | GitHub actually does |
|---|---|
| POST the manifest to `settings/apps/new`, optionally `?org=<org>` | **No such parameter.** Ownership is chosen by the *path*: `/settings/apps/new` vs `/organizations/<org>/settings/apps/new`. `state` is the only query parameter. |
| the conversion returns a webhook secret | `webhook_secret` is typed **nullable** |
| exchange the code **once** | GitHub documents it as valid for **one hour** and never promises single use |

The first is the dangerous one. Posting the manifest to the *personal* path with a
stray `?org=acme` does not error. GitHub ignores the unknown parameter and registers
the App on the operator's personal account — a wrong-owner App that looks exactly
like success, discovered only when the org's repos cannot be installed on.

## Why the ADR was wrong

Not carelessness. The ADR was written from GitHub's rendered documentation prose,
which describes the org flow in words ("you can also create an app owned by an
organization") without showing the URL. Prose describing a format is not the format.

## What to do instead

**Introspect the live API.** The permission keys were settled in one command:

```bash
gh api /apps/dependabot --jq '.permissions'
# {"actions":"write","contents":"write","issues":"write","metadata":"read",
#  "pull_requests":"write","workflows":"write", ...}
```

That is a real, currently-installed App reporting the exact key strings. For the
authoritative enum — including keys no sample App happens to request, like
`secrets` — read GitHub's OpenAPI description directly:

```bash
curl -sL https://raw.githubusercontent.com/github/rest-api-description/main/\
descriptions/api.github.com/dereferenced/api.github.com.deref.json -o /tmp/gh.json
# app-permissions lives on the request body of
# POST /app/installations/{installation_id}/access_tokens
```

It settled that `workflows` accepts **only** `write` — there is no `read` — and that
the conversion response's required fields are `client_id`, `client_secret`,
`webhook_secret`, `pem`, with `webhook_secret` nullable.

## The general rule

An ADR is a record of a **decision**, and it is authoritative about *why we chose
this*. It is **not** authoritative about someone else's wire format, even when it
sounds confident, even when it is `status: accepted`. External formats are facts to
be checked against the source, and the source is the API or its machine-readable
schema — not the docs page, and not a previous ADR that read the docs page.

Cheap insurance, and it is what caught all three: **write the regression guard as an
assertion about the format itself.**

```ts
it("never emits an `?org=` parameter", () => {
  expect(manifestActionUrl("acme", "st8")).not.toContain("org=");
  expect(manifestActionUrl(null, "st8")).not.toContain("org=");
});
```

Reintroducing the ADR's bug turns six tests red. A test that pins *what the external
system requires* survives the next person who reads the same prose and makes the same
inference.

## The fourth one, found by a human clicking the button (2026-07-10)

Three of these were caught by reading GitHub's schema. The fourth was not, because
**no schema describes it**: GitHub validates `hook_attributes.url` for public
reachability at registration time, *even when `active` is `false`*.

```
Invalid GitHub App configuration
 Error Hook url is not supported because it isn't reachable
       over the public Internet (127.0.0.1)
 Error Hook is invalid
```

The manifest was rejected outright. Declaring an inactive webhook pointing at
`localhost` — which read as obviously harmless, and which I wrote a comment
defending — made the entire browser-native onboarding story unregisterable on a
laptop.

The lesson underneath the lesson: **a schema tells you what a field *is*, never what
the server will *do* with it.** Reading the OpenAPI description proved the field
names and types. It could not have told me the URL is fetched, validated, and
rejected. Only the button could.

So the rule has two halves. Verify shapes against the schema *before* encoding them,
and verify **behavior** against the real system *before* claiming it works. `#22`
exists for exactly this reason on a much more expensive claim.

## Corollary: correct the ADR, don't silently route around it

ADR-0006 [5] now carries a dated correction note; the original claim is left standing
above it. Anyone who read the ADR before 2026-07-09 and built on it can see exactly
what changed and why. Silently rewriting it would have left them confidently wrong.

## See also

- `docs/decisions/0006-…md` [5] — the correction, and [8] — the arm that is *still*
  inferred rather than observed (ticket #22 closes it).
- [[cached-credentials-and-shared-mutable-state]] — the other #2/#3 learning.
