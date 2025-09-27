# Woosh Lifts — Project Details

**Project ID:** `woosh-lifts-20250924-072759`  
**Region:** `africa-south1`  
**Runtime:** Node.js 20 (alpine)  
**Entrypoint:** `node server.js`  
**Services:**  
- **Prod:** `woosh-lifts`  
- **Canary:** `woosh-lifts-canary`  
**Repo:** https://github.com/BottyCoder/woosh-lifts

---

## High-level Overview
The service receives inbound SMS on `/sms/plain`, normalizes provider shapes, resolves the **Lift** by **MSISDN** (mobile number **of the lift**), logs messages/events, and pushes WhatsApp notifications via Woosh Bridge using a template-first strategy with fallback.

We now include a **Cloud Contact Manager** backed by **Cloud SQL for PostgreSQL 15**, enabling:
- Lifts keyed by `msisdn`
- Contacts (people)
- `lift_contacts` many-to-many (roles/relations)
- Consents per channel (SMS / WA)
- Messages and Events audit trails

All admin CRUD is exposed via `/admin/*` endpoints (CORS-enabled, auth-ready).

---

## Architecture & Key Components
**Core directories**
- `src/server.js` — Express server, routes, WhatsApp template flow, admin APIs.
- `src/db.js` — PostgreSQL pool; supports TCP and Cloud SQL Unix sockets.
- `src/validate.js` — input validation (msisdn/email/uuid).
- `src/mw/log.js` & `src/mw/error.js` — structured logs & error mapper.
- `sql/00_core.sql` — base schema (lifts/contacts/links/consents/messages/events/migrations).
- `sql/01_unique_msisdn.sql` — idempotent migration to enforce `contacts.primary_msisdn` **UNIQUE**.
- `scripts/migrate.js` — idempotent migration runner.
- `scripts/sanity.sh` — basic end-to-end smokes.

**WhatsApp Bridge**
- Base: `https://wa.woosh.ai`
- Template: `growthpoint_testv1` (lang: `en`)
- Headers: `Authorization: Bearer <BRIDGE_API_KEY>` and `X-Api-Key: <BRIDGE_API_KEY>`

**Cloud SQL (PostgreSQL 15)**
- Instance: `lifts-pg` (ZONAL, backups + PITR enabled)
- Database: `wooshlifts`
- App user: `app_user` (password stored in Secret Manager `DB_PASSWORD`)
- Connection: over **Unix socket** inside Cloud Run: `/cloudsql/<connectionName>`

---

## Environment & Secrets
**Environment variables (Cloud Run)**
- `ENV=prod`
- `APP_BUILD=<gitSha>-<timestamp>`
- `DB_SOCKET_DIR=/cloudsql`
- `DB_INSTANCE_CONNECTION_NAME=<project:region:instance>` (e.g. `woosh-lifts-20250924-072759:africa-south1:lifts-pg`)
- `DB_NAME=wooshlifts`
- `DB_USER=app_user`
- `DB_SSL=false` (using local Unix socket; no TLS over local domain socket)
- `BRIDGE_BASE_URL=https://wa.woosh.ai`
- `BRIDGE_TEMPLATE_NAME=growthpoint_testv1`
- `BRIDGE_TEMPLATE_LANG=en`

**Secrets (Secret Manager)**
- `BRIDGE_API_KEY:latest`
- `DB_PASSWORD:latest` — password for `app_user`

Grant `roles/secretmanager.secretAccessor` to the Cloud Run runtime SA:
`<projectNumber>-compute@developer.gserviceaccount.com`

Grant `roles/cloudsql.client` to the same SA to attach the Cloud SQL instance.

---

## Cloud SQL Setup (One-time)
> These are already done in prod; keep for reproducibility.

1) Create the instance:
```bash
gcloud sql instances create lifts-pg \
  --database-version=POSTGRES_15 \
  --region=africa-south1 \
  --cpu=1 --memory=3840MiB \
  --storage-size=20GB --availability-type=ZONAL \
  --backup --enable-point-in-time-recovery
```

2) Create the DB and app user:
```bash
gcloud sql databases create wooshlifts --instance=lifts-pg
gcloud sql users create app_user --instance=lifts-pg --password 'REDACTED_STRONG_PASSWORD'
echo -n 'REDACTED_STRONG_PASSWORD' | gcloud secrets create DB_PASSWORD --data-file=- --replication-policy=automatic \
  || echo -n 'REDACTED_STRONG_PASSWORD' | gcloud secrets versions add DB_PASSWORD --data-file=-
```

3) Open **Cloud SQL Studio** → connect as `app_user` to DB `wooshlifts` → run schema:
   - Paste `sql/00_core.sql`
   - Then run GRANTs:
```sql
GRANT CONNECT ON DATABASE wooshlifts TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app_user;
```

> **Important:** We enforce `contacts.primary_msisdn` uniqueness via:
> - table-level `UNIQUE` in `00_core.sql`
> - idempotent `sql/01_unique_msisdn.sql` migration (drops any old non-unique index and adds the constraint if missing).

---

## Build & Deploy
**Canary (preferred)**
```bash
REGION=africa-south1
PROJECT_ID=$(gcloud config get-value project)
SHA=$(git rev-parse --short HEAD); STAMP=$(date +%Y%m%d-%H%M%S)
IMAGE="africa-south1-docker.pkg.dev/${PROJECT_ID}/app/woosh-lifts:${SHA}-${STAMP}"

# Build
gcloud builds submit . --tag "${IMAGE}"

# Deploy canary (same image used later for prod)
INSTANCE=$(gcloud sql instances describe lifts-pg --format='value(connectionName)')
SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

gcloud run deploy woosh-lifts-canary \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --service-account "${SA}" \
  --add-cloudsql-instances "${INSTANCE}" \
  --set-env-vars ENV=prod,APP_BUILD="${SHA}-${STAMP}",DB_SOCKET_DIR=/cloudsql,DB_INSTANCE_CONNECTION_NAME="${INSTANCE}",DB_NAME=wooshlifts,DB_USER=app_user,DB_SSL=false,BRIDGE_BASE_URL=https://wa.woosh.ai,BRIDGE_TEMPLATE_NAME=growthpoint_testv1,BRIDGE_TEMPLATE_LANG=en \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,DB_PASSWORD=DB_PASSWORD:latest
```

**Promote canary image → prod**
```bash
REGION=africa-south1
IMAGE=$(gcloud run services describe woosh-lifts-canary --region $REGION \
  --format="value(spec.template.spec.containers[0].image)")
INSTANCE=$(gcloud sql instances describe lifts-pg --format='value(connectionName)')
PROJECT_ID=$(gcloud config get-value project)
SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

gcloud run deploy woosh-lifts \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --service-account "$SA" \
  --add-cloudsql-instances "$INSTANCE" \
  --set-env-vars ENV=prod,APP_BUILD="${IMAGE##*:}",DB_SOCKET_DIR=/cloudsql,DB_INSTANCE_CONNECTION_NAME="$INSTANCE",DB_NAME=wooshlifts,DB_USER=app_user,DB_SSL=false,BRIDGE_BASE_URL=https://wa.woosh.ai,BRIDGE_TEMPLATE_NAME=growthpoint_testv1,BRIDGE_TEMPLATE_LANG=en \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,DB_PASSWORD=DB_PASSWORD:latest
```

---

## Quick Smokes
**Status**
```bash
REGION=africa-south1
BASE=$(gcloud run services describe woosh-lifts --region $REGION --format='value(status.url)')
BASE_CANARY=$(gcloud run services describe woosh-lifts-canary --region $REGION --format='value(status.url)')
curl -sS "$BASE/admin/status" | jq
curl -sS "$BASE_CANARY/admin/status" | jq
```

**Template-first smoke (operator number)**
```bash
ID="tpl-$(date +%H%M%S)"
( set +o histexpand; curl -iS -X POST "$BASE/sms/direct" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"id\":\"$ID\",\"phoneNumber\":\"+27824537125\",\"incomingData\":\"Emergency Button\"}"; )
```

**Ingest smoke (provider A shape)**
```bash
curl -sS -X POST "$BASE/sms/plain" -H 'Content-Type: application/json' \
  --data '{"id":"smk-001","phoneNumber":"+27821110000","incomingData":"help","provider":"ops"}' | jq
```

**Admin seed (lift + contact + link)**
```bash
# Lift
curl -sS -X POST "$BASE/admin/lifts" -H 'Content-Type: application/json' \
  --data '{"msisdn":"27821110000","site_name":"Tower A","building":"Block 3"}' | jq

# Contact
CID=$(curl -sS -X POST "$BASE/admin/contacts" -H 'Content-Type: application/json' \
  --data '{"display_name":"Security Desk","primary_msisdn":"27825550000","role":"security"}' | jq -r .data.id)

# Link
LID=$(curl -sS "$BASE/admin/resolve/lift?msisdn=27821110000" | jq -r .data.lift.id)
curl -sS -X POST "$BASE/admin/lifts/$LID/contacts" -H 'Content-Type: application/json' \
  --data "{\"contact_id\":\"$CID\",\"relation\":\"security\"}" | jq
```

**Tail important logs**
```bash
gcloud logging tail \
  'resource.type=cloud_run_revision AND resource.labels.service_name="woosh-lifts" AND (jsonPayload.event="sms_received" OR jsonPayload.event="wa_template_ok" OR jsonPayload.event="wa_template_fail")' \
  --format='value(jsonPayload.ts,jsonPayload.event,jsonPayload.sms_id,jsonPayload.to,jsonPayload.status,jsonPayload.body)'
```

---

## Admin API (current)
All return `{ ok: boolean, data?: any, error?: { code, message } }`

**Status**
- `GET /admin/status` → `{ bridge, secrets, env, build, templateEnabled, templateName, templateLang, db, counts }`

**Lifts**
- `POST /admin/lifts` — upsert by `msisdn` (body: `{ msisdn, site_name?, building?, notes? }`)
- `GET /admin/lifts/:id` — lift details
- `GET /admin/resolve/lift?msisdn=2782…` — resolve (auto-create if missing), returns `{ lift, contacts, created }`
- `GET /admin/lifts/:id/contacts` — list contacts linked to lift
- `POST /admin/lifts/:id/contacts` — link contact (body: `{ contact_id, relation? }`)
- `DELETE /admin/lifts/:id/contacts/:contactId` — unlink

**Contacts**
- `POST /admin/contacts` — upsert by `primary_msisdn` (requires msisdn or email)
- `POST /admin/contacts/:id/consent` — set consent (body: `{ channel: 'sms'|'wa', status: 'opt_in'|'opt_out', source? }`)

**Messages (pagination)**
- `GET /admin/messages?lift_id=<uuid>&limit=50&cursor=<opaque>` → `{ items, next_cursor, has_more }`

**SMS**
- `POST /sms/direct` — operator smoke; template-first to a test number
- `POST /sms/plain` — provider webhook (supports A/B shapes, records inbound)

---

## Schema Notes
Base entities:
- `lifts(id, msisdn UNIQUE, site_name, building, notes, created_at)`
- `contacts(id, display_name, primary_msisdn UNIQUE, email, role, created_at, updated_at)`
- `lift_contacts(lift_id, contact_id, relation DEFAULT 'tenant', created_at, PRIMARY KEY(lift_id, contact_id))`
- `consents(contact_id, channel ENUM('sms','wa'), status ENUM('opt_in','opt_out'), source, ts, PRIMARY KEY(contact_id, channel))`
- `messages(id, channel, provider_id, direction 'in'|'out', from_msisdn, to_msisdn, body, meta JSONB, ts)`
- `events(id, contact_id?, lift_id?, type, payload JSONB, ts)`
- `schema_migrations(version, applied_at)`

**Important fix:** Upserts on `/admin/contacts` depend on `ON CONFLICT (primary_msisdn)`.  
We enforce this constraint via:
- `primary_msisdn text UNIQUE` in `00_core.sql`
- `sql/01_unique_msisdn.sql` migration (idempotent) to cover older DBs.

---

## Secrets & Password Rotation
To rotate DB password:
```bash
gcloud sql users set-password app_user --instance=lifts-pg --password 'NEW_STRONG_PASSWORD'
echo -n 'NEW_STRONG_PASSWORD' | gcloud secrets versions add DB_PASSWORD --data-file=-

# Redeploy the same image so Cloud Run picks up DB_PASSWORD:latest
REGION=africa-south1
IMAGE=$(gcloud run services describe woosh-lifts-canary --region $REGION --format="value(spec.template.spec.containers[0].image)")
INSTANCE=$(gcloud sql instances describe lifts-pg --format='value(connectionName)')
SA="$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

gcloud run deploy woosh-lifts-canary \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --service-account "$SA" \
  --add-cloudsql-instances "$INSTANCE" \
  --set-env-vars ENV=prod,APP_BUILD="${IMAGE##*:}",DB_SOCKET_DIR=/cloudsql,DB_INSTANCE_CONNECTION_NAME="$INSTANCE",DB_NAME=wooshlifts,DB_USER=app_user,DB_SSL=false,BRIDGE_BASE_URL=https://wa.woosh.ai,BRIDGE_TEMPLATE_NAME=growthpoint_testv1,BRIDGE_TEMPLATE_LANG=en \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,DB_PASSWORD=DB_PASSWORD:latest
```

---

## Rollback
**Cloud Run (service)**
```bash
REGION=africa-south1
PREV=$(gcloud run revisions list --service woosh-lifts --region $REGION --format='value(name)' | sed -n '2p')
gcloud run services update-traffic woosh-lifts --region $REGION --to-revisions "${PREV}=100"
```

**Database**
- Code migrations are additive/idempotent.
- For catastrophic DB issues, use Cloud SQL **Point-in-Time Recovery** (PITR).

---

## Troubleshooting Playbook
**/admin/status shows `db:false`**
1. Confirm Cloud Run has the Cloud SQL binding:
   ```bash
   gcloud run services describe woosh-lifts --region africa-south1 \
     --format="value(spec.template.metadata.annotations['run.googleapis.com/cloudsql-instances'])"
   ```
2. Confirm env/secret present:
   ```bash
   gcloud run services describe woosh-lifts --region africa-south1 \
     --format="table(spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].value,spec.template.spec.containers[0].env[].valueFrom.secretKeyRef.name)"
   ```
3. Ensure `DB_PASSWORD` secret exists and service account has `secretAccessor`.  
4. If schema missing, open Cloud SQL Studio → run `sql/00_core.sql` + GRANTs.  
5. Redeploy the **same** image to force secret reload.

**`/admin/contacts` returns 503 with `42P10` in logs**
- Root cause: `ON CONFLICT (primary_msisdn)` requires a UNIQUE or EXCLUSION constraint.  
- Fix: ensure `primary_msisdn` is UNIQUE (now enforced by `00_core.sql` + `01_unique_msisdn.sql`).

**Read logs**
```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name="woosh-lifts"' \
  --freshness=30m --limit=100 --format='value(timestamp,severity,textPayload,jsonPayload)'
```

---

## Observability & Alerts (suggested)
- **Log-based metric**: count of `jsonPayload.event="wa_template_fail"`  
  Alert if > N in 10 minutes.
- **Latency/error SLO**: 5xx rate and p95 latency on `woosh-lifts`/`woosh-lifts-canary`.
- **DB availability**: track `/admin/status` `db` flip in dashboards.

---

## Provider Webhook (prod)
Point provider to:
```
https://woosh-lifts-737216569971.africa-south1.run.app/sms/plain
```

**Accepted payloads**
- Shape A:
```json
{ "id":"...", "phoneNumber":"+2782…", "incomingData":"text", "provider":"ops" }
```
- Shape B:
```json
{ "from":"+2782…", "text":"...", "id":"..." }
```

---

## Minimal Admin UI (next step)
Scope: ultra-simple CRUD over the existing admin endpoints.
1) **Lifts list / search by msisdn** (create if missing)
2) **Lift detail** with contacts (add/remove links)
3) **Contact add dialog** (`display_name`, `primary_msisdn`, `email?`, `role`)

Front-end can be a small React/Tailwind bundle served under `/admin/ui` or a separate `woosh-lifts-admin` Cloud Run service. CORS and preflight are already enabled on `/admin/*`.

---

## Appendix — WhatsApp Template Payload Shape (kept stable)
```json
{
  "to": "27824537125",
  "type": "template",
  "template": {
    "name": "growthpoint_testv1",
    "language": { "code": "en" },
    "components": [
      {
        "type": "body",
        "parameters": [ { "type": "text", "text": "Emergency Button" } ]
      }
    ]
  }
}
```

Headers (bridge):
```
Authorization: Bearer <BRIDGE_API_KEY>
X-Api-Key: <BRIDGE_API_KEY>
```

---

## Audit & Proven Build
**Verified live as of:** 2025-09-27  
**Build in prod:** `2e6d5f8-20250927-145549`  
**Status:** `/admin/status → db:true`, lifts: 1, contacts: 1