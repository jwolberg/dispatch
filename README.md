# Dispatch

A local-first control plane that takes a feature or bug from a chat-refined spec
→ a one-click GitHub/GitLab issue with an `@claude` mention → a live build/PR
board → preview testing → one-click ship to production — without leaving one
browser tab. The Git provider is the single source of truth; Dispatch stores
almost nothing and rebuilds its board from the provider alone.

- **Frontend:** React 18 + Vite + Tailwind v3 (dark), `http://localhost:5173`
- **Backend:** Express on Node 20, `http://127.0.0.1:3001` (localhost-only)
- **Storage:** SQLite (`./data/dispatch.db`) — disposable cache; deletable
- **Providers:** GitHub (Octokit) and GitLab (gitbeaker), behind one adapter seam

## Quick start

```bash
cp .env.example .env     # fill in the keys below
npm install
npm run dev              # starts backend (:3001) + Vite (:5173) together
```

Open `http://localhost:5173`. With a valid `.env` you'll get an empty board and a
working health check (footer shows DB + rate-limit status).

## Environment (`.env`, gitignored)

| Key | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | for spec chat | Anthropic Messages API (spec refinement + ticket JSON) |
| `ANTHROPIC_MODEL` | optional | Override the model (default `claude-sonnet-4-20250514`) |
| `GITHUB_TOKEN` | for GitHub repos | Fine-grained PAT (scopes below) |
| `GITLAB_TOKEN` | for GitLab repos | PAT with `api` scope |
| `GITLAB_HOST` | self-hosted GitLab | Base URL (defaults to `https://gitlab.com`) |
| `PORT` | optional | Backend port (default 3001) |
| `HOST` / `ALLOW_NONLOCAL` | optional | Bind host; non-local requires `ALLOW_NONLOCAL=1` |
| `DISPATCH_PASSWORD` | optional | Shared-password gate (HTTP Basic Auth) for internet-reachable deploys |
| `SLACK_WEBHOOK_URL` | optional | Slack [Incoming Webhook](https://api.slack.com/messaging/webhooks); mirrors the activity feed into a channel |

Keys are loaded server-side only, never sent to the browser, and redacted from
logs and error messages.

### Slack notifications

Set `SLACK_WEBHOOK_URL` to a Slack Incoming Webhook and Dispatch posts each
activity event (issue filed, column changes, PR opened, steered, merged, skill
runs) to that webhook's channel. Create one at
<https://api.slack.com/messaging/webhooks> (new app → **Incoming Webhooks** →
add to a channel). It's one-way and best-effort — a Slack outage never blocks
Dispatch. Any existing `hooks.slack.com/services/…` webhook works; reusing one
just routes notifications to that same channel.

## Prerequisites & setup

### GitHub repos

1. Install `anthropics/claude-code-action@v1`: run `/install-github-app` from
   Claude Code in the repo — this configures the GitHub App and the
   `ANTHROPIC_API_KEY` secret.
2. The workflow should trigger on `issues: [opened]` and
   `issue_comment: [created]` filtered to `@claude`, with scoped permissions
   (`contents: write`, `pull-requests: write`, `issues: write`) and a
   `timeout-minutes` (default 30).
3. Create a fine-grained PAT with **Issues (RW), Pull requests (RW), Contents
   (R), Actions (R)** on the target repos → set as `GITHUB_TOKEN`.

### GitLab repos (integration is beta)

> Verify current docs at code.claude.com/docs/en/gitlab-ci-cd.

4. Add the Claude job to `.gitlab-ci.yml` per the official setup, with
   `ANTHROPIC_API_KEY` stored as a masked CI/CD variable. `@claude` mentions in
   issues/MR threads trigger the job, which commits results back via MRs.
5. Create a PAT with `api` scope → `GITLAB_TOKEN`. For self-hosted instances,
   also set `GITLAB_HOST`.

### Both

6. Configure PR/MR preview deployments on your deploy provider (recommended).
   Dispatch **consumes** preview URLs and production deploy status — it never
   creates environments. Set a per-repo preview-URL pattern (e.g.
   `https://myapp-pr-{n}.vercel.app`) when tracking a repo; Dispatch prefers a
   live URL from deployment statuses when available.

## How it works

1. **Repos** — Dispatch lists every repo your token(s) can access; click
   **Track** (zero typing) or paste a path/URL. Tracked repos cache their
   description, `CLAUDE.md`, README excerpt, and a depth-2 file tree (refreshed
   on demand, ≤6h).
2. **Spec chat** — converse with Claude (scoped to a repo, context injected) to
   refine an issue spec, then **Generate ticket** → edit → **File ticket**.
3. **Board** — six columns derived from provider state: Spec, Queued, Building,
   Ready to test, Shipped, Blocked. A poller reconciles every 20s (active) /
   5min (idle); columns, PR linkage, and checks are derived, never stored.
4. **Test** — open the PR preview and per-check statuses from the card; **Steer**
   by commenting `@claude` to re-trigger the build.
5. **Ship** — one-click merge (gated on green + mergeable), confirmation modal,
   then the issue auto-closes and the card reaches Shipped.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Backend + Vite together |
| `npm run typecheck` | Type-check server and web |
| `npm run check:seam` | Assert no provider SDK imports outside `server/providers/` |
| `npm run verify` | typecheck + seam guard |

## Rebuild rule

The Git provider is the source of truth. Deleting `data/dispatch.db` and
restarting rebuilds all non-draft cards from the provider on the first poll —
only local drafts (unsent spec chats) are lost.
