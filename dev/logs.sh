#!/bin/bash

# Woosh Lifts Logs Script
# Usage: ./dev/logs.sh [limit]

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export SERVICE_NAME="woosh-lifts"

# Default limit is 100 if not provided
LIMIT=${1:-100}

echo "📋 Recent logs for $SERVICE_NAME (last $LIMIT lines):"
echo "=================================================="
gcloud run services logs read $SERVICE_NAME --region $REGION --limit=$LIMIT
