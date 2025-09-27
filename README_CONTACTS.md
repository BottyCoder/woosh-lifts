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

### Database Connectivity

**TCP Connection (default):**
```bash
DB_HOST=your-cloud-sql-host
DB_PORT=5432
DB_NAME=woosh_lifts
DB_USER=app_user
DB_PASSWORD=your-password
DB_SSL=true
```

**UNIX Socket Connection (Cloud SQL):**
```bash
DB_SOCKET_DIR=/cloudsql
DB_INSTANCE_CONNECTION_NAME=project:region:instance
DB_NAME=woosh_lifts
DB_USER=app_user
DB_PASSWORD=your-password
```

The system automatically detects the connection method based on available environment variables.

## Migration System

Migrations are stored in `sql/` directory and run automatically during deployment:

```bash
# Manual migration (if needed)
npm run migrate
```

Migrations are idempotent - safe to run multiple times.

## Admin API Endpoints

All admin endpoints include CORS headers and use consistent response format:
- **Success**: `{ ok: true, data: {...} }`
- **Error**: `{ ok: false, error: { code: "...", message: "..." } }`

### Lift Management

**Create/Update Lift:**
```bash
POST /admin/lifts
Content-Type: application/json

{
  "msisdn": "27821110000",        # Required, 10-15 digits
  "site_name": "Tower A",         # Optional, max 255 chars
  "building": "Block 3",          # Optional, max 255 chars
  "notes": "Emergency contact"    # Optional, max 1000 chars
}
```

**Get Lift:**
```bash
GET /admin/lifts/{uuid}
# Returns: { ok: true, data: { id, msisdn, site_name, building, notes, created_at } }
```

**Resolve Lift (Auto-create):**
```bash
GET /admin/resolve/lift?msisdn=27821110000
# Returns: { ok: true, data: { lift: {...}, contacts: [...], created: true/false } }
```

### Contact Management

**Create/Update Contact:**
```bash
POST /admin/contacts
Content-Type: application/json

{
  "display_name": "Security Desk",           # Optional, max 255 chars
  "primary_msisdn": "27825550000",          # Optional, 10-15 digits (or email required)
  "email": "security@building.com",         # Optional, valid email (or msisdn required)
  "role": "security"                        # Optional, max 100 chars
}
```

**List Lift Contacts:**
```bash
GET /admin/lifts/{uuid}/contacts
# Returns: { ok: true, data: [{ id, display_name, primary_msisdn, email, role, relation }] }
```

**Link Contact to Lift:**
```bash
POST /admin/lifts/{lift_uuid}/contacts
Content-Type: application/json

{
  "contact_id": "contact-uuid",    # Required
  "relation": "tenant"             # Optional, max 32 chars, defaults to "tenant"
}
```

**Unlink Contact:**
```bash
DELETE /admin/lifts/{lift_uuid}/contacts/{contact_uuid}
# Returns: { ok: true }
```

### Consent Management

**Set Contact Consent:**
```bash
POST /admin/contacts/{uuid}/consent
Content-Type: application/json

{
  "channel": "sms",              # Required: "sms" or "wa"
  "status": "opt_in",            # Required: "opt_in" or "opt_out"
  "source": "web_form"           # Optional, max 255 chars
}
```

### Messages & Pagination

**List Messages:**
```bash
GET /admin/messages?lift_id={uuid}&limit=50&cursor={base64_cursor}
# Returns: { ok: true, data: [...], pagination: { next_cursor, has_more } }
```

**Pagination Format:**
- `limit`: 1-200, default 50
- `cursor`: Base64-encoded `{"last_id": "uuid", "last_ts": "ISO8601"}`
- `next_cursor`: Present when more results available

### Status
- `GET /admin/status` - Enhanced with database status, counts, and build info

## SMS Integration

The `/sms/plain` endpoint accepts multiple provider formats and:

1. **Normalizes** incoming SMS payloads from various providers
2. **Resolves** lift by MSISDN (auto-creates if missing)
3. **Records** inbound message in database
4. **Emits** events for audit trail
5. **Continues** with existing WhatsApp template-first flow
6. **Returns** enhanced response with `lift_id`, `msisdn`, `contacts_count`

### Accepted Provider Formats

**Provider Shape A:**
```json
{
  "id": "op-123",
  "phoneNumber": "+27821110000",
  "incomingData": "Emergency help needed",
  "provider": "operatorX"
}
```

**Provider Shape B:**
```json
{
  "from": "+27821110000",
  "text": "Emergency help needed",
  "id": "msg-456"
}
```

**Response Format:**
```json
{
  "ok": true,
  "msisdn": "27821110000",
  "lift_id": "uuid",
  "contacts_count": 2
}
```

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
