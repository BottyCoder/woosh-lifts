#!/bin/bash
set -e

# Woosh Lifts Smoke Test Script
# Usage: ./dev/smoke.sh

echo "🧪 Running smoke tests for woosh-lifts..."

# Set environment variables
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export SERVICE_NAME="woosh-lifts"

# Get service URL
URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format='value(status.url)')
echo "📋 Service URL: $URL"

# Test 1: Health check
echo "🔍 Testing health endpoint..."
HEALTH_RESPONSE=$(curl -fsS "$URL/" 2>/dev/null || echo "FAILED")
if [[ "$HEALTH_RESPONSE" == "woosh-lifts: ok" ]]; then
    echo "✅ Health check: OK"
else
    echo "❌ Health check: FAILED ($HEALTH_RESPONSE)"
fi

# Test 2: SMS webhook (permissive)
echo "🔍 Testing SMS webhook..."
SMS_RESPONSE=$(curl -fsS -X POST "$URL/sms/plain" \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke_test","phoneNumber":"27824537125","sc":"43922","incomingData":"SMOKE TEST"}' \
  2>/dev/null || echo "FAILED")

if [[ "$SMS_RESPONSE" == *"status"*"ok"* ]]; then
    echo "✅ SMS webhook: OK"
else
    echo "❌ SMS webhook: FAILED ($SMS_RESPONSE)"
fi

# Test 3: Latest inbound endpoint
echo "🔍 Testing latest inbound endpoint..."
LATEST_RESPONSE=$(curl -fsS "$URL/api/inbound/latest" 2>/dev/null || echo "FAILED")
if [[ "$LATEST_RESPONSE" == *"id"* && "$LATEST_RESPONSE" == *"message"* ]]; then
    echo "✅ Latest inbound: OK"
else
    echo "❌ Latest inbound: FAILED ($LATEST_RESPONSE)"
fi

# Test 4: Admin ping bridge
echo "🔍 Testing admin ping bridge..."
ADMIN_RESPONSE=$(curl -s -X POST "$URL/admin/ping-bridge" \
  -H "Content-Type: application/json" \
  -d '{"to":"+27824537125","text":"woosh-lifts bridge ping"}' \
  2>/dev/null || echo "FAILED")

echo "   Response: $ADMIN_RESPONSE"

if [[ "$ADMIN_RESPONSE" == *"status"*"ok"* ]]; then
    echo "✅ Admin ping bridge: OK"
else
    echo "❌ Admin ping bridge: FAILED ($ADMIN_RESPONSE)"
fi

echo "📋 Recent logs (last 20 lines):"
gcloud run services logs read $SERVICE_NAME --region $REGION --limit=20
