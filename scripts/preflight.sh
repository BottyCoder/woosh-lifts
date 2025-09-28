#!/usr/bin/env bash
set -euo pipefail

# Preflight checks for deployment sanity
# Fast-fail checks to prevent broken deploys

REGION="${REGION:-africa-south1}"
SVC="${SVC:-woosh-lifts}"
PROJECT_ID="$(gcloud config get-value core/project)"

say(){ printf "%s\n" "$*"; }
ok(){ echo "✅ $*"; }
bad(){ echo "❌ $*" >&2; exit 1; }

echo "🔍 Running preflight checks for $SVC in $REGION..."

# Check if service exists and get BASE
BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
[ -n "${BASE:-}" ] || bad "Cloud Run service not found"
say "BASE=$BASE"

# Cloud SQL connector attached?
ATTACH="$(gcloud run services describe "$SVC" --region "$REGION" \
  --format='value(spec.template.metadata.annotations."run.googleapis.com/cloudsql-instances")')"
[[ "$ATTACH" == *:*:* ]] || bad "Cloud SQL instance not attached to service"
ok "Cloud SQL attached: $ATTACH"

# DATABASE_URL or DB_* present?
ENVV="$(gcloud run services describe "$SVC" --region "$REGION" \
  --format='get(spec.template.spec.containers[0].env)')"
[[ "$ENVV" == *"DATABASE_URL"* || ( "$ENVV" == *"DB_USER"* && "$ENVV" == *"DB_PASSWORD"* ) ]] \
  || bad "DB env not wired (DATABASE_URL or DB_* missing)"
ok "DB env present"

# Secrets exist?
for sec in BRIDGE_API_KEY BRIDGE_ADMIN_TOKEN; do
  gcloud secrets describe "$sec" >/dev/null 2>&1 || bad "Secret missing: $sec"
done
ok "Bridge secrets present"

# DB secret check (either DATABASE_URL or DB_PASSWORD)
if [[ "$ENVV" == *"DATABASE_URL"* ]]; then
  gcloud secrets describe DATABASE_URL >/dev/null 2>&1 || bad "Secret missing: DATABASE_URL"
else
  gcloud secrets describe DB_PASSWORD >/dev/null 2>&1 || bad "Secret missing: DB_PASSWORD"
fi
ok "DB secret present"

# Roles on service account
SA="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(spec.template.spec.serviceAccountName)')"
if [ -z "$SA" ]; then
  PN="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  SA="${PN}-compute@developer.gserviceaccount.com"
fi
MEMS="$(gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --format='value(bindings.role,bindings.members)' --filter="bindings.members:serviceAccount:$SA")"
[[ "$MEMS" == *roles/cloudsql.client* ]] || bad "SA missing role: roles/cloudsql.client"
[[ "$MEMS" == *roles/secretmanager.secretAccessor* ]] || bad "SA missing role: roles/secretmanager.secretAccessor"
ok "Service account roles OK: $SA"

# Live status check
STATUS="$(curl -fsS "$BASE/admin/status" || true)"
echo "$STATUS" | jq -e '.ok==true' >/dev/null 2>&1 || bad '/admin/status not OK'
ok "Admin status reachable"
echo "$STATUS" | jq . >/dev/null 2>&1 && ok "Status JSON parse OK" || bad "Status not JSON"
say "$STATUS" | jq . >/dev/null 2>&1 && ok "Status JSON parse OK" || bad "Status not JSON"

ok "Preflight passed"
