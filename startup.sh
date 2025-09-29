#!/usr/bin/env -S bash --noprofile --norc
# Safe-mode deploy runner for woosh-lifts (Cloud Run)
# - Keeps the terminal open on errors
# - Guards fragile steps (revision readiness, SQL connectivity)
# - No tmux inside the script (launch tmux manually if desired)

set -Eeuo pipefail
trap 'code=$?; echo; echo "❌ Script failed (exit $code) at line $LINENO."; echo "Tip: scroll up for the first error line."; echo; read -rp "Press Enter to stay in this shell… "' ERR

export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export CLOUDSDK_CORE_PRINT_UNHANDLED_TRACEBACKS=false
export CLOUDSDK_PYTHON_SITEPACKAGES=1
export BROWSER=/bin/true
export PAGER=cat
export LESS=FiRX
export GIT_EDITOR=true
export GCM_INTERACTIVE=Never

PROJECT_ID="woosh-lifts-20250924-072759"
REGION="africa-south1"
SVC="woosh-lifts"
BRANCH="chore/unique-msisdn"
SQL_INSTANCE="lifts-pg"

echo "==> Setting gcloud project: $PROJECT_ID"
gcloud --quiet config set project "$PROJECT_ID" >/dev/null 2>&1

echo "==> Git bootstrap ($BRANCH)"
mkdir -p "$HOME/woosh-lifts"
cd "$HOME/woosh-lifts"
if [ ! -d .git ]; then
  echo "Cloning repo…"
  git clone https://github.com/BottyCoder/woosh-lifts.git .
fi
git fetch origin "$BRANCH"
git checkout -q "$BRANCH" || git checkout -qb "$BRANCH" "origin/$BRANCH"
git pull --rebase origin "$BRANCH" || true

TAG="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M%S)"
IMAGE="africa-south1-docker.pkg.dev/$PROJECT_ID/app/$SVC:$TAG"

echo "==> Building image: $IMAGE"
gcloud builds submit . --tag "$IMAGE"

echo "==> Resolving Cloud SQL connection"
INSTANCE_CONN="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')" || {
  echo "Could not resolve Cloud SQL instance '$SQL_INSTANCE'."; exit 1; }
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "==> Deploying Cloud Run service: $SVC"
gcloud run deploy "$SVC" --image "$IMAGE" --region "$REGION" --allow-unauthenticated \
  --service-account "$RUN_SA" --add-cloudsql-instances "$INSTANCE_CONN" \
  --set-env-vars ENV=prod,DB_SOCKET_DIR=/cloudsql,DB_INSTANCE_CONNECTION_NAME="$INSTANCE_CONN",DB_NAME=wooshlifts,DB_USER=app_user,DB_SSL=false,BRIDGE_BASE_URL=https://wa.woosh.ai \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,DB_PASSWORD=DB_PASSWORD:latest \
  --timeout=300s --max-instances=5 --concurrency=20

echo "==> Waiting for latest revision to be Ready"
REV="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.latestCreatedRevisionName)')"
if [[ -z "${REV:-}" ]]; then
  echo "No latestCreatedRevisionName found for $SVC. Check service status."; exit 1;
fi
for i in $(seq 1 60); do
  READY="$(gcloud beta run revisions describe "$REV" --region "$REGION" --format='value(status.conditions[?type=Ready].status)')" || READY=""
  [[ "$READY" == "True" ]] && break || sleep 3
done
if [[ "$READY" != "True" ]]; then
  echo "Revision $REV not Ready after timeout."; exit 1;
fi

echo "==> Promoting $REV to 100% traffic"
gcloud run services update-traffic "$SVC" --region "$REGION" --to-revisions "$REV=100"

# --- Breaker/DB step (SKIPPED by default) ---
# To run SQL from Cloud Shell, either:
#  (a) start a proxy:  cloud-sql-proxy "$INSTANCE_CONN" &  then connect host=127.0.0.1
#  (b) or use unix socket: host=/cloudsql/"$INSTANCE_CONN"
# Uncomment ONLY if you intentionally enable one of the above:
# export PGPASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD)"
# psql "host=/cloudsql/$INSTANCE_CONN dbname=wooshlifts user=app_user sslmode=disable" \
#   -c "UPDATE breaker_state SET state='closed', failure_count=0, success_count=0, opened_at=NULL, updated_at=now() WHERE service='wa_bridge';"

echo "==> Smoke test"
BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')"
curl -iS -X POST "$BASE/sms/direct" -H "Content-Type: application/json" \
  --data-raw '{"id":"tpl-newday-001","phoneNumber":"+27824537125","incomingData":"Emergency Button"}'

echo
echo "✅ Done. The shell will remain open."

# Notes:
# - Do NOT invoke tmux here. If you want it, start manually before running this script:
#     tmux new -s woosh || tmux attach -t woosh
