# Woosh Lifts — Project Details (Cursor Hand-off)

**Service (prod):** https://woosh-lifts-oqodqtnlma-bq.a.run.app  
**GCP:** project `woosh-lifts-20250924-072759`, region `africa-south1`, service `woosh-lifts`  
**Repo:** https://github.com/BottyCoder/woosh-lifts (base branch: `chore/unique-msisdn`)  
**Admin UI (static):** served from a public GCS bucket (see Runbook below)

---

## What we delivered today
**Admin UI**
- Single-file HTML admin (`admin/admin.html`) with:
  - Lift resolution by MSISDN + inline editing
  - Contact add/edit/link/unlink
  - Message history viewer
  - Real-time status pill (green/red)
  - Responsive layout
- CORS calls to `/admin/*` on the prod service
- No Cloud Run changes (no traffic flips, no env churn, no schema changes)

**Hosting**
- Deployed the UI as a static file to a dedicated **public** GCS bucket:
  - Name (example in use): `woosh-lifts-admin-woosh-lifts-20250924-072759-9d3f6a`
  - Location: `africa-south1`
  - Access: **Uniform**, public read (`allUsers → Storage Object Viewer`)
  - We serve by object URL (website config optional/hidden in some UIs)
  - `Cache-Control: no-cache` on `admin.html` to avoid stale loads

**Fixes**
- Avoided Cloud Shell crashes by eliminating multi-line git/gsutil blocks
- Replaced the temporary GitHub "loader" with the **real `admin.html`** hosted on GCS
- Corrected branch path (file lives on `admin-ui` PR branch)
- Removed the `</script>`-in-string issue that broke the loader

**Verified working**
- `/admin/status` → ok/db/template enabled (template: `growthpoint_testv1`, lang `en`)
- Resolve MSISDN `27824537125` → edit/save Lift persists
- Contacts → add/upsert → link/unlink works
- Messages tab renders

---

## Static Admin — Bucket Setup (Console clicks)
1. Cloud Storage → **Buckets** → **Create**  
   - Name: `woosh-lifts-admin-<project>-<suffix>` (globally unique)  
   - Location type: **Region** → **africa-south1 (Johannesburg)**  
   - Access control: **Uniform** → Create
2. Bucket → **Permissions** → **Grant access**  
   - Principal: `allUsers`  
   - Role: **Storage Object Viewer** → Save
3. (Optional) If your UI shows it: **Configuration** → **Website configuration**  
   - Main page: `admin.html`  
   - Not found page: `admin.html`
4. Prepare `admin.html` locally (from PR branch `admin-ui`):  
   - Source: `admin/admin.html`  
   - Ensure the Service URL is set:  
     - If the file uses `__BASE_URL__`, replace with `https://woosh-lifts-oqodqtnlma-bq.a.run.app`  
     - Otherwise insert after `<head>`:
       ```html
       <script>window.BASE_URL="https://woosh-lifts-oqodqtnlma-bq.a.run.app";</script>
       ```
5. Upload: Bucket → **Objects** → **Upload files** → select `admin.html`  
6. Click `admin.html` → **Edit metadata** → add `Cache-Control: no-cache` → Save
7. Public URL format:  
   ```
   https://storage.googleapis.com/<your-bucket-name>/admin.html
```

---

## RUNBOOK — Admin UI (Single Source of Truth)
**Public URL (current):**  
`https://storage.googleapis.com/woosh-lifts-admin-woosh-lifts-20250924-072759-9d3f6a/admin.html`

**Prod Service URL:**  
`https://woosh-lifts-oqodqtnlma-bq.a.run.app`

**Bucket:**  
`woosh-lifts-admin-woosh-lifts-20250924-072759-9d3f6a` (region: `africa-south1`, **public** via `allUsers: Storage Object Viewer`)

### Update workflow (no shell required)
1) Pull `admin/admin.html` from the `admin-ui` branch (or open raw on GitHub) and save locally.  
2) Set the base URL as described above.  
3) Upload to the bucket as `admin.html`.  
4) Ensure metadata `Cache-Control: no-cache`.  
5) Open the public URL and hard-refresh.

### 60-second acceptance checklist
- Status pill = green (`/admin/status` ok + db + template)  
- Resolve `27824537125` → edit "Site Name/Notes" → **Save Lift**  
- Contacts: add/upsert → **Link** → **Unlink**  
- Messages tab renders without errors  
- No Cloud Run traffic/env/schema changes performed

### Safety rails
- If CORS ever blocks from a new origin, create a **0% canary** adding `Access-Control-Allow-Origin` for that origin, test via tag URL, then promote.
- Keep using `--update-env-vars` (merge) if env changes are ever required; never `--set-env-vars` (replace).

---

## NEW SHELL STARTUP (Read-only bootstrap; safe in Cloud Shell)
```bash
#!/usr/bin/env bash
# --- Woosh Lifts: safe shell bootstrap (no deploys) ---

set -euo pipefail

# ---- Static config (edit if the project name/region ever change)
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export SVC="woosh-lifts"
export REPO_URL="https://github.com/BottyCoder/woosh-lifts.git"
export REPO_DIR="$HOME/woosh-lifts"

# ---- gcloud context (no mutations beyond config set)
gcloud --quiet config set project "$PROJECT_ID" >/dev/null

# ---- Repo checkout (no code changes)
mkdir -p "$REPO_DIR"
cd "$REPO_DIR"
if [ ! -d .git ]; then
  git clone "$REPO_URL" . >/dev/null
fi
git fetch --all --prune --quiet
# Stay on your working branch if it exists; otherwise fall back to main
if git rev-parse --verify chore/unique-msisdn >/dev/null 2>&1; then
  git checkout -q chore/unique-msisdn
else
  git checkout -q main
fi
git status -sb

# ---- Cloud Run live status (read-only)
BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')"
LIVE_REV="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.latestReadyRevisionName)')"
TRAFFIC="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.traffic)')"

echo "------------------------------------------------------------------"
echo " Project:   $PROJECT_ID"
echo " Service:   $SVC  (region: $REGION)"
echo " URL:       $BASE"
echo " Live rev:  $LIVE_REV"
echo " Traffic:   $TRAFFIC"
echo " Branch:    $(git branch --show-current)"
echo "------------------------------------------------------------------"

# ---- Quick health pings (read-only)
echo "# GET /admin/status"
curl -fsS "$BASE/admin/status" | jq -r '.'

echo "# GET / (root)"
curl -fsS "$BASE/" || true

# ---- Handy aliases for this shell (optional)
alias grs="gcloud run services describe \"$SVC\" --region \"$REGION\" --format='yaml(status,status.traffic,status.url)'"
alias logs="REV=\$(gcloud run services describe \"$SVC\" --region \"$REGION\" --format='value(status.latestReadyRevisionName)'); \
  gcloud logging read \"resource.type=cloud_run_revision AND resource.labels.service_name=$SVC AND resource.labels.revision_name=\$REV\" \
  --limit=200 --format=json | jq -r '.[] | .textPayload // .jsonPayload.message // tostring'"

echo "Ready. No deploys performed."
```

---

## Handy read-only CLI (copy/paste)
```bash
REGION="africa-south1"; SVC="woosh-lifts"
gcloud run services describe "$SVC" --region "$REGION" \
  --format='value(status.url,status.latestReadyRevisionName,status.traffic)'

BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')"
curl -fsS "$BASE/admin/status" | jq -r '.ok, .db, .templateEnabled, .templateName, .templateLang'

REV="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.latestReadyRevisionName)')"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SVC\" AND resource.labels.revision_name=\"$REV\"" \
  --freshness="15m" --limit=20 \
  --format='table(timestamp, textPayload, jsonPayload.message)'
```

---

## Next steps (for Cursor)
1) Open the `admin-ui` PR and confirm it only touches `admin/admin.html` and `README-admin.md`.  
2) Merge PR once verified; the static admin is already live and decoupled from Cloud Run.  
3) If desired, add `admin/RUNBOOK.md` that links back to this **Project Details** as the single source of truth.
