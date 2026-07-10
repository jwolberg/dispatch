# Deploying Dispatch to Cloud Run (authenticated)

> **Read this first.** Dispatch has **no built-in authentication** and holds
> credentials that can **merge PRs to production**, file issues, and spend your
> Anthropic budget. Deploy it **authenticated only** — never with
> `--allow-unauthenticated`. Access it through an IAM-gated proxy. Hosting it
> openly contradicts the local-first design and is unsafe.

- **Project:** pick a GCP project → project id **`YOUR_PROJECT_ID`**
- **Service:** `dispatch` on Cloud Run, region `us-central1` (adjust as needed)
- **Runtime:** single container — Express serves the built SPA + API on `$PORT`,
  binds `0.0.0.0` with `ALLOW_NONLOCAL=1` (a container can't bind localhost)
- **Secrets:** Secret Manager (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, optional `GITLAB_TOKEN`, optional `SLACK_WEBHOOK_URL`)

> **Slack notifications (optional):** store a Slack Incoming Webhook URL as a
> secret and pass it as `SLACK_WEBHOOK_URL` to mirror the activity feed into a
> channel. Add to the deploy command:
> `--set-secrets SLACK_WEBHOOK_URL=slack-webhook-url:latest` (after
> `gcloud secrets create slack-webhook-url --data-file=- <<< "$WEBHOOK"`). Treat
> the URL as a secret — anyone with it can post to your channel.

## 0. Prerequisites

```bash
gcloud config set project YOUR_PROJECT_ID
# Billing must be enabled on the project; Cloud Run + Cloud Build require it.
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com
```

## 1. Create the secrets

Values live in your macOS keychain (`dispatch-ANTHROPIC_API_KEY`,
`dispatch-GITHUB_TOKEN`). Pipe them straight into Secret Manager without
printing them:

```bash
for k in ANTHROPIC_API_KEY GITHUB_TOKEN; do
  name=$(echo "$k" | tr 'A-Z_' 'a-z-')           # ANTHROPIC_API_KEY -> anthropic-api-key
  security find-generic-password -s "dispatch-$k" -w \
    | gcloud secrets create "$name" --data-file=- --replication-policy=automatic \
    || security find-generic-password -s "dispatch-$k" -w \
    | gcloud secrets versions add "$name" --data-file=-
done
```

(Use `-l` instead of `-s` if your keychain item is stored under the label
attribute. Add `GITLAB_TOKEN` the same way if you track GitLab repos.)

### 1.1 `DISPATCH_ENCRYPTION_KEY` — required before registering a GitHub App

Registering a GitHub App from the browser (§3.5) hands Dispatch the App's **private
key**, at runtime. It does not exist when the process boots, so it cannot come from
the environment: Dispatch writes it to SQLite, encrypted at rest under this key.

```bash
openssl rand -base64 32 \
  | gcloud secrets create dispatch-encryption-key --data-file=- --replication-policy=automatic
```

Then pass it in alongside the others in §2:

```
--set-secrets DISPATCH_ENCRYPTION_KEY=dispatch-encryption-key:latest
```

Three things follow from this, and none of them are optional:

- **Back the key up somewhere you will still have it after a redeploy.** Lose it and
  the App's private key is unrecoverable ciphertext. Dispatch **refuses to start**
  rather than silently reverting to `GITHUB_TOKEN` — recover the key, or clear the
  `github_app` table and register a new App.
- **Never store it in the same bucket as the snapshot.** The snapshot *is* the
  ciphertext; the key is what protects it.
- **Rotating the App's private key is not complete until the old snapshot versions
  expire.** See §4.1.

Not needed for local development or for a `GITHUB_TOKEN`-only deployment. Dispatch
boots without it as long as no App is registered.

## 2. Deploy

`--source .` uploads the repo, builds the `Dockerfile` via Cloud Build, and
deploys — no local Docker needed.

```bash
gcloud run deploy dispatch \
  --project YOUR_PROJECT_ID \
  --region us-central1 \
  --source . \
  --no-allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --memory 512Mi \
  --set-env-vars ALLOW_NONLOCAL=1,HOST=0.0.0.0,DISPATCH_DB_PATH=/data/dispatch.db,DISPATCH_GCS_BUCKET=YOUR_PROJECT_ID-state \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,GITHUB_TOKEN=github-token:latest
```

`DISPATCH_GCS_BUCKET` makes the database survive redeploys — see §4. Without it
every deploy resets the repo registry.

- `--no-allow-unauthenticated` — **the safety control.** Only callers with the
  `run.invoker` IAM role can reach the service.
- `--min-instances 1 --max-instances 1` — a single warm instance. One instance
  avoids SQLite multi-writer issues and keeps state warm between requests.

Grant yourself invoker access:

```bash
gcloud run services add-iam-policy-binding dispatch \
  --region us-central1 \
  --member="user:you@example.com" \
  --role="roles/run.invoker"
```

If the deploy reports the runtime service account can't read a secret, grant it:

```bash
PROJNUM=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
for s in anthropic-api-key github-token; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${PROJNUM}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

## 3. Access it

The service has no public URL you can just open (auth required). Use an
authenticated local proxy:

```bash
gcloud beta run services proxy dispatch --region us-central1
# → opens http://localhost:8080 tunneled with your gcloud identity
```

## 3.5 Connect your repos

**Preferred: register a GitHub App** from *Repo Config → GitHub App*. You name it,
choose your personal account or an organization, and confirm its permissions on
GitHub's own page — no PAT, no shell. Dispatch stores the App's private key
encrypted (§1.1) and, once installed, repos under that account authenticate with a
minted installation token instead of `GITHUB_TOKEN`.

There is no central Dispatch App: this repo is deployed by anyone, for themselves,
so each deployment registers its own (ADR-0006 §5).

**`GITHUB_TOKEN` is optional once an App is installed** (#21). Discover fans out over
every installation, `/api/health` reports one entry per credential, and the
rate-limit banner shows whichever budget is smallest. Set the env token only if you
need:

- **repos outside every installation** — an installation token sees only the repos
  that installation was granted; or
- **GitLab**, which has no App story at all.

It also remains the documented local-development path.

The rest of this section is the `GITHUB_TOKEN` path, which remains fully supported
and is the whole GitLab story. Connecting a repo that way works exactly as it does
locally — same tokens, same permissions, same Track button. See **Connecting a
repo** in [`README.md`](README.md#connecting-a-repo) for the fine-grained PAT
permissions, the `claude-code-action` install, and how preview URLs are discovered.
Only two things differ on Cloud Run.

**Where the tokens live.** `GITHUB_TOKEN` came from Secret Manager in §1–2. To
also track GitLab repos, add its token the same way and attach it:

```bash
security find-generic-password -s dispatch-GITLAB_TOKEN -w \
  | gcloud secrets create gitlab-token --data-file=- --replication-policy=automatic

gcloud run services update dispatch --region us-central1 \
  --update-secrets GITLAB_TOKEN=gitlab-token:latest

# Self-hosted GitLab only — the default base URL for repos tracked by path:
gcloud run services update dispatch --region us-central1 \
  --update-env-vars GITLAB_HOST=https://gitlab.example.com
```

Grant the runtime service account `secretmanager.secretAccessor` on any new
secret, as in §2. Tokens are read per provider on first use, so a GitHub-only
deployment never needs `GITLAB_TOKEN` set.

**Reaching the API.** Track repos through the proxy's UI at
`http://localhost:8080`. The same origin serves the API, so the pattern/merge
settings that have no UI yet are a curl away — add `-u any:$DISPATCH_PASSWORD`
if you set the shared-password gate:

```bash
curl -X POST http://localhost:8080/api/repos \
  -H 'content-type: application/json' \
  -d '{"path":"acme/widgets","preview_url_pattern":"https://widgets-pr-{n}.vercel.app"}'
```

Preview deploys need **nothing** on the Cloud Run side: Vercel (or Netlify,
Render, Cloudflare Pages) reports the URL to GitHub as a commit or deployment
status, and Dispatch reads it from there on the next poll. The only requirement
is that the PAT carries **Commit statuses: read** and **Deployments: read**.

Tracked repos live in the `repos` table, which the provider cannot rebuild — if
you skip the snapshot bucket in §4, every redeploy loses them and you re-Track.
Issues themselves are never lost; they're on GitHub, labeled `dispatch`, and
re-import on the first poll after tracking.

## 3.6 Enable the build loop on a tracked repo

**Tracking a repo writes nothing to it.** A tracked repo is not an onboarded one —
that is what the repo card's ⚠ *No Claude automation detected* flag distinguishes.
Onboarding commits `.github/workflows/claude.yml` to the target repo and sets one
secret there.

This is done against the **target repo**, not against Cloud Run, so it is the same
command locally and in production. Nothing here touches Dispatch's own deployment:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) \
GH_SETUP_TOKEN=github_pat_xxx \
  ./scripts/install-claude-action.sh <owner>/<repo>
```

**Exactly one secret is written into the target repo: your Claude auth token.** Not
a `GH_PAT`, not the App's private key, not `APP_CLIENT_ID`. That is the point of
ADR-0006 [2] — writing an App credential into every onboarded repo would invert the
blast radius, since one compromised repo would then compromise every repo the App is
installed on.

- Prefer `CLAUDE_CODE_OAUTH_TOKEN` (bills your Claude subscription) over
  `ANTHROPIC_API_KEY` (metered). The installer **deletes** a leftover
  `ANTHROPIC_API_KEY`, because it outranks the OAuth token in Claude's auth
  precedence and would silently keep billing the API.
- `GH_SETUP_TOKEN` needs **Contents, Workflows, Secrets: write**. It is used by the
  installer and never stored in the repo.

The workflow pushes a branch under the repo's own default `GITHUB_TOKEN`, passed
**explicitly** as `github_token: ${{ github.token }}`. That input has no default:
omit it and `claude-code-action` tries to mint a token from *Anthropic's* Claude
GitHub App and fails with `401 … not installed on this repository` (#25).

Dispatch then opens the pull request with its **App installation token**, which is
what makes `on: pull_request` CI run on it without an approval gate — observed
directly in #22, not inferred (ADR-0006 [8]).

> **Not shipped yet.** The PR-opening half is ticket **#4**. Until it lands, `@claude`
> runs and pushes a branch, and no pull request appears. This is the one place where
> a production deployment is not yet end-to-end.

Because the poller is what turns a branch into a pull request, **Dispatch must be
running** for a build to proceed past the branch. That adds no new availability
requirement — it must be up to render the board — but it turns a missed poll from
"the board is stale" into "the build did not continue".

## 4. Persistence — a GCS snapshot, not a volume

The SQLite DB lives on the instance's ephemeral disk at `/data/dispatch.db`.
With one warm instance it survives across requests, but it is **lost on redeploy
or instance recycle**. Without the snapshot below, tracked repos, chats and the
spend ledger reset (issues themselves remain on GitHub, labeled `dispatch`, and
`status_cache` / `activity` rebuild from the provider on the next poll).

**Set `DISPATCH_GCS_BUCKET` and the problem goes away**, for about a cent a
month. Dispatch uploads a consistent snapshot (`VACUUM INTO`) whenever a table
the provider cannot rebuild is written — `repos`, `chats`, `tickets`, `spend` —
and restores it on boot when the local file is absent. The upload happens
*before the response is acked*, because Cloud Run throttles CPU the moment a
response is returned.

```bash
gcloud storage buckets create gs://YOUR_PROJECT_ID-state \
  --location us-central1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://YOUR_PROJECT_ID-state --versioning

# The Cloud Run runtime service account needs object access on this bucket only.
gcloud storage buckets add-iam-policy-binding gs://YOUR_PROJECT_ID-state \
  --member="serviceAccount:$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role=roles/storage.objectAdmin

gcloud run services update dispatch --region us-central1 \
  --update-env-vars DISPATCH_GCS_BUCKET=YOUR_PROJECT_ID-state
```

Optional: `DISPATCH_GCS_OBJECT` (defaults to `dispatch.db`). Turn versioning on
— a corrupt snapshot then stays recoverable. The server logs a warning at boot
whenever the DB is on an unmounted path *and* no bucket is configured.

### 4.1 Expire noncurrent versions, or key rotation rotates nothing

The snapshot is the **whole database**, and since #2 that database contains the
GitHub App's private key. It is encrypted at rest (§1.1), so what reaches the
bucket is ciphertext — but object versioning, which §4 turns on deliberately so a
corrupt snapshot stays recoverable, has a second consequence:

> **An old object version keeps the *old* ciphertext, readable with the *old*
> encryption key, indefinitely.**

So if you ever rotate the App's private key or `DISPATCH_ENCRYPTION_KEY`, the
superseded secret remains recoverable from a noncurrent version until that version
is deleted. Rotation is not finished until the old versions are gone. Set a
lifecycle rule so they age out on their own:

```bash
cat > /tmp/lifecycle.json <<'JSON'
{"rule": [
  {"action": {"type": "Delete"},
   "condition": {"daysSinceNoncurrentTime": 30, "isLive": false}},
  {"action": {"type": "Delete"},
   "condition": {"numNewerVersions": 10, "isLive": false}}
]}
JSON
gcloud storage buckets update gs://YOUR_PROJECT_ID-state --lifecycle-file=/tmp/lifecycle.json
rm /tmp/lifecycle.json
```

Thirty days of recoverability, at most ten superseded copies. Tighten the window if
you rotate more often than that; it is the upper bound on how long a retired
credential stays readable.

To rotate immediately rather than waiting for the rule, delete the noncurrent
versions by hand:

```bash
gcloud storage ls --all-versions gs://YOUR_PROJECT_ID-state/dispatch.db
gcloud storage rm gs://YOUR_PROJECT_ID-state/dispatch.db#GENERATION
```

### Why not a volume?

Cloud Run supports both, and both are wrong here:

- **Filestore (NFS)** has a **1 TiB minimum** on its cheapest tier — roughly
  **$164/month** to protect a file measured in kilobytes — and needs a VPC plus
  Direct VPC egress.
- **Cloud Storage FUSE** is disqualified by Google's own documentation: it "does
  not support file locking", is "not POSIX compliant", and "shouldn't be used as
  the backend for storing a database." SQLite would corrupt silently.
- **Litestream** is the usual answer for durable SQLite, but it replicates on a
  background ticker, and this service uses request-based billing where CPU is
  throttled outside requests. Making it work means instance-based billing, where
  you are charged for the entire lifecycle of the instance, every hour of the
  month.

The snapshot works because the data is tiny and rarely written. See
`server/db/snapshot.ts` and ADR-0005.

## 5. Operate

```bash
# Redeploy after changes
gcloud run deploy dispatch --project YOUR_PROJECT_ID --region us-central1 --source .

# Logs
gcloud run services logs read dispatch --region us-central1 --limit 100

# Tear down
gcloud run services delete dispatch --region us-central1
```
