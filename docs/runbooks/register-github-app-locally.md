---
title: Register a GitHub App against localhost (and close ADR-0006 [8])
last-verified: 2026-07-10
anchor: RB-register-app-locally
---

The procedure for ticket **#22**. It needs no deploy, no tunnel, and no public URL.

## [1] Why localhost works

Every hop that touches Dispatch is either the **operator's own browser** or an
**outbound** call. GitHub's servers never need to reach this machine:

| Hop | Direction | Needs a public URL? |
|---|---|---|
| `POST github.com/settings/apps/new` | browser → GitHub | no |
| `GET /api/github/callback?code=…` | GitHub redirects the **browser** | **no** |
| `POST api.github.com/app-manifests/{code}/conversions` | Dispatch → GitHub | no |
| `GET /api/github/installed?installation_id=…` | GitHub redirects the **browser** | **no** |
| `GET api.github.com/app/installations/{id}` | Dispatch → GitHub | no |
| `POST …/access_tokens` (mint) | Dispatch → GitHub | no |
| `POST /api/webhooks/github` | GitHub → Dispatch | would — so the manifest **omits it entirely** on a non-public host |

`redirect_url` and `setup_url` are **browser redirects**, not server-to-server
callbacks. The webhook is the only inbound hop, and it is the only thing dropped.

> **Corrected 2026-07-10, from a live registration attempt.** This runbook first
> said the webhook was safe because the manifest declared it `active: false`. It is
> not. GitHub validates `hook_attributes.url` at registration time **regardless of
> `active`**, and rejects the whole manifest:
>
> ```
> Invalid GitHub App configuration
>  Error Hook url is not supported because it isn't reachable
>        over the public Internet (127.0.0.1)
>  Error Hook is invalid
> ```
>
> `buildManifest()` now omits `hook_attributes` unless the deployment is reachable
> from the public internet. A laptop-registered App simply has no webhook — which is
> correct, since nothing verifies its signatures until #17 anyway. When you later
> deploy publicly, add the webhook URL in the App's settings on GitHub; you do not
> need to re-register.

## [2] Prerequisites

Add an encryption key to `.env` — the App's private key is written to SQLite and
must be encrypted before it can ever reach a snapshot:

```bash
echo "DISPATCH_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
```

Keep it. If you lose it while an App is registered, Dispatch **refuses to boot**
rather than silently reverting to `GITHUB_TOKEN`. To start over, delete the row:

```bash
sqlite3 data/dispatch.db 'DELETE FROM installations; DELETE FROM github_app;'
```

`GITHUB_TOKEN` must stay set. Three account-level calls (the rate-limit probe, the
health route, `discoverRepos()`) have no installation to resolve against — that is
ticket **#21**.

## [3] Register and install

```bash
npm run dev          # server :3001, web :5173
```

1. Open **Repo Config → GitHub App**.
2. Name it, leave **Organization** blank for your personal account.
3. **Register on GitHub** → confirm the permissions on GitHub's page.
4. You land back in Dispatch, then click **Install on repositories**. Pick a
   scratch repo.

You should return to `/repos?installed=<id>` with a banner and the installation
listed. The server log names the App at every subsequent boot:

```
[dispatch] github app "your-app-name" (id 1234567) registered
```

## [4] Prove the repo polls with the App, not `GITHUB_TOKEN` (#22 AC 6)

Do not simply unset `GITHUB_TOKEN` — boot needs it for the account-level calls
(§2). Instead, **corrupt it** and watch what still works:

```bash
GITHUB_TOKEN=ghp_deliberately_invalid npm run dev:server
```

| Surface | Expected | Why |
|---|---|---|
| `GET /api/health` | `providers[0].valid: false`, "Bad credentials" | uses `getProvider()` → env token |
| A tracked repo **under the installation** | board still updates, PR/checks resolve | uses `getProviderForRepo()` → minted installation token |
| A tracked repo **outside** it | fails | falls back to the bad env token, correctly |

A green card on a repo whose account owns the installation, while `/api/health`
reports bad credentials, is the proof. Nothing but an installation token could have
fetched it.

## [5] Close the inference (#22 AC 13 → ADR-0006 [8])

This is the point of the exercise. ADR-0006 [8] records, in writing:

> **Inferred, not observed.** That a pull request opened by an *App installation
> token* triggers `pull_request` runs without approval.

T1-3 (#4) and T1-4 (#5) are both built on it. Test it directly:

1. In the scratch repo, ensure a workflow triggers on `pull_request` (any trivial
   one — `run: echo ok` is enough).
2. Have Dispatch open a pull request on that repo with the installation token.
3. Look at the run:

```bash
gh run list --repo <owner>/<scratch> --limit 5
gh api /repos/<owner>/<scratch>/actions/runs --jq \
  '.workflow_runs[0] | {status, conclusion, event, actor: .actor.login, triggering_actor: .triggering_actor.login}'
```

**Read the result honestly:**

- `status: queued|in_progress|completed` → the arm holds. Record it in ADR-0006 [8],
  move "inferred" to "observed", and #4 proceeds as written.
- `status: action_required`, or no run at all → **the arm is false.** ADR-0006 [2]'s
  deletion of the `gh pr create` post-step does not work, `GH_PAT` has to come back,
  and #4 is a different ticket. Amend ADR-0006 and ADR-0002 [5] before writing any
  of #4.

Either way, write down what you saw — including the `actor` / `triggering_actor`,
which is the field that distinguishes an App installation from a PAT.

## [6] Cleanup

The scratch App is yours and costs nothing to leave installed. To remove it:
uninstall from `github.com/settings/installations`, then delete the App from
`github.com/settings/apps`. Clear Dispatch's memory of it with the `sqlite3` command
in §2.

## See also

- ADR-0006 [5] (per-deployment registration; the `?org=` correction) and [8] (the
  inference this runbook closes).
- `DEPLOY.md` §1.1 — the same key in production, via Secret Manager.
- [[oauth-callbacks-are-gets-that-write]] — why these GET routes flush a snapshot.
