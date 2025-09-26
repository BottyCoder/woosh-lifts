# Woosh Lifts — Project Details (Monolith, Template-First) — 2025-09-26

This document is the authoritative, current spec for the **single Cloud Run service** that turns **inbound SMS** into **WhatsApp messages** via the **Woosh WA Bridge**. It reflects everything we shipped today and what we're building next.

---

## 1) High-level architecture (monolith)

- **Service:** Cloud Run `woosh-lifts` (Gen2)
- **Role:** Receive **POST `/sms/plain`** from SMSPortal → **send WhatsApp** to the same MSISDN.
- **Mode:** **Template-first**, **text-fallback** (works for both cold and warm users).
- **No Pub/Sub** workers. No router/sender services. Keep it boring; keep it reliable.

### Endpoints
- `GET /` → `200 ok` (liveness)
- `GET /healthz` → `200 ok` (readiness)
- `POST /sms/plain` → accepts inbound SMS JSON; sends WA (template-first); returns `202`.
- `GET /api/inbound/latest` → last inbound snapshot (for demo/diagnostics).
- `POST /wa/webhook` → (reserved for future button flows; currently no-op or disabled).
- `GET /admin/status` → optional JSON status (env + template flags) if enabled.

---

## 2) WhatsApp sending behavior

**Template-first path**
1. If `BRIDGE_TEMPLATE_NAME` is set on the live revision, we try to send a **template**:
   - **Template name:** `growthpoint_testv1`
   - **Language:** `en` (must exactly match approved locale, e.g. `en` or `en_GB`)
   - **Body variables:** exactly one `{{1}}` which we populate with the inbound SMS text.
2. If the template call fails (bad name/lang/params or policy), we **fallback** to a **plain text** send:
   ```
   SMS received: "<inbound text>"
   ```

**Destination logic**
- We **send to the same MSISDN** that sent the SMS (no contact remapping yet).
- Input must be **E.164** with `+` (we normalize and strip `+` for the bridge).

---

## 3) Contracts

### 3.1 Inbound SMS (accepted shapes)
We accept either SMSPortal's legacy flat body **or** the normalized form:
```json
// A) SMSPortal legacy
{
  "id": 3019843,
  "phoneNumber": "27000000001",
  "incomingData": "This is an SMS...",
  "mcc": 655,
  "mnc": "01",
  "sc": "40001",
  "keyword": "someone",
  "incomingUtc": 1735711200
}
```
```json
// B) Normalized (what we publish internally and echo in /api/inbound/latest)
{
  "sms_id": "3019843",
  "from": "+27824537125",
  "text": "This is an SMS...",
  "received_at": "2025-09-26T12:08:22.895Z"
}
```
Minimal required fields are: **`id`**, **`phoneNumber`**, and **`incomingData`** (string or `{ text: "..." }`).

### 3.2 WhatsApp bridge (outbound)
- **Base:** `BRIDGE_BASE_URL` (prod = `https://wa.woosh.ai`)
- **Auth:** `X-Api-Key: $BRIDGE_API_KEY`
- **Text send body:** `{ "to": "2782…", "text": "..." }`
- **Template send body:**
```json
{
  "to": "2782……",
  "template": {
    "name": "growthpoint_testv1",
    "language": "en",
    "components": [
      { "type": "body", "parameters": [ { "type": "text", "text": "<SMS text>" } ] }
    ]
  }
}
```

---

## 4) Configuration & secrets

### Plain env (config, not secrets)
- `ENV=prod`
- `BRIDGE_BASE_URL=https://wa.woosh.ai`
- `BRIDGE_TEMPLATE_NAME=growthpoint_testv1`
- `BRIDGE_TEMPLATE_LANG=en`

### Secret Manager (required)
- `BRIDGE_API_KEY:latest` — bridge auth key
- `SMSPORTAL_HMAC_SECRET:latest` — reserved for future signature verification (optional today)

> **Why env for template settings?** They're not secrets; keeping them as env vars simplifies ops. We can move to secrets later if policy requires.

---

## 5) Logging & observability

Structured JSON logs (single-line):
- `sms_received { sms_id, from, text_len }`
- `wa_template_ok { to, provider_id, templateName, lang, sms_id, text_len }`
- `wa_template_fail { to, status, body, templateName, lang, sms_id }`
- `wa_send_ok { to, provider_id, sms_id, text_len }`
- `wa_send_fail { to, status, body, sms_id }`

Useful queries:
```bash
gcloud logging read \
'resource.type="cloud_run_revision" AND resource.labels.service_name="woosh-lifts"
 AND (textPayload:"wa_template_ok" OR textPayload:"wa_template_fail" OR textPayload:"wa_send_ok" OR textPayload:"wa_send_fail")' \
--limit=20 --format='value(textPayload)'
```
```bash
gcloud logging read \
'resource.type="cloud_run_revision" AND resource.labels.service_name="woosh-lifts"
 AND httpRequest.requestUrl:"/sms/plain"' \
--limit=20 \
--format='value(httpRequest.status, httpRequest.requestMethod, httpRequest.requestUrl, receiveTimestamp)'
```

---

## 6) Deploy & smoke (immutability-safe)

**Pull/build/deploy**
```bash
cd ~/woosh-lifts
git fetch origin
git checkout main
git pull --ff-only origin main

export REGION="africa-south1"
export PROJECT_ID=$(gcloud config get-value core/project)
export IMAGE_TAG="$(git rev-parse --short HEAD)-monolith-$(date +%Y%m%d-%H%M%S)"
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/woosh-lifts:${IMAGE_TAG}"

gcloud builds submit . --tag "$IMAGE_URI"

gcloud run deploy woosh-lifts \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars ENV=prod,BRIDGE_BASE_URL=https://wa.woosh.ai,BRIDGE_TEMPLATE_NAME=growthpoint_testv1,BRIDGE_TEMPLATE_LANG=en \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,SMSPORTAL_HMAC_SECRET=SMSPORTAL_HMAC_SECRET:latest
```

**Smokes**
```bash
# Get URL
BASE=$(gcloud run services describe woosh-lifts --region "$REGION" --format='value(status.url)')

# Liveness
curl -iS "$BASE/"
curl -iS "$BASE/healthz"

# E2E (use a real WA-enabled number)
curl -iS -X POST "$BASE/sms/plain" -H "Content-Type: application/json" \
  --data-raw '{"id":"demo-tpl-101","phoneNumber":"+27824537125","incomingData":"Template path test - hello!"}'

# Confirm path taken
gcloud logging read \
'resource.type="cloud_run_revision" AND resource.labels.service_name="woosh-lifts"
 AND (textPayload:"wa_template_ok" OR textPayload:"wa_template_fail" OR textPayload:"wa_send_ok" OR textPayload:"wa_send_fail")' \
--limit=20 --format='value(textPayload)'

# Last inbound snapshot
curl -s "$BASE/api/inbound/latest"
```

---

## 7) Error handling & common pitfalls

- **400 `bad_msisdn`** → input wasn't valid E.164 (`+` and digits only). Replace dummy like `+27XXXXXXXXX` with a real number.
- **No `wa_template_*` logs** → template env not set on the live revision, or deployed image lacks template code; redeploy with envs.
- **Template fails but text arrives** → expected; fallback working (fix name/locale later).
- **No WA on dummy numbers** → WhatsApp must be active on the destination MSISDN.

---

## 8) Security & ops notes

- **Auth for webhook**: header with shared secret is ready to add; currently open for speed. When you want it, we'll enforce `X-SMS-Signature`.
- **Idempotency**: we can cache recent `sms_id` for 24h (in-mem or Firestore) to drop dupes; currently not enforced (kept simple).
- **Rate limits**: bridge retries/backoff are handled inside; upstream rate limiting can be added later if traffic ramps.
- **Rollback**:
  ```bash
  gcloud run services describe woosh-lifts --region "$REGION" \
    --format='value(status.traffic[].revisionName,status.traffic[].percent)'
  gcloud run services update-traffic woosh-lifts --region "$REGION" --to-revisions <REV>=100
  ```

---

## 9) What's working now

- `/sms/plain` → **WhatsApp** delivery (template for cold users; text for warm/fallback).
- `/api/inbound/latest` → shows last SMS snapshot.
- Structured logs for **sms_received**, **wa_template_ok/fail**, **wa_send_ok/fail**.
- Clean immutable deploys with one-liner smokes.

---

## 10) Next up (small, safe enhancements)

1) **Webhook auth**: require `X-SMS-Signature` or a pre-shared header; reject if missing/invalid.
2) **Idempotency**: 24h duplicate guard by `sms_id` (in-mem LRU or Firestore TTL).
3) **Admin status**: `/admin/status` (env + build SHA) for client demos.
4) **Routing rules (optional)**: map certain short codes/keywords → different WA recipients.
5) **Button flow (later)**: re-enable `/wa/webhook` to confirm actions via buttons once the demo stabilizes.

---

**Owner:** Marc @ Woosh  
**Environment:** `africa-south1` / Project `woosh-lifts-20250924-072759`  
**Bridge:** `https://wa.woosh.ai` (via `BRIDGE_API_KEY`)