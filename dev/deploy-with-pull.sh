#!/bin/bash
set -e

# Complete Deployment Script with Robust Pull
# This script pulls latest changes and deploys all services

echo "🚀 Starting complete deployment with robust pull..."

# First, ensure we have the latest code
echo "📥 Step 1: Pulling latest changes..."
./dev/gcp-robust-pull.sh

if [ $? -ne 0 ]; then
    echo "❌ Robust pull failed, aborting deployment"
    exit 1
fi

echo ""
echo "🔧 Step 2: Deploying main service..."
./dev/deploy.sh

echo ""
echo "🔧 Step 3: Deploying router service..."
./dev/deploy-router.sh

echo ""
echo "🔧 Step 4: Deploying sender service..."
./dev/deploy-sender.sh

echo ""
echo "🧪 Step 5: Running smoke tests..."
./dev/smoke.sh

echo ""
echo "🎉 Complete deployment finished!"
echo "📋 All services deployed and tested"
