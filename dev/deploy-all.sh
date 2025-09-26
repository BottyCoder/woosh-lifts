#!/bin/bash
set -e

# Ultra-Simple Deploy All Script
# One command to rule them all

echo "🚀 Deploying all services..."

# Pull latest
git pull origin main >/dev/null 2>&1

# Deploy main service
echo "📦 Main service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:$(date +%Y%m%d-%H%M%S)" && \
gcloud run deploy woosh-lifts \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod,REGISTRY_PATH=./data/registry.csv \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest,SMSPORTAL_HMAC_SECRET=SMSPORTAL_HMAC_SECRET:latest" \
  --quiet

# Deploy router service
echo "📦 Router service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-router:$(date +%Y%m%d-%H%M%S)" && \
gcloud run deploy woosh-lifts-router \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-router:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --quiet

# Deploy sender service
echo "📦 Sender service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-sender:$(date +%Y%m%d-%H%M%S)" && \
gcloud run deploy woosh-lifts-sender \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-sender:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --quiet

echo "✅ All services deployed!"
