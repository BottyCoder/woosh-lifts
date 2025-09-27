#!/usr/bin/env bash
set -euo pipefail

# Stable, non-destructive build→canary→promote flow.
# - Builds once
# - Deploys to separate service "woosh-lifts-canary" (prod untouched)
# - Health + smoke test on canary
# - Only if canary is green, deploy SAME image to prod and flip traffic
# Usage: bash --noprofile --norc ~/woosh-lifts/daily_canary.sh

ACCOUNT_EMAIL="${ACCOUNT_EMAIL:-marc@woosh.ai}"
PROJECT_ID="woosh-lifts-20250924-072759"
REGION="africa-south1"
SERVICE_MAIN="woosh-lifts"
SERVICE_CANARY="woosh-lifts-canary"

echo "==> gcloud context"
gcloud config set account "${ACCOUNT_EMAIL}" >/dev/null
gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud config set run/region "${REGION}" >/dev/null

cd "$(dirname "$0")"

echo "==> Git fast-forward (stash untracked)"
git stash push --include-untracked -m "canary autostash $(date +%F-%T)" || true
git fetch origin
git checkout main
git reset --hard origin/main

GIT_SHA="$(git rev-parse --short HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
IMAGE_TAG="${GIT_SHA}-${STAMP}"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/app/woosh-lifts:${IMAGE_TAG}"

echo "==> Build: ${IMAGE_URI}"
gcloud builds submit . --tag "${IMAGE_URI}"

echo "==> Run migrations"
npm ci || npm install
npm run migrate

echo "==> Deploy to CANARY: ${SERVICE_CANARY}"
gcloud run deploy "${SERVICE_CANARY}" \
  --image "${IMAGE_URI}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 2 \
  --set-env-vars ENV=prod,APP_BUILD="${IMAGE_TAG}",BRIDGE_BASE_URL=https://wa.woosh.ai,BRIDGE_TEMPLATE_NAME=growthpoint_testv1,BRIDGE_TEMPLATE_LANG=en \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest

BASE_CANARY="$(gcloud run services describe "${SERVICE_CANARY}" --region "${REGION}" --format='value(status.url)')"

echo "==> Canary status"
curl -sS "${BASE_CANARY}/admin/status" | jq .

echo "==> Canary smoke: /sms/direct"
REQ_ID="canary-$(date +%H%M%S)"
DEST="+27824537125"
( set +o histexpand; curl -iS -X POST "${BASE_CANARY}/sms/direct" -H "Content-Type: application/json" \
  --data-raw "{\"id\":\"${REQ_ID}\",\"phoneNumber\":\"${DEST}\",\"incomingData\":\"Emergency Button\"}"; )

echo "==> Canary logs for ${REQ_ID}"
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_CANARY} AND (jsonPayload.sms_id=\"${REQ_ID}\" OR textPayload:\"${REQ_ID}\")" \
  --limit=50 --format='value(jsonPayload)'

# Wait for Logging to ingest (retry up to ~30s)
echo "==> Verify canary produced wa_template_ok (retrying for ingestion delay)"
FOUND="0"
for i in {1..10}; do
  OK_COUNT="$(gcloud logging read \
    "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_CANARY} \
     AND (jsonPayload.event=\"wa_template_ok\" OR textPayload:\"wa_template_ok\") \
     AND (jsonPayload.sms_id=\"${REQ_ID}\" OR textPayload:\"${REQ_ID}\")" \
    --freshness=5m --limit=1 --format='value(insertId)' | wc -l | tr -d ' ')"
  if [ "${OK_COUNT}" = "1" ]; then
    FOUND="1"
    break
  fi
  echo "   …not yet (attempt ${i}/10); sleeping 3s"
  sleep 3
done

if [ "${FOUND}" != "1" ]; then
  echo "!! Canary did not surface wa_template_ok in logs. NOT promoting."
  echo "==> Recent relevant canary logs (last 40 entries):"
  gcloud logging read \
    "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_CANARY} \
     AND (jsonPayload.sms_id=\"${REQ_ID}\" OR textPayload:\"${REQ_ID}\" OR jsonPayload.event=\"wa_template_fail\" OR jsonPayload.event=\"wa_send_ok\" OR jsonPayload.event=\"wa_template_ok\")" \
    --freshness=10m --limit=40 --format='value(jsonPayload,textPayload)'
  exit 2
fi

echo "==> Promote: deploy SAME image to PROD (${SERVICE_MAIN})"
gcloud run deploy "${SERVICE_MAIN}" \
  --image "${IMAGE_URI}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod,APP_BUILD="${IMAGE_TAG}",BRIDGE_BASE_URL=https://wa.woosh.ai,BRIDGE_TEMPLATE_NAME=growthpoint_testv1,BRIDGE_TEMPLATE_LANG=en \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest

echo "==> Flip 100% traffic to latest (retry)"
for i in {1..10}; do
  if gcloud run services update-traffic "${SERVICE_MAIN}" --region "${REGION}" --to-latest --quiet; then
    echo "Traffic moved to latest."
    break
  else
    echo "Latest not ready; retry ${i}/10..."
    sleep 6
  fi
done

BASE_MAIN="$(gcloud run services describe "${SERVICE_MAIN}" --region "${REGION}" --format='value(status.url)')"
echo "==> PROD status"
curl -sS "${BASE_MAIN}/admin/status" | jq .

echo "==> Done. Build ${IMAGE_TAG} is live."
