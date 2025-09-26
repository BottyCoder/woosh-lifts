#!/bin/bash
set -e

echo "🚀 FORCE DEPLOY - Fresh build with no cache"

# Force fresh build with unique tag
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
IMAGE_TAG="force-${TIMESTAMP}"

echo "📦 Building fresh image with tag: ${IMAGE_TAG}"

# Build with fresh tag to force rebuild
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:${IMAGE_TAG}"

echo "🚀 Deploying with fresh image..."
gcloud run deploy woosh-lifts \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:${IMAGE_TAG}" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod,REGISTRY_PATH=./data/registry.csv \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest,SMSPORTAL_HMAC_SECRET=SMSPORTAL_HMAC_SECRET:latest" \
  --quiet

echo "✅ Force deploy completed!"
echo "📋 Service URL:"
gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)'
