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

# P1: Happy paths (normalization works)
phase "P1 Happy Paths - Provider Normalization"

echo "Testing Twilio provider..."
R1=$(hit POST /sms/provider/twilio "$(cat test/fixtures/providers/twilio/happy.json)")
assert_contains "$R1" '"ok":true'
assert_contains "$R1" '"idempotent":false'

echo "Testing Infobip provider..."
R2=$(hit POST /sms/provider/infobip "$(cat test/fixtures/providers/infobip/happy.json)")
assert_contains "$R2" '"ok":true'
assert_contains "$R2" '"idempotent":false'

echo "Testing MTN provider..."
R3=$(hit POST /sms/provider/mtn "$(cat test/fixtures/providers/mtn/happy.json)")
assert_contains "$R3" '"ok":true'
assert_contains "$R3" '"idempotent":false'

echo "Testing Vodacom provider..."
R4=$(hit POST /sms/provider/vodacom "$(cat test/fixtures/providers/vodacom/happy.json)")
assert_contains "$R4" '"ok":true'
assert_contains "$R4" '"idempotent":false'

echo "Testing Generic provider..."
R5=$(hit POST /sms/provider/generic "$(cat test/fixtures/providers/generic/happy.json)")
assert_contains "$R5" '"ok":true'
assert_contains "$R5" '"idempotent":false'

echo "Testing legacy /sms/plain endpoint..."
R6=$(hit POST /sms/plain '{"phoneNumber":"+27824537125","incomingData":"Hello world","id":"demo-123"}')
assert_contains "$R6" '"ok":true'
assert_contains "$R6" '"idempotent":false'

# P2: Dupe (idempotency)
phase "P2 Idempotency Tests"

echo "Testing Twilio duplicate..."
D1=$(hit POST /sms/provider/twilio "$(cat test/fixtures/providers/twilio/dupe.json)")
assert_contains "$D1" '"ok":true'
assert_contains "$D1" '"idempotent":false'

D2=$(hit POST /sms/provider/twilio "$(cat test/fixtures/providers/twilio/dupe.json)")
assert_contains "$D2" '"ok":true'
assert_contains "$D2" '"idempotent":true'

echo "Testing Infobip duplicate..."
D3=$(hit POST /sms/provider/infobip "$(cat test/fixtures/providers/infobip/dupe.json)")
assert_contains "$D3" '"ok":true'
assert_contains "$D3" '"idempotent":false'

D4=$(hit POST /sms/provider/infobip "$(cat test/fixtures/providers/infobip/dupe.json)")
assert_contains "$D4" '"ok":true'
assert_contains "$D4" '"idempotent":true'

# P3: Validation failures
phase "P3 Validation Error Tests"

echo "Testing invalid MSISDN..."
V1=$(hit POST /sms/provider/generic '{"msisdn":"12345","text":"bad number","provider_id":"v-1"}' || true)
assert_contains "$V1" '"error"'
assert_contains "$V1" '"field":"msisdn"'

echo "Testing empty text..."
V2=$(hit POST /sms/provider/generic '{"msisdn":"+27824537125","text":"   ","provider_id":"v-2"}' || true)
assert_contains "$V2" '"field":"text"'

echo "Testing missing required field..."
V3=$(hit POST /sms/provider/generic '{"msisdn":"+27824537125","text":"missing provider_id"}' || true)
assert_contains "$V3" '"error"'
assert_contains "$V3" '"field":"provider_id"'

# P4: Edge cases
phase "P4 Edge Cases"

echo "Testing special characters..."
E1=$(hit POST /sms/provider/twilio "$(cat test/fixtures/providers/twilio/edge.json)")
assert_contains "$E1" '"ok":true'

echo "Testing unicode characters..."
E2=$(hit POST /sms/provider/infobip "$(cat test/fixtures/providers/infobip/edge.json)")
assert_contains "$E2" '"ok":true'

echo "Testing special chars in MTN..."
E3=$(hit POST /sms/provider/mtn "$(cat test/fixtures/providers/mtn/edge.json)")
assert_contains "$E3" '"ok":true'

echo "Testing numbers in Vodacom..."
E4=$(hit POST /sms/provider/vodacom "$(cat test/fixtures/providers/vodacom/edge.json)")
assert_contains "$E4" '"ok":true'

echo "Testing special chars in Generic..."
E5=$(hit POST /sms/provider/generic "$(cat test/fixtures/providers/generic/edge.json)")
assert_contains "$E5" '"ok":true'

# P5: Health check
phase "P5 Health Check"

echo "Testing SMS routes health..."
H1=$(hit GET /sms/health)
assert_contains "$H1" '"ok":true'
assert_contains "$H1" '"service":"sms-routes"'

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