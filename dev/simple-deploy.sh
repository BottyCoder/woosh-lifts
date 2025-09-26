#!/bin/bash
set -e

# Simple Deploy Script - Just Works
echo "🚀 Simple Deploy - Just Works!"

# Reset any uncommitted changes
echo "🔄 Resetting uncommitted changes..."
git reset --hard HEAD

# Pull latest
echo "📥 Pulling latest changes..."
git pull origin main

# Deploy main service
echo "📦 Deploying main service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:$(date +%Y%m%d-%H%M%S)"
gcloud run deploy woosh-lifts \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod,REGISTRY_PATH=./data/registry.csv \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest,SMSPORTAL_HMAC_SECRET=SMSPORTAL_HMAC_SECRET:latest" \
  --quiet

echo "✅ Main service deployed!"

# Deploy router service
echo "📦 Deploying router service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-router:$(date +%Y%m%d-%H%M%S)"
gcloud run deploy woosh-lifts-router \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-router:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --quiet

echo "✅ Router service deployed!"

# Deploy sender service
echo "📦 Deploying sender service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-sender:$(date +%Y%m%d-%H%M%S)"
gcloud run deploy woosh-lifts-sender \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-sender:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --quiet

echo "✅ Sender service deployed!"

echo ""
echo "🎉 All services deployed successfully!"
echo "📋 Service URLs:"
echo "  Main:   $(gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)')"
echo "  Router: $(gcloud run services describe woosh-lifts-router --region africa-south1 --format='value(status.url)')"
echo "  Sender: $(gcloud run services describe woosh-lifts-sender --region africa-south1 --format='value(status.url)')"
