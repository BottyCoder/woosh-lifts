'use strict';
/**
 * Template Flow Router
 * Handles three button texts: Test | Maintenance | Entrapment
 * Behavior: broadcast message to all contacts linked to the lift (by MSISDN), log, and close.
 *
 * Safety:
 * - Zero DDL. If DB shape differs, we fall back to notifying only the origin MSISDN.
 * - Uses top-level {to,text} payload for the WhatsApp bridge.
 */

const express = require('express');
const router = express.Router();

// Optional DB; we try to load 'pg' only if DATABASE_URL exists.
let pgPool = null;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }
} catch (e) {
  console.warn('[templateFlow] pg not available, DB logging disabled:', e.message);
}

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || 'https://wa.woosh.ai';
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY || '';
const https = require('https');
const { URL } = require('url');

function sendWA(to, text) {
  return new Promise((resolve, reject) => {
    try {
      const target = new URL(`${BRIDGE_BASE_URL}/api/messages/send`);
      const payload = JSON.stringify({ to, text });
      const opts = {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Api-Key': BRIDGE_API_KEY
        }
      };
      const req = https.request(opts, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Drain and resolve
          res.resume();
          resolve();
        } else {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => reject(new Error(`Bridge send failed ${res.statusCode}: ${body}`)));
        }
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function classify(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t.startsWith('test')) return { kind: 'test', message: 'Testing is taking place, please ignore this request' };
  if (t.startsWith('maintenance')) return { kind: 'maintenance', message: 'Maintenance is taking place, please ignore this request' };
  if (t.startsWith('entrapment')) return { kind: 'entrapment', message: 'Has the service provider been notified of the entrapment' };
  return null;
}

async function getLiftIdByMsisdn(msisdn) {
  if (!pgPool) return null;
  try {
    const q = 'select id from lifts where msisdn=$1 limit 1';
    const r = await pgPool.query(q, [msisdn]);
    return r.rows[0]?.id ?? null;
  } catch (e) {
    console.warn('[templateFlow] getLiftIdByMsisdn failed:', e.message);
    return null;
  }
}

async function getContactsForLift(liftId) {
  if (!pgPool || !liftId) return [];
  // NOTE: Adjust table/column names if your schema differs.
  // Expected: lift_contacts(lift_id, contact_id), contacts(id, wa_msisdn)
  try {
    const q = `
      select c.wa_msisdn as msisdn
      from lift_contacts lc
      join contacts c on c.id = lc.contact_id
      where lc.lift_id = $1 and c.wa_msisdn is not null and c.wa_msisdn <> ''
    `;
    const r = await pgPool.query(q, [liftId]);
    return r.rows.map(x => x.msisdn);
  } catch (e) {
    console.warn('[templateFlow] getContactsForLift failed:', e.message);
    return [];
  }
}

async function logMessage({ liftId, originMsisdn, kind, broadcastCount }) {
  if (!pgPool) return;
  try {
    // Minimal insert; adjust table/columns if your schema differs.
    await pgPool.query(
      `insert into messages (lift_id, msisdn, direction, type, status, body, meta, created_at)
       values ($1, $2, 'system', $3, 'closed', $4, $5, now())`,
      [
        liftId,
        originMsisdn,
        kind,
        kind === 'entrapment'
          ? 'Has the service provider been notified of the entrapment'
          : (kind === 'maintenance'
              ? 'Maintenance is taking place, please ignore this request'
              : 'Testing is taking place, please ignore this request'),
        JSON.stringify({ broadcastCount })
      ]
    );
  } catch (e) {
    console.warn('[templateFlow] logMessage failed:', e.message);
  }
}

async function handleTemplate(msisdn, text) {
  const cls = classify(text);
  if (!cls) {
    return { ok: false, reason: 'unrecognized_command' };
  }
  const liftId = await getLiftIdByMsisdn(msisdn);
  let recipients = await getContactsForLift(liftId);

  // Fallback: if we can't resolve contacts yet, at least message the origin MSISDN.
  if (!recipients.length && msisdn) {
    console.warn('[templateFlow] No contacts found; falling back to origin MSISDN');
    recipients = [msisdn];
  }

  let sent = 0, errors = [];
  for (const to of recipients) {
    try {
      await sendWA(to, cls.message);
      sent++;
    } catch (e) {
      console.warn('[templateFlow] sendWA error:', e.message);
      errors.push({ to, error: e.message });
    }
  }
  await logMessage({ liftId, originMsisdn: msisdn, kind: cls.kind, broadcastCount: sent });
  return { ok: true, kind: cls.kind, broadcastCount: sent, errors };
}

/**
 * Admin simulate endpoint (safe, no DB changes) to drive tests:
 * POST /admin/simulate/template  { "msisdn": "27824537125", "text": "Test" }
 */
router.post('/admin/simulate/template', express.json(), async (req, res) => {
  try {
    const { msisdn, text } = req.body || {};
    if (!msisdn || !text) return res.status(400).json({ ok: false, error: 'msisdn_and_text_required' });
    const result = await handleTemplate(String(msisdn), String(text));
    return res.json(result);
  } catch (e) {
    console.error('[templateFlow] simulate error:', e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Export both the router and the handler in case the inbound WA webhook wants to reuse it.
router.handleTemplate = handleTemplate;
module.exports = router;
