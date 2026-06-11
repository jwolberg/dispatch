# Deploying Dispatch to Cloud Run (authenticated)

> **Read this first.** Dispatch has **no built-in authentication** and holds
> credentials that can **merge PRs to production**, file issues, and spend your
> Anthropic budget. Deploy it **authenticated only** — never with
> `--allow-unauthenticated`. Access it through an IAM-gated proxy. Hosting it
> openly contradicts the local-first design and is unsafe.

- **Project:** `dispatch-1` → project id **`dispatch-1-499113`**
- **Service:** `dispatch` on Cloud Run, region `us-central1` (adjust as needed)
- **Runtime:** single container — Express serves the built SPA + API on `$PORT`,
  binds `0.0.0.0` with `ALLOW_NONLOCAL=1` (a container can't bind localhost)
- **Secrets:** Secret Manager (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, optional `GITLAB_TOKEN`)

## 0. Prerequisites

```bash
gcloud config set project dispatch-1-499113
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
  --project dispatch-1-499113 \
  --region us-central1 \
  --source . \
  --no-allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --memory 512Mi \
  --set-env-vars ALLOW_NONLOCAL=1,HOST=0.0.0.0,DISPATCH_DB_PATH=/data/dispatch.db \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,GITHUB_TOKEN=github-token:latest
```

- `--no-allow-unauthenticated` — **the safety control.** Only callers with the
  `run.invoker` IAM role can reach the service.
- `--min-instances 1 --max-instances 1` — a single warm instance. One instance
  avoids SQLite multi-writer issues and keeps state warm between requests.

Grant yourself invoker access:

```bash
gcloud run services add-iam-policy-binding dispatch \
  --region us-central1 \
  --member="user:jmwolberg@gmail.com" \
  --role="roles/run.invoker"
```

If the deploy reports the runtime service account can't read a secret, grant it:

```bash
PROJNUM=$(gcloud projects describe dispatch-1-499113 --format='value(projectNumber)')
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
gcloud run services proxy dispatch --region us-central1
# → opens http://localhost:8080 tunneled with your gcloud identity
```

## 4. Persistence caveat

The SQLite DB lives on the instance's ephemeral disk at `/data/dispatch.db`.
With one warm instance it survives across requests, but it is **lost on
redeploy or instance recycle** — tracked repos and filed tickets would reset
(the issues themselves remain on GitHub, labeled `dispatch`). Derived state
(`status_cache`, `activity`) always rebuilds from the provider on the next poll.

For durable state across redeploys, mount a persistent volume at `/data`. A
Filestore (NFS) mount is the most SQLite-friendly option:

```bash
# After creating a Filestore instance + share, add to the deploy command:
#   --add-volume=name=data,type=nfs,location=<FS_IP>:/<share> \
#   --add-volume-mount=volume=data,mount-path=/data
```

(GCS/`gcsfuse` volumes also exist but are not recommended for SQLite due to
file-locking semantics.)

## 5. Operate

```bash
# Redeploy after changes
gcloud run deploy dispatch --project dispatch-1-499113 --region us-central1 --source .

# Logs
gcloud run services logs read dispatch --region us-central1 --limit 100

# Tear down
gcloud run services delete dispatch --region us-central1
```
