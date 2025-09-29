# Swathe 2: Lift (Retries, Breaker, DLQ) Implementation

## Overview

This implementation hardens the WhatsApp send path with exponential retries, circuit breaker pattern, and dead letter queue (DLQ) support. It provides resilience against temporary failures while maintaining zero regressions to current send behavior.

## Files Changed

- `src/lib/waBridge.js` - HTTP client with retry logic and jitter
- `src/lib/retryQueue.js` - Retry scheduling and processing
- `src/lib/breaker.js` - Circuit breaker pattern implementation
- `src/routes/send.js` - Send endpoints with retry/breaker integration
- `sql/03_add_retry_breaker.sql` - Database migration for retry/breaker support
- `scripts/sanity.sh` - Extended with Swathe 2 tests
- `src/server.js` - Wired send routes and retry processor

## New Environment Variables

- `RETRY_MAX_ATTEMPTS=4` (default: 4) - Maximum retry attempts
- `RETRY_SCHEDULE="1s,4s,15s,60s"` (default: "1s,4s,15s,60s") - Retry delays
- `RETRY_JITTER_MS=200` (default: 200) - Jitter range in milliseconds
- `BREAKER_FAIL_THRESHOLD=8` (default: 8) - Failures before opening breaker
- `BREAKER_HALF_OPEN_AFTER=60s` (default: 60) - Seconds before half-open
- `DLQ_ENABLED=true` (default: true) - Enable dead letter queue
- `DEV_FORCE_BRIDGE_ERROR=""` (dev only) - Force errors for testing

## Operator Runbook

```bash
# Cloud Shell
gcloud config set project woosh-lifts-20250924-072759
cd ~/woosh-lifts || { git clone https://github.com/BottyCoder/woosh-lifts.git ~/woosh-lifts; cd ~/woosh-lifts; }
git checkout main && git pull --rebase origin main
bash --noprofile --norc ./scripts/daily.sh     # builds, pushes, deploys
BASE="$(gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)')"
BASE="$BASE" ./scripts/sanity.sh               # smoke tests against live URL
```

## Smoke Expectations

### P1-P5: SMS Provider Adapters (Swathe 1)
- All SMS provider endpoints return HTTP 202 with `{"ok":true,"idempotent":false}`
- Duplicate messages return `{"ok":true,"idempotent":true}`
- Validation errors return HTTP 400 with field-specific errors

### P6: Send Routes (Swathe 2)
- `POST /send/text` - Send text message
  - Success: HTTP 200 with `{"ok":true,"status":"sent","message_id":"uuid"}`
  - Retry: HTTP 202 with `{"ok":true,"status":"queued","message_id":"uuid"}`
  - Breaker open: HTTP 503 with `{"error":"service_unavailable"}`

- `POST /send/template` - Send template message
  - Success: HTTP 200 with `{"ok":true,"status":"sent","message_id":"uuid"}`
  - Retry: HTTP 202 with `{"ok":true,"status":"queued","message_id":"uuid"}`

- `GET /send/breaker` - Breaker status
  - Returns: `{"ok":true,"breaker":{"state":"closed","failureCount":0}}`

- `GET /send/status/{messageId}` - Message status
  - Returns: `{"ok":true,"message":{"status":"sent","attempt_count":1}}`

### P7: Retry and Breaker Behavior
- Forced errors (if `DEV_FORCE_BRIDGE_ERROR` is set) are handled gracefully
- Message status endpoint returns attempt history
- Circuit breaker prevents cascading failures

## API Endpoints

### Send Endpoints
- `POST /send/text` - Send text message
- `POST /send/template` - Send template message
- `GET /send/status/{messageId}` - Get message status
- `GET /send/breaker` - Get breaker status
- `GET /send/health` - Health check

### SMS Endpoints (Swathe 1)
- `POST /sms/provider/{provider}` - Provider-specific endpoints
- `POST /sms/plain` - Legacy endpoint
- `GET /sms/health` - Health check

## Database Changes

### Messages Table
- Added `status` enum: `queued|sending|sent|permanently_failed`
- Added `attempt_count`, `last_error`, `last_error_at`, `next_attempt_at`
- Added `template_name`, `template_language`, `template_components`
- Added indexes for performance

### New Tables
- `wa_attempts` - Per-attempt logging with HTTP codes, latency, errors
- `breaker_state` - Circuit breaker state tracking

## Behavior

### Retry Logic
- Exponential backoff with jitter: 1s, 4s, 15s, 60s
- Retry on timeouts (408), 5xx errors, rate limiting (429)
- No retry on 4xx client errors (except 429)

### Circuit Breaker
- Opens after 8 consecutive failures
- Half-open after 60 seconds
- Closes after 3 successes in half-open state
- Blocks requests when open

### Dead Letter Queue
- Messages marked `permanently_failed` after max attempts
- DLQ events emitted with full payload snapshot
- Configurable via `DLQ_ENABLED` environment variable

## Rollback Plan

- Disable retry processor: Remove from server startup
- Disable breaker: Set `BREAKER_FAIL_THRESHOLD=0`
- Disable DLQ: Set `DLQ_ENABLED=false`
- Routes are additive, no existing behavior removed

## Testing

### Development Testing
```bash
# Force timeout errors
DEV_FORCE_BRIDGE_ERROR=timeout ./scripts/sanity.sh

# Force 500 errors  
DEV_FORCE_BRIDGE_ERROR=500 ./scripts/sanity.sh
```

### Production Monitoring
- Monitor `wa_attempts` table for success rates
- Monitor `breaker_state` for circuit breaker status
- Monitor `events` table for DLQ events
- Monitor message status distribution
