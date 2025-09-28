#!/usr/bin/env bash
set -euo pipefail

# Deploy with no-traffic rollout + health gate + promote
# Builds image, deploys with no traffic, probes /admin/status until healthy, then promotes to 100%

REGION="${REGION:-africa-south1}"
SVC="${SVC:-woosh-lifts}"
PROJECT_ID="$(gcloud config get-value core/project)"
TAG="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M%S)"
IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/app/$SVC:$TAG"

echo "🚀 Deploying $SVC with tag $TAG..."

# 0) Lockfile sanity (no drift)
echo "📦 Checking package-lock.json..."
if ! npm ci --omit=dev; then 
  echo "⚠️  package-lock.json drift detected, regenerating..."
  npm install --package-lock-only && npm ci --omit=dev
fi
ok "Dependencies resolved"

# 1) Build
echo "🔨 Building image: $IMAGE_URI"
gcloud builds submit --tag "$IMAGE_URI"

# 2) Deploy with NO traffic
echo "🚢 Deploying with no traffic..."
INSTANCE_CONN="$(gcloud sql instances describe lifts-pg --format='value(connectionName)')"
REV=$(gcloud run deploy "$SVC" \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --allow-unauthenticated \
  --no-traffic \
  --add-cloudsql-instances "$INSTANCE_CONN" \
  --concurrency 20 --max-instances 5 --min-instances 1 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod,COMMIT_SHA="$(git rev-parse HEAD)" \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,BRIDGE_ADMIN_TOKEN=BRIDGE_ADMIN_TOKEN:latest,DB_PASSWORD=DB_PASSWORD:latest \
  --format='value(status.latestCreatedRevisionName)')
echo "New revision: $REV"

# 3) Health probe (hit revision URL directly)
BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')"
REV_URL="${BASE/https:\/\//https:\/\/$REV---}"
echo "🔍 Probing: $REV_URL/admin/status"
for i in {1..20}; do
  out="$(curl -fsS "$REV_URL/admin/status" || true)"
  if [[ "$out" == *'"ok": true'* && "$out" == *'"db": true'* ]]; then 
    echo "✅ Healthy revision detected"
    break
  fi
  echo "⏳ waiting... ($i/20)"
  sleep 3
  if [[ $i -eq 20 ]]; then 
    echo "❌ Revision unhealthy after 60s"
    exit 1
  fi
done

# 4) Promote to 100%
echo "🎯 Promoting $REV to 100% traffic..."
gcloud run services update-traffic "$SVC" --region "$REGION" --to-revisions "$REV=100"
echo "✅ Promoted $REV to 100%"

# 5) Final health check on live service
echo "🔍 Final health check on live service..."
for i in {1..10}; do
  out="$(curl -fsS "$BASE/admin/status" || true)"
  if [[ "$out" == *'"ok": true'* && "$out" == *'"db": true'* ]]; then 
    echo "✅ Live service healthy"
    break
  fi
  echo "⏳ waiting for live service... ($i/10)"
  sleep 2
  if [[ $i -eq 10 ]]; then 
    echo "❌ Live service unhealthy"
    exit 1
  fi
done

echo "🎉 Deployment complete: $BASE"
