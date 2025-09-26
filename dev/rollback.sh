#!/bin/bash
set -e

# Woosh Lifts Rollback Script
# Usage: ./dev/rollback.sh

echo "🔄 Rolling back woosh-lifts to previous revision..."

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export SERVICE_NAME="woosh-lifts"

# List recent revisions
echo "📋 Recent revisions:"
gcloud run revisions list --service $SERVICE_NAME --region $REGION --limit=5

# Get the second most recent revision (previous one)
PREVIOUS_REVISION=$(gcloud run revisions list --service $SERVICE_NAME --region $REGION --limit=2 --format='value(metadata.name)' | tail -1)

if [[ -z "$PREVIOUS_REVISION" ]]; then
    echo "❌ No previous revision found to rollback to"
    exit 1
fi

echo "🔄 Rolling back to revision: $PREVIOUS_REVISION"

# Rollback to previous revision
gcloud run services update-traffic $SERVICE_NAME \
  --region $REGION \
  --to-revisions $PREVIOUS_REVISION=100

echo "✅ Rollback complete!"
echo "📋 Service URL:"
gcloud run services describe $SERVICE_NAME --region $REGION --format='value(status.url)'
echo "📋 Current traffic split:"
gcloud run services describe $SERVICE_NAME --region $REGION --format='value(status.traffic[].percent,status.traffic[].revisionName)'
