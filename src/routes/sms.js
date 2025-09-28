const express = require('express');
const router = express.Router();

// Health
router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'sms-routes' });
});

// Minimal portal ingestion: { msisdn: string, text: string, provider_id?: string }
router.post('/plain', express.json(), async (req, res) => {
  try {
    const { msisdn, text, provider_id } = req.body || {};
    if (!msisdn || typeof msisdn !== 'string') {
      return res.status(400).json({ error: 'validation_error', field: 'msisdn' });
    }
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'validation_error', field: 'text' });
    }

    // normalize minimal shape; idempotency lives in ingest
    const payload = {
      provider_id: provider_id || 'portal',
      from_msisdn: msisdn.replace(/^\+/, ''),
      body: text,
      meta: { provider_shape: 'PORTAL' }
    };

    // lazy-load to avoid circulars
    const { ingestMessage } = require('../lib/ingest');
    const { ok, idempotent, message_id } = await ingestMessage(payload);

    return res.status(202).json({ ok, idempotent, message_id });
  } catch (err) {
    console.error('[sms/plain] ingest error:', err && err.message);
    return res.status(500).json({ error: 'internal_error', message: 'Failed to process SMS message' });
  }
});

module.exports = router;
