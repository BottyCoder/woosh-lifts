#!/usr/bin/env bash
set -euo pipefail

# Daily build → deploy → smoke for woosh-lifts
# Usage: bash --noprofile --norc ~/woosh-lifts/daily.sh

cd "$(dirname "$0")"

echo "==> Git fast-forward (stash untracked)"
git status --porcelain
git stash push --include-untracked -m "daily.sh autostash $(date +%F-%T)" || true
git fetch origin
git checkout main
git reset --hard origin/main

REGION="africa-south1"
PROJECT_ID="$(gcloud config get-value core/project)"
GIT_SHA="$(git rev-parse --short HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
IMAGE_TAG="${GIT_SHA}-${STAMP}"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/app/woosh-lifts:${IMAGE_TAG}"

echo "==> Build: ${IMAGE_URI}"
gcloud builds submit . --tag "${IMAGE_URI}"

echo "==> Run migrations"
npm ci || npm install
npm run migrate

echo "==> Deploy: Cloud Run (woosh-lifts)"
gcloud run deploy woosh-lifts \
  --image "${IMAGE_URI}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod,APP_BUILD="${IMAGE_TAG}",BRIDGE_BASE_URL=https://wa.woosh.ai,BRIDGE_TEMPLATE_NAME=growthpoint_testv1,BRIDGE_TEMPLATE_LANG=en \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest

echo "==> Route 100% traffic to latest (retry until ready)"
for i in {1..10}; do
  if gcloud run services update-traffic woosh-lifts --region "${REGION}" --to-latest --quiet; then
    echo "Traffic moved to latest."
    break
  else
    echo "Latest not ready yet; retry ${i}/10..."
    sleep 6
  fi
done

BASE="$(gcloud run services describe woosh-lifts --region "${REGION}" --format='value(status.url)')"
REQ_ID="smk-${STAMP}"
DEST="+27824537125"

echo "==> Smoke: POST ${BASE}/sms/direct id=${REQ_ID}"
( set +o histexpand; curl -iS -X POST "${BASE}/sms/direct" -H "Content-Type: application/json" \
  --data-raw "{\"id\":\"${REQ_ID}\",\"phoneNumber\":\"${DEST}\",\"incomingData\":\"Daily smoke – template path test.\"}"; )

echo "==> Logs for ${REQ_ID}"
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=woosh-lifts AND (jsonPayload.sms_id=\"${REQ_ID}\" OR textPayload:\"${REQ_ID}\")" \
  --limit=20 --format='value(textPayload)'

echo "==> Done."
