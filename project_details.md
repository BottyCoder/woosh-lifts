## woosh-lifts — Project Details (locked & boringly stable)

Last updated: **2025-09-27**  
Region: **africa-south1**  
GCP Project: **woosh-lifts-20250924-072759**

---

### 1) Purpose & Current Behavior
- Accept inbound SMS from short code **43922** (provider posts to `/sms/plain`).
- Normalize payloads (legacy + provider shapes).
- **Template-first** send via **Woosh Bridge** (WhatsApp template), with safe **fallback** to WhatsApp text when template fails.
- A direct test hook `/sms/direct` sends the template with a known param ("Emergency Button") to prove plumbing end-to-end.

**Template in use**
- Name: `growthpoint_testv1`
- Language: **`en`** (always)
- Body variables: **1** (`{{1}}`) → our param is **"Emergency Button"** by default.

---

### 2) Codebase & Entrypoints
- Runtime: **Node 20 (alpine)**
- Primary app: `src/server.js`
- Root shim: `server.js` (exports app; harmless if run)
- **Dockerfile**: `CMD ["node","src/server.js"]` (directly boots the real server)

---

### 3) Routes (public)
#### `GET /admin/status`
Returns non-secret status for quick checks:
```json
{
  "bridge": true,
  "secrets": true,
  "env": "prod",
  "build": "<gitsha>-<timestamp>",
  "templateEnabled": true,
  "templateName": "growthpoint_testv1",
  "templateLang": "en",
  "templateParam": "Emergency Button",
  "timestamp": "..."
}
```

#### `POST /sms/plain`  *(provider webhooks)*
- Accepts **multiple shapes** and normalizes to:
  - `smsId` (string), `toDigits` (E.164 digits, **no +**), `incoming` (≤1024 chars)
  - Pass-through metadata: `mcc`, `mnc`, `sc/shortcode`, `keyword`, `incomingUtc`, etc.
- **Template-first via Bridge**, then **fallback** to WA text if template fails.
- Structured logs:
  - `sms_received`
  - `wa_template_ok` / `wa_template_fail`
  - `wa_send_ok` / `wa_send_fail` (fallback)

#### `POST /sms/direct`  *(operator smoke hook)*
- Ignores the SMS body and **always** sends the WhatsApp **template** with `{{1}} = "Emergency Button"`.
- Uses the exact Bridge payload shape (see §5).
- Same logs as above.

#### `GET /healthz`
- Liveness probe.

---

### 4) Payload Normalization (both `/sms/plain` & `/sms/inbound` if present)
**Accepted shapes**
- Legacy: `{"id","phone","text"}`
- Provider: `{"id","phoneNumber","incomingData","mcc","mnc","sc","keyword","incomingUtc"}`
- Also tolerated: `msisdn`, `to`, `from`, `message`, `body`, `IncomingData`, …

**Normalized**
- `smsId`: first non-empty from `id|Id|messageId|reqId|gen-<ts>`
- `toDigits`: digits‐only E.164 (strip symbols), max 20
- `incoming`: string, trimmed, max 1024 chars
- metadata pass-through preserved

---

### 5) Bridge Integration (WhatsApp)
**Endpoint:** `${BRIDGE_BASE_URL}/v1/send`  
**Auth headers:**  
```
Authorization: Bearer <BRIDGE_API_KEY>
X-Api-Key: <BRIDGE_API_KEY>
Content-Type: application/json
```

**Template send payload (exact)**
```json
{
  "to": "<digits only e.g. 27824537125>",
  "type": "template",
  "template": {
    "name": "growthpoint_testv1",
    "language": { "code": "en" },
    "components": [
      { "type": "body", "parameters": [ { "type": "text", "text": "Emergency Button" } ] }
    ]
  }
}
```

**Fallback WA text payload**
```json
{ "to": "<digits>", "type": "text", "text": "SMS received: \"<incoming>\"" }
```

**Logging (JSON)**
- `wa_template_ok` { sms_id, to, templateName, lang, provider_id?, variant }
- `wa_template_fail` { sms_id, to, status, body, variant }
- `wa_send_ok` { sms_id, to, provider_id?, fallback: true }
- `wa_send_fail` { sms_id, to, status, body }

---

### 6) Environment & Secrets
**Env vars (Cloud Run)**
- `ENV=prod`
- `APP_BUILD` — set by deploy scripts: `<gitsha>-<timestamp>`
- `BRIDGE_BASE_URL=https://wa.woosh.ai`
- `BRIDGE_TEMPLATE_NAME=growthpoint_testv1`
- `BRIDGE_TEMPLATE_LANG=en`  ← **always `en`**
- `BRIDGE_TEMPLATE_PARAM="Emergency Button"` *(optional, defaults to "Emergency Button"; used by `/sms/direct`)*

**Secrets**
- `BRIDGE_API_KEY` from Secret Manager (version: `latest`)

---

### 7) Build & Deploy
#### Daily (prod) — single command
```bash
gcloud config set project woosh-lifts-20250924-072759
cd ~/woosh-lifts && git pull --rebase origin main
bash --noprofile --norc ./daily.sh
```
**What it does**
1) Stash untracked, fast-forward to `origin/main`  
2) Build image: `africa-south1-docker.pkg.dev/<project>/app/woosh-lifts:<gitsha>-<timestamp>`  
3) Deploy to **woosh-lifts** with env+secret  
4) Route **100% traffic to latest** (with retries)  
5) Smoke:
   - `/sms/direct` (known-good template path)
   - `/sms/plain` (provider shape, uses template-first)  
6) Print decisive logs for request ids

#### Canary → Promote (safe by default)
File: `daily_canary.sh`  
Run:
```bash
gcloud config set project woosh-lifts-20250924-072759
cd ~/woosh-lifts && git pull --rebase origin main
bash --noprofile --norc ./daily_canary.sh
```
**Flow**
1) Build once  
2) Deploy to **woosh-lifts-canary** (separate service)  
3) Smoke `/sms/direct` on canary  
4) **Wait for `wa_template_ok`** in logs (retry + `--freshness`)  
5) **Only if OK** → deploy the **same image** to prod and route 100% traffic to latest  
6) Print status + logs

**Rollback (pin to known good)**
```bash
REGION=africa-south1
GOOD=$(gcloud run revisions list --service woosh-lifts --region "$REGION" --format='value(name)' | head -n 1)
gcloud run services update-traffic woosh-lifts --region "$REGION" --to-revisions "${GOOD}=100"
```

---

### 8) Provider Webhook (production)
Point inbound to:
```
https://woosh-lifts-737216569971.africa-south1.run.app/sms/plain
```
*(The daily/canary scripts always print the current service URL.)*

---

### 9) Operator Smokes (handy one-liners)
**Status**
```bash
+BASE=$(gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)')
curl -sS "$BASE/admin/status" | jq
```

**Direct template (to +27824537125)**
```bash
ID=tpl-$(date +%H%M%S)
( set +o histexpand; curl -iS -X POST "$BASE/sms/direct" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"id\":\"$ID\",\"phoneNumber\":\"+27824537125\",\"incomingData\":\"ignored\"}"; )
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=woosh-lifts AND (jsonPayload.sms_id=\"$ID\" OR textPayload:\"$ID\")" \
  --freshness=10m --limit=50 --format='value(jsonPayload,textPayload)'
```

**Provider-shape smoke against `/sms/plain`**
```bash
ID=smk-$(date +%H%M%S)
( set +o histexpand; curl -iS -X POST "$BASE/sms/plain" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"id\":\"$ID\",\"phoneNumber\":\"+27824537125\",\"incomingData\":\"Emergency Button\"}"; )
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=woosh-lifts AND (jsonPayload.sms_id=\"$ID\" OR textPayload:\"$ID\")" \
  --freshness=10m --limit=50 --format='value(jsonPayload,textPayload)'
```

---

### 10) Troubleshooting Cheatsheet
1) **Service URL**
```bash
gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)'
```
2) **Latest revision + image + env**
```bash
gcloud run services describe woosh-lifts --region africa-south1 \
  --format='value(status.latestReadyRevisionName,spec.template.spec.containers[0].image,spec.template.spec.containers[0].env)'
```
3) **Startup / recent event logs**
```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name="woosh-lifts"' \
  --freshness=10m --limit=50 --format='value(textPayload,jsonPayload)'
```
4) **Template failures (last 10m)**
```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name="woosh-lifts" AND jsonPayload.event="wa_template_fail"' \
  --freshness=10m --limit=50 --format='value(jsonPayload)'
```
5) **Secret sanity**
```bash
gcloud secrets versions access latest --secret=BRIDGE_API_KEY >/dev/null && echo "BRIDGE_API_KEY OK"
```

---

### 11) What's locked down (do not change casually)
- **Entrypoint**: Docker `CMD ["node","src/server.js"]`  
- **Template language**: **`en`** everywhere  
- **Bridge schema**: wrapped `type:"template"` with `template.language.code` and `template.components[].parameters[]`  
- **Auth headers**: **both** `Authorization: Bearer <key>` and `X-Api-Key: <key>`  
- **Daily/Canary flow**: use provided scripts; they set account/project/region, flip traffic safely, and smoke with log verification.

---

### 12) Changelog (recent)
- **Template-first plumbing (plain + direct)**  
- **Payload normalization** across providers  
- **Bridge schema fix** (`template.language.code`, `components[].parameters[]`)  
- **Auth header fix** (Bearer + X-Api-Key)  
- **Entrypoint fix** (boot `src/server.js`)  
- **/admin/status** enriched (build, lang, param)  
- **daily.sh** hardened (traffic flip + smokes + logs)  
- **daily_canary.sh** added (non-destructive build→prove→promote; log-lag tolerant)

---

### 13) Quick "Runbook" (human)
1) **Check status:** `/admin/status`  
2) **Direct template smoke:** `/sms/direct` to your number  
3) **If red:** read `wa_template_fail` body+status → fix env or payload  
4) **If deploy risk:** run **canary** script; only promote on `wa_template_ok`  
5) **Rollback:** update traffic to known good revision (see §7)