# GCP Shell Startup Commands - Woosh Lifts Project

This file contains the standard commands to run when starting a new GCP Cloud Shell session for the woosh-lifts project.

## Project Setup & Deployment

```bash
# Set the project
gcloud config set project woosh-lifts-20250924-072759

# Set environment variables
export REGION="africa-south1"
export PROJECT_ID="$(gcloud config get-value core/project)"
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/app/woosh-lifts:v1"

# Build and deploy the service
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

## Test the Webhook

```bash
# Create test payload
BODY='{"id":"sp_12345","to":"39999","from":"+27820000000","message":"TEST: L01","shortcode":"39999","received_at":"2025-09-24T12:00:00Z"}'

# Get HMAC secret and generate signature
SECRET="$(gcloud secrets versions access latest --secret=SMSPORTAL_HMAC_SECRET)"
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"

# Get service URL
URL="$(gcloud run services describe woosh-lifts --region "$REGION" --format='value(status.url)')"
echo "$URL"

# Test the webhook endpoint
curl -fsS -X POST "$URL/sms/inbound" \
  -H "Content-Type: application/json" \
  -H "x-provider: smsportal" \
  -H "x-signature: $SIG" \
  -H "x-request-id: sp_test_valid_004" \
  -d "$BODY"
```

## View Logs

```bash
# Read recent logs
gcloud run services logs read woosh-lifts --region="$REGION" --limit=50
```

## Quick Commands Reference

| Command | Purpose |
|---------|---------|
| `gcloud config set project woosh-lifts-20250924-072759` | Set active project |
| `gcloud builds submit --tag "$IMAGE_URI"` | Build new container image |
| `gcloud run deploy woosh-lifts --image "$IMAGE_URI" --region "$REGION"` | Deploy service |
| `gcloud run services describe woosh-lifts --region "$REGION" --format='value(status.url)'` | Get service URL |
| `gcloud run services logs read woosh-lifts --region="$REGION" --limit=50` | View logs |

## Environment Variables

- `REGION`: africa-south1
- `PROJECT_ID`: woosh-lifts-20250924-072759
- `IMAGE_URI`: africa-south1-docker.pkg.dev/woosh-lifts-20250924-072759/app/woosh-lifts:v1

## Secrets (stored in Secret Manager)

- `BRIDGE_API_KEY`: Woosh WA bridge API key
- `BRIDGE_ADMIN_TOKEN`: Woosh WA bridge admin token
- `CSV_ADMIN_TOKEN`: CSV admin UI token
- `SMSPORTAL_HMAC_SECRET`: SMSPortal webhook signature secret
- `SMSPORTAL_CLIENT_ID`: SMSPortal REST client ID
- `SMSPORTAL_API_SECRET`: SMSPortal REST API secret
