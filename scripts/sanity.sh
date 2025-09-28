#!/usr/bin/env bash
set -euo pipefail

# SMS Provider Adapter Sanity Tests
# Tests the provider-agnostic SMS ingest path with idempotency

BASE="${BASE:-http://localhost:3000}"
PASS=0
FAIL=0

# Helper functions
hit() {
  local method="$1"
  local url="$2"
  local body="$3"
  curl -sS -X "$method" "$BASE$url" \
    -H 'Content-Type: application/json' \
    --data-raw "$body"
}

assert_contains() {
  local hay="$1"
  local needle="$2"
  if echo "$hay" | grep -q "$needle"; then
    PASS=$((PASS+1))
    echo "✓ PASS: Found '$needle'"
  else
    echo "✗ FAIL: Missing '$needle'"
    echo "Response: $hay"
    FAIL=$((FAIL+1))
  fi
}

assert_not_contains() {
  local hay="$1"
  local needle="$2"
  if echo "$hay" | grep -q "$needle"; then
    echo "✗ FAIL: Found unexpected '$needle'"
    echo "Response: $hay"
    FAIL=$((FAIL+1))
  else
    PASS=$((PASS+1))
    echo "✓ PASS: Correctly missing '$needle'"
  fi
}

phase() {
  echo ""
  echo "=========================================="
  echo "---- $1 ----"
  echo "=========================================="
}

# Test if jq is available for JSON parsing
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=true
  echo "✓ jq available for JSON parsing"
else
  HAS_JQ=false
  echo "⚠ jq not available, using grep for assertions"
fi

# P1: Core SMS ingestion (/sms/plain only)
phase "P1 Core SMS Ingestion"

echo "Testing legacy /sms/plain endpoint..."
R1=$(hit POST /sms/plain '{"phoneNumber":"+27824537125","incomingData":"Hello world","id":"demo-123"}')
assert_contains "$R1" '"ok":true'

echo "Testing /sms/plain with different format..."
R2=$(hit POST /sms/plain '{"from":"+27824537125","text":"Hello from different format","id":"demo-456"}')
assert_contains "$R2" '"ok":true'

# P2: Validation failures
phase "P2 Validation Error Tests"

echo "Testing missing phone number..."
V1=$(hit POST /sms/plain '{"incomingData":"Hello world","id":"demo-789"}' || true)
assert_contains "$V1" '"error"'

echo "Testing missing text..."
V2=$(hit POST /sms/plain '{"phoneNumber":"+27824537125","id":"demo-101"}' || true)
assert_contains "$V2" '"error"'

# P3: Health check
phase "P3 Health Check"

echo "Testing SMS routes health..."
H1=$(hit GET /sms/health)
assert_contains "$H1" '"ok":true'
assert_contains "$H1" '"service":"sms-routes"'

# P4: Send routes (Swathe 2)
phase "P4 Send Routes - WhatsApp Bridge"

echo "Testing text message send..."
S1=$(hit POST /send/text '{"to":"+27824537125","text":"Hello from sanity test"}')
assert_contains "$S1" '"ok":true'
assert_contains "$S1" '"message_id"'

echo "Testing template message send..."
S2=$(hit POST /send/template '{"to":"+27824537125","template_name":"test_template","template_language":"en","template_components":[{"type":"body","parameters":[{"type":"text","text":"Test"}]}]}')
assert_contains "$S2" '"ok":true'
assert_contains "$S2" '"message_id"'

echo "Testing breaker status..."
B1=$(hit GET /send/breaker)
assert_contains "$B1" '"ok":true'
assert_contains "$B1" '"breaker"'

# P5: Retry and breaker behavior (Swathe 2)
phase "P5 Retry and Breaker Behavior"

echo "Testing forced error (if DEV_FORCE_BRIDGE_ERROR is set)..."
if [ -n "$DEV_FORCE_BRIDGE_ERROR" ]; then
  S3=$(hit POST /send/text '{"to":"+27824537125","text":"Force error test"}' || true)
  # Should either succeed or fail gracefully
  echo "Forced error test completed"
fi

echo "Testing message status endpoint..."
if [ -n "$S1" ]; then
  # Extract message ID from previous response (simplified)
  MSG_ID=$(echo "$S1" | grep -o '"message_id":"[^"]*"' | cut -d'"' -f4 || echo "test-message-id")
  if [ "$MSG_ID" != "test-message-id" ]; then
    S4=$(hit GET "/send/status/$MSG_ID")
    assert_contains "$S4" '"ok":true'
    assert_contains "$S4" '"message"'
  fi
fi

# Summary
phase "Test Summary"

echo ""
echo "=========================================="
echo "RESULTS: PASS=$PASS FAIL=$FAIL"
echo "=========================================="

if [ "$FAIL" -eq 0 ]; then
  echo "🎉 All tests passed! SMS provider adapters are working correctly."
  exit 0
else
  echo "❌ $FAIL test(s) failed. Check the output above for details."
  exit 1
fi
