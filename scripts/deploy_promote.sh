#!/usr/bin/env bash
set -euo pipefail

# helpers
say(){ printf "%s\n" "$*"; }
ok(){ echo "✅ $*"; }
bad(){ echo "❌ $*" >&2; exit 1; }

REGION="${REGION:-africa-south1}"
SVC="${SVC:-woosh-lifts}"
PROJECT_ID="$(gcloud config get-value core/project)"
TAG="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M%S)"
IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/app/$SVC:$TAG"

say "🚀 Deploying $SVC with tag $TAG..."
say "📦 Checking package-lock.json..."
if ! npm ci --omit=dev; then
  say "npm ci failed; regenerating lockfile"
  npm install --package-lock-only
  npm ci --omit=dev
fi
ok "Dependencies OK"

say "🛠️  Building image $IMAGE_URI"
gcloud builds submit --tag "$IMAGE_URI"

INSTANCE_CONN="$(gcloud sql instances describe lifts-pg --format='value(connectionName)')"

say "🚢 Deploying new revision with NO traffic"
REV="$(gcloud run deploy "$SVC" \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --allow-unauthenticated \
  --no-traffic \
  --min-instances 1 \
  --add-cloudsql-instances "$INSTANCE_CONN" \
  --concurrency 20 --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,BRIDGE_ADMIN_TOKEN=BRIDGE_ADMIN_TOKEN:latest,DB_PASSWORD=DB_PASSWORD:latest \
  --format='value(status.latestCreatedRevisionName)')"
ok "New revision: $REV"

BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')"
REV_URL="${BASE/https:\/\//https:\/\/$REV---}"
say "🩺 Probing: $REV_URL/admin/status"

for i in {1..20}; do
  out="$(curl -fsS "$REV_URL/admin/status" || true)"
  if echo "$out" | jq -e '.ok==true and .db==true' >/dev/null 2>&1; then
    ok "Healthy revision"
    break
  fi
  say "waiting... ($i)"
  sleep 3
  if [[ $i -eq 20 ]]; then
    bad "Revision unhealthy; aborting traffic switch"
  fi
done

say "🔀 Promoting $REV to 100%"
gcloud run services update-traffic "$SVC" --region "$REGION" --to-revisions "$REV=100"
ok "Traffic promoted"

say "✅ Final health check"
curl -fsS "$BASE/admin/status" | jq .
