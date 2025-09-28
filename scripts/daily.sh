#!/usr/bin/env bash
set -euo pipefail
if ! npm ci --omit=dev; then npm install --omit=dev; fi
REGION="${REGION:-africa-south1}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value core/project)}"
TAG="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M%S)"
IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/app/woosh-lifts:$TAG"
gcloud builds submit --tag "$IMAGE_URI"
gcloud run deploy woosh-lifts \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=${BRIDGE_BASE_URL:-https://wa.woosh.ai},ENV=${ENV:-prod} \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,BRIDGE_ADMIN_TOKEN=BRIDGE_ADMIN_TOKEN:latest,DATABASE_URL=DATABASE_URL:latest
