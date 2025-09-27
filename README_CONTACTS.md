# Cloud Contact Manager - Operations Guide

## Overview

The woosh-lifts service now includes a Cloud Contact Manager that integrates with PostgreSQL to manage lifts, contacts, and SMS messaging workflows.

## Database Schema

The system uses PostgreSQL with the following core entities:

- **lifts**: Elevator/lift installations with MSISDN identifiers
- **contacts**: People and roles associated with lifts
- **lift_contacts**: Many-to-many relationships between lifts and contacts
- **consents**: Channel-specific opt-in/opt-out preferences
- **messages**: All SMS/WhatsApp communications (inbound/outbound)
- **events**: Audit trail of system activities

## Environment Variables

Required for database connectivity:

```bash
DB_HOST=your-cloud-sql-host
DB_PORT=5432
DB_NAME=woosh_lifts
DB_USER=app_user
DB_PASSWORD=your-password
DB_SSL=true
```

## Migration System

Migrations are stored in `sql/` directory and run automatically during deployment:

```bash
# Manual migration (if needed)
npm run migrate
```

Migrations are idempotent - safe to run multiple times.

## Admin API Endpoints

All admin endpoints require authentication (reuse existing admin token):

### Lift Management
- `POST /admin/lifts` - Create/update lift by MSISDN
- `GET /admin/lifts/:id` - Get lift details
- `GET /admin/resolve/lift?msisdn=...` - Auto-create and resolve lift

### Contact Management
- `POST /admin/contacts` - Create/update contact
- `GET /admin/lifts/:id/contacts` - List contacts for lift
- `POST /admin/lifts/:id/contacts` - Link contact to lift
- `DELETE /admin/lifts/:id/contacts/:contactId` - Unlink contact

### Consent Management
- `POST /admin/contacts/:id/consent` - Set channel consent (sms/wa, opt_in/opt_out)

### Status
- `GET /admin/status` - Enhanced with database status and counts

## SMS Integration

The `/sms/plain` endpoint now:

1. **Normalizes** incoming SMS payloads from various providers
2. **Resolves** lift by MSISDN (auto-creates if missing)
3. **Records** inbound message in database
4. **Emits** events for audit trail
5. **Continues** with existing WhatsApp template-first flow

## Deployment Notes

- Migrations run automatically during `daily.sh` and `daily_canary.sh`
- Database connections use SSL by default
- All database operations are logged for audit
- Schema is additive-only (no destructive changes)

## Rollback Strategy

If issues arise:

1. **Code rollback**: Revert to previous commit (no schema changes needed)
2. **Migration rollback**: Current migrations are additive-only, safe to keep
3. **Database rollback**: Use Cloud SQL point-in-time recovery if needed

## Monitoring

Check database connectivity:
```bash
curl -sS "$BASE/admin/status" | jq .db
```

View recent events:
```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="woosh-lifts" AND jsonPayload.event="sms_received"' --freshness=10m --limit=20
```

## Security Notes

- Admin endpoints reuse existing authentication
- Database credentials stored in Secret Manager
- All queries use parameterized statements
- SSL required for database connections
