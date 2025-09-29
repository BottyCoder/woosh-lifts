# Swathe 1: SMS Provider Adapters Implementation

## Overview

This implementation adds provider-agnostic SMS ingest with idempotency support. Multiple SMS providers can now send messages through dedicated endpoints that normalize to a consistent internal format.

## Files Changed

- `src/lib/normalize.js` - Provider adapters for Twilio, Infobip, MTN, Vodacom, Generic
- `src/lib/ingest.js` - Message ingestion with idempotency support
- `src/routes/sms.js` - New SMS routes with provider endpoints
- `src/server.js` - Wired SMS routes and migrate-on-boot
- `sql/02_add_idempotency.sql` - Database migration for idempotency
- `scripts/migrate.js` - Database migration runner
- `scripts/sanity.sh` - Comprehensive smoke tests
- `test/fixtures/providers/*/` - Test fixtures for all providers

## New Environment Variables

- `ENABLE_PROVIDER_ADAPTERS=true` (default: true) - Feature flag for provider adapters
- `DATABASE_URL` - Required for migrations (existing)

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

### P1 Happy Paths (HTTP 202)
- `POST /sms/provider/twilio` - Twilio webhook format
- `POST /sms/provider/infobip` - Infobip webhook format  
- `POST /sms/provider/mtn` - MTN webhook format
- `POST /sms/provider/vodacom` - Vodacom webhook format
- `POST /sms/provider/generic` - Generic format
- `POST /sms/plain` - Legacy format (backward compatibility)

All should return: `{"ok":true,"idempotent":false,"message_id":"uuid"}`

### P2 Idempotency (HTTP 202)
- Duplicate messages return: `{"ok":true,"idempotent":true,"message_id":"uuid"}`

### P3 Validation Errors (HTTP 400)
- Invalid MSISDN: `{"error":"validation_error","field":"msisdn"}`
- Empty text: `{"error":"validation_error","field":"text"}`
- Missing fields: `{"error":"validation_error","field":"provider_id"}`

### P4 Edge Cases (HTTP 202)
- Special characters, unicode, numbers in message text
- All should process successfully

### P5 Health Check (HTTP 200)
- `GET /sms/health` returns: `{"ok":true,"service":"sms-routes"}`

## API Endpoints

### Provider Endpoints
- `POST /sms/provider/twilio` - Twilio webhook format
- `POST /sms/provider/infobip` - Infobip webhook format
- `POST /sms/provider/mtn` - MTN webhook format  
- `POST /sms/provider/vodacom` - Vodacom webhook format
- `POST /sms/provider/generic` - Generic format

### Legacy Endpoint
- `POST /sms/plain` - Backward compatible with existing format

### Health Check
- `GET /sms/health` - Service health check

## Database Changes

- Added `provider` and `provider_id` columns to `messages` table
- Added unique index on `(provider, provider_id)` for idempotency
- Added `meta` column for storing original payloads
- Migrations run automatically on server startup when `DATABASE_URL` is present

## Rollback Plan

- Remove unique index: `DROP INDEX idx_messages_provider_idempotency`
- Disable feature: `ENABLE_PROVIDER_ADAPTERS=false`
- Routes are additive, no existing behavior removed
