#!/bin/bash
set -e

# Start Router and Sender Jobs
# Usage: ./dev/start-jobs.sh

echo "🚀 Starting router and sender jobs..."

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"

# Set project context
gcloud config set project $PROJECT_ID

echo "🔄 Starting router job..."
gcloud run jobs execute woosh-lifts-router-job --region $REGION --wait

echo "🔄 Starting sender job..."
gcloud run jobs execute woosh-lifts-sender-job --region $REGION --wait

echo "✅ Jobs started!"
echo "📋 Check logs with:"
echo "  gcloud run jobs logs read woosh-lifts-router-job --region $REGION"
echo "  gcloud run jobs logs read woosh-lifts-sender-job --region $REGION"
