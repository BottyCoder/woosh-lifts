# Handoff — woosh-lifts (2025-09-28, Africa/Johannesburg)

## 0) TL;DR — where we ended tonight

**Inbound /sms/plain**: working; rows land in messages with sane defaults.

**DB hardened**: server-side defaults + triggers prevent NULL bombs (ts, provider, provider_id, next_attempt_at for outbounds).

**Migrations**: moved to Cloud Run Job db-migrate; logs show "All migrations completed successfully." Job sometimes doesn't exit promptly, but the DB work completes.

**Bridge (WhatsApp)**: healthy — direct POST to https://wa.woosh.ai/api/messages/send returns 200 and delivers.

**Worker**: was failing early (no bridge call, 400s recorded) due to row selection/payload path. Code patch was pushed via Cursor to only pick out + wa rows with valid to_msisdn and to call the bridge with {to,text} and X-Api-Key.

**Breaker**: currently open (paused) while we were stabilizing. We can close it once the new revision is deployed.

## 1) What broke (facts, not feelings)

Earlier, server expected application code to populate DB fields. In reality, inserts with missing fields caused NOT NULL errors (first on ts, then provider, then provider_id).

The worker retrier processed bad candidates (including inbound SMS rows and/outbound rows with missing to_msisdn) and never reached the bridge endpoint → 400s and "permanently_failed".

A Cloud Shell annoyance: startup profiles (Gemini banner) occasionally hijacked sessions; we now run shells without profiles.

## 2) What we changed (safe, server-side)

**Schema hardening (idempotent, already applied):**

```sql
-- Defaults
ALTER TABLE IF EXISTS messages
  ALTER COLUMN ts SET DEFAULT now(),
  ALTER COLUMN provider SET DEFAULT 'ops';

-- Consolidated guard on INSERT + UPDATE:
CREATE OR REPLACE FUNCTION set_messages_safe_defaults() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  ms BIGINT := FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000);
  rand9 TEXT := SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 9);
BEGIN
  IF NEW.ts IS NULL THEN NEW.ts := now(); END IF;
  IF NEW.provider IS NULL OR NEW.provider = '' THEN NEW.provider := 'ops'; END IF;
  IF NEW.provider_id IS NULL OR NEW.provider_id = '' THEN NEW.provider_id := 'text-' || ms::text || '-' || rand9; END IF;
  IF NEW.direction = 'out' AND NEW.next_attempt_at IS NULL THEN NEW.next_attempt_at := now(); END IF;
  RETURN NEW;
END;
$f$;

DROP TRIGGER IF EXISTS trg_messages_safe_defaults_ins ON messages;
DROP TRIGGER IF EXISTS trg_messages_safe_defaults_upd ON messages;
CREATE TRIGGER trg_messages_safe_defaults_ins BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION set_messages_safe_defaults();
CREATE TRIGGER trg_messages_safe_defaults_upd BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION set_messages_safe_defaults();
```

**Circuit breaker table:**

Ensured breaker_state exists and can be set closed/open on demand.

**Migrations:**

Created Cloud Run Job db-migrate that runs node scripts/migrate.js with Cloud SQL attached and correct env/secrets.

**Worker code (pushed):**

Only selects direction='out' AND channel='wa' AND to_msisdn IS NOT NULL (and status IS NULL OR 'queued').

Calls bridge POST /api/messages/send with headers and {to,text}.

Writes wa_id to meta on success; uses simple backoff on non-4xx; marks 4xx as permanently_failed.

No "processing" status used (your enum didn't have it).

## 3) How to start a clean, durable shell tomorrow

Use tmux and no profiles so nothing "helpful" loads.

```bash
tmux new -s wooshfix
# if disconnected: tmux attach -t wooshfix
```

Inside tmux, set headless env once:

```bash
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export BROWSER=/bin/true PAGER=cat LESS=FiRX
export PROJECT_ID="woosh-lifts-20250924-072759"
export REGION="africa-south1"
export SVC="woosh-lifts"
export INSTANCE="lifts-pg"
```

## 4) Pull latest code (Cursor is source of truth)

```bash
cd ~/woosh-lifts || { mkdir -p ~/woosh-lifts; cd ~/woosh-lifts; git clone https://github.com/BottyCoder/woosh-lifts.git .; }
git fetch origin
git checkout chore/unique-msisdn
git pull --rebase origin chore/unique-msisdn || git reset --hard origin/chore/unique-msisdn
```

## 5) Build + Deploy (manual, script-free, known-good)

**Build:**

```bash
TAG="$(git -C ~/woosh-lifts rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M%S)"
IMAGE="africa-south1-docker.pkg.dev/$PROJECT_ID/app/$SVC:$TAG"
gcloud builds submit ~/woosh-lifts --tag "$IMAGE"
echo "IMAGE=$IMAGE"
```

**Deploy service (correct Cloud SQL flag + env):**

```bash
INSTANCE_CONN="$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud run deploy "$SVC" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --service-account "$RUN_SA" \
  --add-cloudsql-instances "$INSTANCE_CONN" \
  --set-env-vars ENV=prod,DB_SOCKET_DIR=/cloudsql,DB_INSTANCE_CONNECTION_NAME="$INSTANCE_CONN",DB_NAME=wooshlifts,DB_USER=app_user,DB_SSL=false,BRIDGE_BASE_URL=https://wa.woosh.ai \
  --set-secrets BRIDGE_API_KEY=BRIDGE_API_KEY:latest,DB_PASSWORD=DB_PASSWORD:latest \
  --startup-timeout=300s --max-instances=5 --concurrency=20
```

**Confirm Ready + promote traffic:**

```bash
REV="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.latestCreatedRevisionName)')"; echo "REV=$REV"
for i in $(seq 1 60); do
  READY="$(gcloud beta run revisions describe "$REV" --region "$REGION" --format='value(status.conditions[?type=Ready].status)')"
  REASON="$(gcloud beta run revisions describe "$REV" --region "$REGION" --format='value(status.conditions[?type=Ready].reason)')"
  echo "Ready=$READY Reason=${REASON:-<none>} try=$i"
  [ "$READY" = "True" ] && break || sleep 3
done
[ "$READY" = "True" ] && gcloud run services update-traffic "$SVC" --region "$REGION" --to-revisions "$REV=100"
```

## 6) Migrations (Cloud Run Job — not local)

**Run (idempotent):**

```bash
gcloud run jobs execute db-migrate --region "$REGION" --wait
```

If the job seems "stuck", open its execution logs — if you see "All migrations completed successfully", you're good even if the process didn't exit immediately.

**Handy describes:**

```bash
EXEC="$(gcloud run jobs executions list --job db-migrate --region "$REGION" --limit=1 --format='value(name)')"; echo "$EXEC"
gcloud run jobs executions describe "$EXEC" --region "$REGION" --format='yaml(status.conditions,startTime,completionTime)'
```

## 7) Health + smokes

```bash
BASE="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')"
echo "$BASE"
curl -fsS "$BASE/admin/status" | jq -c .
```

**Direct app send (drives the worker path):**

```bash
curl -sS -X POST "$BASE/sms/direct" -H 'Content-Type: application/json' \
  --data '{"id":"tpl-newday-001","phoneNumber":"+27824537125","incomingData":"Emergency Button"}' | jq .
```

**Logs you actually need:**

```bash
# Errors for live revision
REV="$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.latestReadyRevisionName)')"
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=$SVC AND resource.labels.revision_name=$REV AND severity>=ERROR" \
  --freshness=15m --limit=50 \
  --format='value(timestamp,severity,textPayload,jsonPayload.message)'

# Bridge call / wa_id confirmation
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=$SVC AND resource.labels.location=$REGION AND (textPayload:\"/api/messages/send\" OR textPayload:\"wa.woosh.ai\" OR jsonPayload.message:\"wa_id\")" \
  --freshness=10m --limit=50 \
  --format='value(timestamp,severity,textPayload,jsonPayload.message)'
```

## 8) Breaker controls (worker on/off)

```bash
# Close (enable worker)
export PGPASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD)"
psql "host=127.0.0.1 port=5432 dbname=wooshlifts user=app_user sslmode=disable" \
  -c "UPDATE breaker_state SET state='closed', failure_count=0, success_count=0, opened_at=NULL, updated_at=now() WHERE service='wa_bridge';"

# Open (pause worker, e.g., during incidents)
psql "host=127.0.0.1 port=5432 dbname=wooshlifts user=app_user sslmode=disable" \
  -c "UPDATE breaker_state SET state='open', failure_count=0, success_count=0, opened_at=now(), updated_at=now() WHERE service='wa_bridge';"
```

## 9) If Cloud Shell dies while you need temporary delivery

Not durable, but useful under pressure — direct bridge drain loop (park it in tmux):

```bash
export BRIDGE_BASE="https://wa.woosh.ai"
export BRIDGE_API_KEY="$(gcloud secrets versions access latest --secret=BRIDGE_API_KEY)"
export PGPASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD)"
while :; do
  R=$(psql "host=127.0.0.1 port=5432 dbname=wooshlifts user=app_user sslmode=disable" -t -A -F '|' <<'SQL'
BEGIN;
WITH c AS (
  SELECT id, to_msisdn, COALESCE(body,'') AS body
  FROM messages
  WHERE direction='out'
    AND (status IS NULL OR status='queued')
    AND (next_attempt_at IS NULL OR next_attempt_at <= now())
  ORDER BY ts ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE messages m
SET attempt_count=COALESCE(m.attempt_count,0)+1
FROM c
WHERE m.id=c.id
RETURNING c.id, c.to_msisdn, c.body;
COMMIT;
SQL
)
  ID=$(printf '%s' "$R" | awk -F'|' 'NF{print $1}')
  TO=$(printf '%s' "$R" | awk -F'|' 'NF{print $2}')
  BODY=$(printf '%s' "$R" | awk -F'|' 'NF{print $3}')
  [ -z "$ID" ] && sleep 1 && continue
  PAYLOAD=$(printf '{"to":"%s","text":"%s"}' "$TO" "$(printf '%s' "$BODY" | sed 's/"/\\"/g')")
  RESP=$(curl -sS -X POST "$BRIDGE_BASE/api/messages/send" -H "Content-Type: application/json" -H "X-Api-Key: $BRIDGE_API_KEY" --data "$PAYLOAD" || true)
  OK=$(printf '%s' "$RESP" | jq -r '.ok // false' 2>/dev/null || echo false)
  if [ "$OK" = "true" ]; then
    WAID=$(printf '%s' "$RESP" | jq -r '.wa_id // empty' 2>/dev/null || true)
    psql "host=127.0.0.1 port=5432 dbname=wooshlifts user=app_user sslmode=disable" \
      -c "UPDATE messages SET status='sent', meta = COALESCE(meta,'{}') || jsonb_build_object('wa_id','${WAID}') WHERE id='${ID}';" >/dev/null
    echo "sent $ID -> $TO ${WAID:+(wa_id=$WAID)}"
  else
    psql "host=127.0.0.1 port=5432 dbname=wooshlifts user=app_user sslmode=disable" \
      -c "UPDATE messages SET status='permanently_failed', last_error='bridge_400', last_error_at=now() WHERE id='${ID}';" >/dev/null
    echo "fail $ID -> $TO resp=$(printf '%s' "$RESP" | tr -d '\n')"
  fi
done
```

Use only if the worker must be paused and operators need messages to flow.

## 10) Known gotchas (don't trip these again)

**Cloud SQL flag difference:**
- Services use `--add-cloudsql-instances`
- Jobs use `--set-cloudsql-instances`

**Profile pollution**: run ops with `bash --noprofile --norc …` or start tmux and set env once.

**Local migrations**: don't. Always use `gcloud run jobs execute db-migrate …`.

**Enums**: the DB does not have a processing status — keep worker states to your existing enum.

**Auth loss**: if you see "no active account", re-select marc@woosh.ai:
```bash
gcloud config set account marc@woosh.ai
```

## 11) Morning checklist (quick)

1. `tmux attach -t wooshfix` (or `tmux new -s wooshfix`).
2. Pull code (section 4) → Build/Deploy (section 5).
3. Run migrations job (section 6) — confirm logs "All migrations completed successfully".
4. `/admin/status` OK; then close breaker (section 8).
5. `/sms/direct` test → check logs for `/api/messages/send` or `wa_id`.
6. Ping operators once WhatsApp arrives.

When you're back, the next move is mechanical: deploy the worker-fix build with the correct Cloud SQL + envs, close the breaker, and verify `/api/messages/send` shows up in logs. If anything resists, use the exact log queries above and we'll slice it thin.
