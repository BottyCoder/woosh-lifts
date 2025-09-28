#!/usr/bin/env bash
set -euo pipefail

# Basic sanity tests for woosh-lifts admin endpoints and SMS integration
# Usage: BASE=https://your-service.run.app ./scripts/sanity.sh

BASE="${BASE:-http://localhost:8080}"
echo "Testing against: $BASE"

# Test 1: Admin status
echo "==> Test 1: GET /admin/status"
curl -sS "$BASE/admin/status" | jq .
echo

# Test 2: Create a lift
echo "==> Test 2: POST /admin/lifts"
LIFT_RESPONSE=$(curl -sS -X POST "$BASE/admin/lifts" -H 'Content-Type: application/json' \
  --data '{"msisdn":"27821110000","site_name":"Test Tower","building":"Block A","notes":"Sanity test lift"}')
echo "$LIFT_RESPONSE" | jq .
LIFT_ID=$(echo "$LIFT_RESPONSE" | jq -r '.data.id')
echo "Created lift ID: $LIFT_ID"
echo

# Test 3: Create a contact and link it
echo "==> Test 3: POST /admin/contacts"
CONTACT_RESPONSE=$(curl -sS -X POST "$BASE/admin/contacts" -H 'Content-Type: application/json' \
  --data '{"display_name":"Test Security","primary_msisdn":"27825550000","email":"security@test.com","role":"security"}')
echo "$CONTACT_RESPONSE" | jq .
CONTACT_ID=$(echo "$CONTACT_RESPONSE" | jq -r '.data.id')
echo "Created contact ID: $CONTACT_ID"
echo

echo "==> Test 3b: Link contact to lift"
LINK_RESPONSE=$(curl -sS -X POST "$BASE/admin/lifts/$LIFT_ID/contacts" -H 'Content-Type: application/json' \
  --data "{\"contact_id\":\"$CONTACT_ID\",\"relation\":\"security\"}")
echo "$LINK_RESPONSE" | jq .
echo

# Test 4: Resolve lift (should show linked contact)
echo "==> Test 4: GET /admin/resolve/lift?msisdn=27821110000"
curl -sS "$BASE/admin/resolve/lift?msisdn=27821110000" | jq .
echo

# Test 5: SMS with provider shape A
echo "==> Test 5: POST /sms/plain (Provider Shape A)"
SMS_RESPONSE_A=$(curl -sS -X POST "$BASE/sms/plain" -H 'Content-Type: application/json' \
  --data '{"id":"smk-001","phoneNumber":"+27821110000","incomingData":"Emergency help needed","provider":"operatorX"}')
echo "$SMS_RESPONSE_A" | jq .
echo

# Test 6: SMS with provider shape B
echo "==> Test 6: POST /sms/plain (Provider Shape B)"
SMS_RESPONSE_B=$(curl -sS -X POST "$BASE/sms/plain" -H 'Content-Type: application/json' \
  --data '{"from":"+27821110000","text":"Another test message","id":"smk-002"}')
echo "$SMS_RESPONSE_B" | jq .
echo

# Test 7: Messages pagination
echo "==> Test 7: GET /admin/messages?lift_id=$LIFT_ID"
curl -sS "$BASE/admin/messages?lift_id=$LIFT_ID&limit=10" | jq .
echo

echo "==> Sanity tests completed!"
