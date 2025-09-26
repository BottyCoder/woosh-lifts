#!/bin/bash
set -e

# Router Job Deployment Script
# Usage: ./dev/deploy-router-job.sh

echo "🚀 Deploying woosh-lifts-router-job to Google Cloud Run..."

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export JOB_NAME="woosh-lifts-router-job"
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$JOB_NAME"

# Generate version tag based on timestamp
VERSION_TAG=$(date +%Y%m%d-%H%M%S)
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$JOB_NAME:$VERSION_TAG"

# Set project context
gcloud config set project $PROJECT_ID

echo "📦 Building and pushing router job image with tag: $VERSION_TAG..."
gcloud builds submit --tag "$IMAGE_URI" -f Dockerfile.router-job

echo "🚀 Deploying router job to Cloud Run..."
gcloud run jobs create $JOB_NAME \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --max-retries 3 \
  --parallelism 1 \
  --task-count 1 \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --set-env-vars ENV=prod \
  --memory 512Mi \
  --cpu 1 \
  || gcloud run jobs replace $JOB_NAME \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --max-retries 3 \
  --parallelism 1 \
  --task-count 1 \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest" \
  --set-env-vars ENV=prod \
  --memory 512Mi \
  --cpu 1

echo "✅ Router job deployment complete!"
echo "📋 Job name: $JOB_NAME"
