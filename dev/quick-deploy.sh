#!/bin/bash
set -e

# Quick Deploy Script - Optimized for GCP Cloud Shell
# This script does everything in one optimized process

echo "🚀 Quick Deploy - Woosh Lifts"
echo "============================="

# Step 1: Quick git pull (no verbose output)
echo "📥 Pulling latest changes..."
git fetch origin --all --prune >/dev/null 2>&1
git pull origin main >/dev/null 2>&1
echo "✅ Code updated"

# Step 2: Deploy all services in parallel where possible
echo "🚀 Deploying services..."

# Deploy main service
echo "  📦 Main service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:$(date +%Y%m%d-%H%M%S)" >/dev/null 2>&1 &
MAIN_PID=$!

# Deploy router service  
echo "  📦 Router service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-router:$(date +%Y%m%d-%H%M%S)" >/dev/null 2>&1 &
ROUTER_PID=$!

# Deploy sender service
echo "  📦 Sender service..."
gcloud builds submit --tag "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-sender:$(date +%Y%m%d-%H%M%S)" >/dev/null 2>&1 &
SENDER_PID=$!

# Wait for builds to complete
echo "⏳ Waiting for builds to complete..."
wait $MAIN_PID && echo "✅ Main service built" || echo "❌ Main service build failed"
wait $ROUTER_PID && echo "✅ Router service built" || echo "❌ Router service build failed"  
wait $SENDER_PID && echo "✅ Sender service built" || echo "❌ Sender service build failed"

# Step 3: Deploy to Cloud Run (sequential for reliability)
echo "🚀 Deploying to Cloud Run..."

echo "  🌐 Deploying main service..."
gcloud run deploy woosh-lifts \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod,REGISTRY_PATH=./data/registry.csv \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest,SMSPORTAL_HMAC_SECRET=SMSPORTAL_HMAC_SECRET:latest" \
  --quiet

echo "  🌐 Deploying router service..."
gcloud run deploy woosh-lifts-router \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-router:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --quiet

echo "  🌐 Deploying sender service..."
gcloud run deploy woosh-lifts-sender \
  --image "africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/cloud-run-source-deploy/woosh-lifts-sender:latest" \
  --region "africa-south1" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --quiet

# Step 4: Quick smoke test
echo "🧪 Running quick smoke test..."
MAIN_URL=$(gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)' 2>/dev/null)
if curl -s "$MAIN_URL" >/dev/null; then
    echo "✅ Main service: OK"
else
    echo "❌ Main service: FAILED"
fi

echo ""
echo "🎉 Quick deploy completed!"
echo "📋 Service URLs:"
echo "  Main:   $MAIN_URL"
echo "  Router: $(gcloud run services describe woosh-lifts-router --region africa-south1 --format='value(status.url)' 2>/dev/null)"
echo "  Sender: $(gcloud run services describe woosh-lifts-sender --region africa-south1 --format='value(status.url)' 2>/dev/null)"
