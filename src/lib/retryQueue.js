/**
 * Retry queue for scheduling and processing retries
 * Simplified processing with strict filtering and proper bridge calls
 */

const { sendText } = require("../clients/waBridge");
const { Pool } = require("pg");

// Create pool using PG* env vars
const pool = new Pool();

// Only pick valid outbound WA rows; leave status as 'queued' (avoid enum issues)
const PICK_SQL = `
WITH c AS (
  SELECT id, to_msisdn, body
  FROM messages
  WHERE direction = 'out'
    AND channel = 'wa'
    AND (status IS NULL OR status = 'queued')
    AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    AND to_msisdn IS NOT NULL AND length(trim(to_msisdn)) > 0
  ORDER BY ts ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE messages m
SET attempt_count = COALESCE(m.attempt_count, 0) + 1,
    last_error = NULL,
    last_error_at = NULL
FROM c
WHERE m.id = c.id
RETURNING m.id, c.to_msisdn, c.body;
`;

async function processOne() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pick = await client.query(PICK_SQL);
    await client.query("COMMIT");
    if (pick.rowCount === 0) return false;

    const { id, to_msisdn, body } = pick.rows[0];

    // send to bridge
    const resp = await sendText(to_msisdn, body ?? "");

    // success → mark sent and store wa_id in meta
    await pool.query(
      `UPDATE messages
       SET status='sent',
           meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('wa_id',$1),
           last_error = NULL,
           last_error_at = NULL
       WHERE id = $2`,
      [resp.wa_id ?? null, id]
    );
    return true;
  } catch (err) {
    // 4xx → permanent; 5xx/network → schedule retry
    const code = Number(err?.code) || 0;
    if (code >= 400 && code < 500) {
      await pool.query(
        `UPDATE messages
         SET status='permanently_failed',
             last_error=$1,
             last_error_at=now()
         WHERE id=$2`,
        [err?.message || `bridge_${code}`, id]
      );
    } else {
      // exponential-ish backoff: +30s * (attempt_count+1)
      await pool.query(
        `UPDATE messages
         SET status='queued',
             next_attempt_at = now() + make_interval(secs => 30 * LEAST(10, attempt_count + 1)),
             last_error=$1,
             last_error_at=now()
         WHERE id=$2`,
        [err?.message || "bridge_retry", id]
      );
    }
    return true;
  } finally {
    client.release();
  }
}

async function runForever() {
  for (;;) {
    const did = await processOne();
    await new Promise(r => setTimeout(r, did ? 100 : 500));
  }
}

/**
 * Start retry queue processor
 * @param {number} intervalMs - Processing interval in milliseconds (ignored, uses runForever)
 */
function startRetryProcessor(intervalMs = 5000) {
  console.log(`[retryQueue] Starting retry processor`);
  
  // Start the forever loop in background
  runForever().catch(err => {
    console.error('[retryQueue] Error in retry processor:', err);
  });
}

// Legacy functions for compatibility
async function processPendingRetries() {
  // This is now handled by runForever
  return;
}

async function processRetry(message) {
  // This is now handled by processOne
  return;
}

async function updateMessageStatus(messageId, status, updates = {}) {
  const setClause = Object.keys(updates).map((key, index) => `${key} = $${index + 2}`).join(', ');
  const values = [messageId, ...Object.values(updates)];
  
  await pool.query(
    `UPDATE messages SET status = $1${setClause ? ', ' + setClause : ''} WHERE id = $${values.length > 1 ? values.length : 1}`,
    [status, ...values]
  );
}

async function recordWaAttempt(messageId, attemptNumber, attemptData) {
  // This is now handled inline in processOne
  return;
}

function calculateNextAttempt(attemptNumber, baseDelay = 30000) {
  return new Date(Date.now() + baseDelay * Math.min(10, attemptNumber + 1));
}

const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 4,
  retrySchedule: ['1s', '4s', '15s', '60s'],
  jitterMs: 200
};

module.exports = {
  processRetry,
  processPendingRetries,
  startRetryProcessor,
  updateMessageStatus,
  recordWaAttempt,
  calculateNextAttempt,
  DEFAULT_RETRY_CONFIG
};