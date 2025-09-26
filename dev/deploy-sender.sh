#!/bin/bash
set -e

# Sender Service Deployment Script
# Usage: ./dev/deploy-sender.sh

echo "🚀 Deploying woosh-lifts-sender to Google Cloud Run..."

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export SERVICE_NAME="woosh-lifts-sender"
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$SERVICE_NAME"

# Generate version tag based on timestamp
VERSION_TAG=$(date +%Y%m%d-%H%M%S)
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$SERVICE_NAME:$VERSION_TAG"

# Set project context
gcloud config set project $PROJECT_ID

echo "📦 Building and pushing sender image with tag: $VERSION_TAG..."
gcloud builds submit --tag "$IMAGE_URI"

echo "🚀 Deploying sender to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest"

echo "✅ Sender deployment complete!"
echo "📋 Service URL:"
gcloud run services describe $SERVICE_NAME --region $REGION --format='value(status.url)'
