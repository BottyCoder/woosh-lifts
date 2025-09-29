# Cloud Run "container didn't bind to PORT=8080" — Runbook

## Current Known-Good
- Service: **woosh-lifts** (region **africa-south1**)
- Live revision: **woosh-lifts-00006-cv2** (100% traffic)
- Health: `/admin/status` = OK (DB connected), `/` = OK, outbound bridge ping = ✅

---

## Symptoms
- Deploy failure: **HealthCheckContainerError** / "failed to start and listen on PORT=8080".
- Logs show migrations ran, then no "listening on 8080".

## Root Causes (this incident)
1) `server.js` required `./src/server` incorrectly (got module object, not `{ app }`) → crash before `listen`.
2) `src/lib/retryQueue.js` required **non-existent** `../clients/waBridge` → crash at import time.
3) Host binding not explicit (we now bind to `0.0.0.0`).

## Minimal Fixes Applied
- `server.js`  
  ```diff
  - const app = require('./src/server');
  + const { app } = require('./src/server');
  - app.listen(PORT, () => { ... })
  + app.listen(PORT, '0.0.0.0', () => { ... })
  ```

- `src/lib/retryQueue.js`
  ```diff
  - const { sendText } = require('../clients/waBridge');
  + const { sendText } = require('./bridge');
  ```

- `src/server.js` (defensive)
  Lazy-load retryQueue in a try/catch so optional modules can't crash boot.

## Safe Rollout Pattern
```bash
REGION="africa-south1"; SVC="woosh-lifts"
PROJECT_ID="$(gcloud config get-value project)"
TAG="safe-$(date +%Y%m%d-%H%M%S)"
IMAGE_URI="africa-south1-docker.pkg.dev/$PROJECT_ID/app/woosh-lifts:$TAG"

gcloud builds submit --tag "$IMAGE_URI"
gcloud run deploy "$SVC" --image "$IMAGE_URI" --region "$REGION" --no-traffic

NEWREV="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.latestCreatedRevisionName)')"
gcloud logging read \
 "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SVC\" AND resource.labels.revision_name=\"$NEWREV\"" \
 --limit=200 --format=json | jq -r '.[] | .textPayload // .jsonPayload.message // tostring'

# Flip only after you see a "listen" log:
gcloud run services update-traffic "$SVC" --region "$REGION" --to-latest
```

## Quick Health Smokes
```bash
BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')"
curl -iS "$BASE/"
curl -iS "$BASE/admin/status"
```

## Outbound Bridge Sanity
```bash
curl -iS -X POST "$BASE/admin/ping-bridge" -H "Content-Type: application/json" \
  --data-raw '{"to":"27824537125","text":"Bridge ping from Cloud Run ✅"}'
```

## Optional: HTTP Startup Probe (clearer signals)
```bash
gcloud run services describe "$SVC" --region "$REGION" --format=export > service.yaml
```

Under the container:
```yaml
startupProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 12
```

```bash
gcloud run services replace service.yaml --region "$REGION"
```

## Fast Rollback
```bash
gcloud run revisions list --region "$REGION" --service "$SVC" \
  --format='table(name,status.conditions[0].status,createTime)'
gcloud run services update-traffic "$SVC" --region "$REGION" --to-revisions <GOOD_REV>=100
```
