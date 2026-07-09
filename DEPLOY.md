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
