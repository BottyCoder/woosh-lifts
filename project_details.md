# projectDetails.md — Lift Intercom SMS → WhatsApp (Woosh Ai)

> Handover pack to resume this project from a fresh chat/instance.
> **Do not paste raw secrets into chats or docs.** This file references where secrets live and how to retrieve them securely.

---

## 0) Snapshot
- **Org:** botforce.co.za (Org ID: 455441826862)
- **Billing:** `Woosh Hosting` (ID: 011821-AB4261-BF7834)
- **Project (active):** `woosh-lifts-20250924-072759`  
  Region: **africa-south1** (Johannesburg)
- **Runtime:** Google Cloud Run (public, unauthenticated allowed)
- **Service:** `woosh-lifts`  
  URL (latest): _use command below to fetch_
  ```bash
  gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)'
  ```
- **Container Registry:** Artifact Registry repo `app` (Docker) in `africa-south1`  
  Image: `africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/app/woosh-lifts:v1`
- **Source Repo:** GitHub → `https://github.com/BottyCoder/growthpoint` (seeded; add app code as needed)
- **Provider:** SMSPortal (SA shortcode inbound) → webhook (`/sms/inbound`) → WhatsApp bridge (woosh‑wa)

---

## 1) Architecture (current POC)
1. **Lift Intercom + SIM** → sends **SMS** to **SMSPortal Shortcode** (ZA).
2. **SMSPortal Webhook** POST → Cloud Run service `woosh-lifts` endpoint **`/sms/inbound`**.
3. **Webhook** verifies HMAC signature; **fast‑acks 200**; logs structured event.
4. **Forwarder (planned)** → Woosh WhatsApp bridge (woosh‑wa) to broadcast alert with quick‑reply buttons.
5. **First-responder logic (phase‑1)** handled by Woosh bridge; single closure → notify all.

_Operational note:_ Phase‑1 maps by **MSISDN→lift**. Message body parsing is deferred to Phase‑2.

---

## 2) Deployed code (minimal webhook)
- Runtime: **Node.js 20 on Alpine**
- Key endpoints:
  - `GET /` → health: `woosh-lifts: ok`
  - `POST /sms/inbound` → accepts JSON payload; validates HMAC from `X-Signature` header using `SMSPORTAL_HMAC_SECRET`; logs request; replies `{"status":"ok"}`.
- Logging: `morgan('tiny')` + structured `console.log` for inbound events.

_Rebuild & redeploy_
```bash
export REGION="africa-south1"; export PROJECT_ID=$(gcloud config get-value core/project)
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/app/woosh-lifts:v1"
gcloud builds submit --tag "$IMAGE_URI"
gcloud run deploy woosh-lifts \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest,BRIDGE_ADMIN_TOKEN=BRIDGE_ADMIN_TOKEN:latest,CSV_ADMIN_TOKEN=CSV_ADMIN_TOKEN:latest,SMSPORTAL_HMAC_SECRET=SMSPORTAL_HMAC_SECRET:latest,SMSPORTAL_CLIENT_ID=SMSPORTAL_CLIENT_ID:latest,SMSPORTAL_API_SECRET=SMSPORTAL_API_SECRET:latest"
```

_Test the webhook locally against the deployed URL_
```bash
BODY='{"id":"sp_12345","to":"39999","from":"+27820000000","message":"TEST: L01","shortcode":"39999","received_at":"2025-09-24T12:00:00Z"}'
SECRET=$(gcloud secrets versions access latest --secret=SMSPORTAL_HMAC_SECRET)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
URL=$(gcloud run services describe woosh-lifts --region africa-south1 --format='value(status.url)')
curl -fsS -X POST "$URL/sms/inbound" \
  -H "Content-Type: application/json" \
  -H "x-provider: smsportal" \
  -H "x-signature: $SIG" \
  -H "x-request-id: sp_test_valid_004" \
  -d "$BODY"
```

_Read last logs_
```bash
gcloud run services logs read woosh-lifts --region=africa-south1 --limit=100
```

---

## 3) Secrets & environment
All secrets live in **Secret Manager** in project `woosh-lifts-20250924-072759`.

| Purpose | Secret Name | Notes |
|---|---|---|
| SMSPortal HMAC for inbound webhook | `SMSPORTAL_HMAC_SECRET` | Used to validate `X-Signature` on `/sms/inbound` |
| SMSPortal REST client id | `SMSPORTAL_CLIENT_ID` | For outbound/REST use (future) |
| SMSPortal REST secret | `SMSPORTAL_API_SECRET` | For outbound/REST use (future) |
| Bridge admin token | `BRIDGE_ADMIN_TOKEN` | Woosh WA bridge (outbound auth) |
| Bridge API key | `BRIDGE_API_KEY` | Woosh WA bridge |
| CSV admin token | `CSV_ADMIN_TOKEN` | Admin mini‑UI (planned) |

> **Security:** Do **not** store or publish raw secret values in docs or chats. Retrieve as needed:
> ```bash
> gcloud secrets versions access latest --secret=SECRET_NAME
> ```
> Rotate a secret and redeploy:
> ```bash
> printf 'new-value' | gcloud secrets versions add SECRET_NAME --data-file=-
> gcloud run deploy woosh-lifts --image "$IMAGE_URI" --region africa-south1 \
>   --set-secrets "...SECRET_NAME=SECRET_NAME:latest..."
> ```

_Current values_ are present in Secret Manager; earlier chat logs showed test signatures; production tokens **must remain redacted**.

---

## 4) SMSPortal setup
- API docs: https://docs.smsportal.com/docs/quickstart and **Webhooks**: https://docs.smsportal.com/docs/webhooks
- In SMSPortal dashboard: **Create API Key → REST** (used for outbound). Keep Client ID & Secret in Secret Manager.
- Shortcode provisioning in progress (DTS). When active:
  - Configure **Inbound Webhook URL** to `https://<service-url>/sms/inbound`
  - Configure **HMAC/Signature secret** = value of `SMSPORTAL_HMAC_SECRET` (or provider’s shared secret field). If SMSPortal auto‑signs with its own secret, capture that and set `SMSPORTAL_HMAC_SECRET` to match.

---

## 5) WhatsApp bridge (woosh‑wa)
- Outbound channel: **Woosh WA bridge**; base URL via env `BRIDGE_BASE_URL=https://wa.woosh.ai`.
- Auth: `BRIDGE_API_KEY`, `BRIDGE_ADMIN_TOKEN` (Secret Manager).
- Planned endpoint contract: send templated message with quick‑reply buttons to **3–5 recipients** per lift; first response closes incident.

---

## 6) Data model & CSV
- **Registry (phase‑1):** `msisdn → {building, lift_id, recipients[]}` via CSV upload.
- CSV template:
  ```csv
  building,building_code,lift_id,msisdn,recipient_1,recipient_2,recipient_3,recipient_4,recipient_5,region
  The Place,PLACE,L01,2782xxxxxxx,2782aaaaaaa,2782bbbbbbb,2782ccccccc,2782ddddddd,2782eeeeeee,GP-North
  ```
- Evidence logs: raw JSON payload, body SHA‑256, UTC & SAST timestamps.

---

## 7) Liability & boundaries (POC)
- See canonical section in the separate plan doc; summary:
  - Woosh Ai not liable for carrier/provider outages, device conditions, power/connectivity issues, upstream API changes, or client data errors.
  - System is an operational alerting tool, **not** a certified life‑safety system.

---

## 8) Audit trail (key events)
- **Repo** created: `BottyCoder/growthpoint` with README & .gitignore.
- **Cloud project** created and linked to billing; services enabled: Run, Artifact Registry, Cloud Build, Secret Manager.
- **Repo `app`** created in Artifact Registry; first image built & pushed (`v1`).
- **Cloud Run service** `woosh-lifts` deployed; public access allowed; region `africa-south1`.
- **Secrets** added: `BRIDGE_*`, `CSV_ADMIN_TOKEN`, `SMSPORTAL_*`.
- **Webhook** implemented and tested; HMAC validation confirmed with computed signature.

---

## 9) How to resume quickly
1. Open Cloud Shell and set project:
   ```bash
   gcloud config set project woosh-lifts-20250924-072759
   ```
2. Pull latest code to Cloud Shell or trigger Cloud Build as above.
3. Verify secrets exist:
   ```bash
   gcloud secrets list | grep -E 'SMSPORTAL|BRIDGE|CSV'
   ```
4. Confirm service URL and run a signed test POST (snippets in §2).
5. When SMSPortal activates shortcode, set webhook to `/sms/inbound` and align the signature secret.

---

## 10) Open items / next steps
- [ ] Confirm SMSPortal **shortcode live** + final **HMAC/signature** mechanism.
- [ ] Implement **mapping registry** (CSV upload + validation) and minimal admin UI.
- [ ] Wire **forwarder** from webhook to Woosh WA bridge with retries & idempotency.
- [ ] Add **monitoring & alerts** (Cloud Monitoring uptime check, error ratio, latency).
- [ ] Template & deliver **WhatsApp alert** with quick replies; implement first‑responder closure.
- [ ] Prepare **evidence export** (CSV/PDF) for audits.

---

## 11) Contacts & ownership
- **Woosh Ai** — Project lead & engineering.  
- **DTS / SMSPortal** — Shortcode provisioning & webhook delivery.  
- **Client Ops** — CSV registry, recipient ownership, rollout schedule.

---

### Appendix — Commands (one‑shot re‑deploy)
```bash
gcloud config set project woosh-lifts-20250924-072759
export REGION="africa-south1"
export PROJECT_ID="$(gcloud config get-value core/project)"
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/app/woosh-lifts:v1"
gcloud builds submit --tag "$IMAGE_URI"
gcloud run deploy woosh-lifts \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --allow-unauthenticated \
  --concurrency 20 \
  --max-instances 5 \
  --set-env-vars BRIDGE_BASE_URL=https://wa.woosh.ai,ENV=prod \
  --set-secrets "BRIDGE_API_KEY=BRIDGE_API_KEY:latest,BRIDGE_ADMIN_TOKEN=BRIDGE_ADMIN_TOKEN:latest,CSV_ADMIN_TOKEN=CSV_ADMIN_TOKEN:latest,SMSPORTAL_HMAC_SECRET=SMSPORTAL_HMAC_SECRET:latest,SMSPORTAL_CLIENT_ID=SMSPORTAL_CLIENT_ID:latest,SMSPORTAL_API_SECRET=SMSPORTAL_API_SECRET:latest"
```

> If a brand‑new environment is needed: create project, link billing, enable APIs, create Artifact Registry, create secrets (names as above), then build & deploy with the same commands.

