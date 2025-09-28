#!/bin/bash
set -e

# Woosh Lifts Deployment Script (Bulletproof Pipeline)
# Usage: ./dev/deploy.sh

echo "🚀 Deploying woosh-lifts with bulletproof pipeline..."

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export SERVICE_NAME="woosh-lifts"

# Set project context
gcloud config set project $PROJECT_ID

# Run preflight checks
echo "🔍 Running preflight checks..."
./scripts/preflight.sh

# Run bulletproof deployment
echo "🚀 Running bulletproof deployment..."
./scripts/deploy_promote.sh

echo "✅ Deployment complete!"
echo "📋 Service URL:"
gcloud run services describe $SERVICE_NAME --region $REGION --format='value(status.url)'
