const express = require('express');
const router = express.Router();

// Health
router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'sms-routes' });
});

/**
 * Normalize phone number (strip leading +)
 * @param {string} phone - Raw phone number
 * @returns {string} Normalized phone number
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/^\+/, '');
}

/**
 * Detect portal shape and extract data
 * @param {Object} body - Request body
 * @returns {Object} Normalized message data
 */
function detectPortalShape(body) {
  // Shape A: { "msisdn": "...", "text": "..." }
  if (body.msisdn && body.text) {
    return {
      msisdn: normalizePhone(body.msisdn),
      text: body.text.trim(),
      provider_id: body.provider_id || 'portal',
      provider_shape: 'PORTAL_A'
    };
  }
  
  // Shape B: { "phoneNumber": "...", "incomingData": "..." }
  if (body.phoneNumber && body.incomingData) {
    return {
      msisdn: normalizePhone(body.phoneNumber),
      text: body.incomingData.trim(),
      provider_id: body.provider_id || 'portal',
      provider_shape: 'PORTAL_B'
    };
  }
  
  // Shape C: { "from": "...", "text": "..." } OR { "from": "...", "body": "..." }
  if (body.from && (body.text || body.body)) {
    return {
      msisdn: normalizePhone(body.from),
      text: (body.text || body.body || '').trim(),
      provider_id: body.provider_id || 'portal',
      provider_shape: 'PORTAL_C'
    };
  }
  
  return null;
}

// Portal ingestion: handles all portal shapes
router.post('/plain', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    
    // Detect portal shape
    const messageData = detectPortalShape(body);
    if (!messageData) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Invalid message format. Expected: msisdn+text, phoneNumber+incomingData, or from+text'
      });
    }
    
    // Validate required fields
    if (!messageData.msisdn) {
      return res.status(400).json({
        error: 'validation_error',
        field: 'msisdn',
        message: 'Missing phone number'
      });
    }
    
    if (!messageData.text) {
      return res.status(400).json({
        error: 'validation_error',
        field: 'text',
        message: 'Missing message text'
      });
    }
    
    // Create normalized message for ingestion
    const payload = {
      provider: 'portal',
      provider_id: messageData.provider_id,
      msisdn: `+${messageData.msisdn}`,
      text: messageData.text,
      ts: new Date().toISOString(),
      meta: { 
        provider_shape: messageData.provider_shape,
        original: body
      }
    };
    
    // lazy-load to avoid circulars
    const { ingestMessage } = require('../lib/ingest');
    const { ok, idempotent, message_id } = await ingestMessage(payload);
    
    // Log the successful ingestion
    console.log(JSON.stringify({
      event: 'sms_ingested',
      provider: 'portal',
      provider_id: messageData.provider_id,
      msisdn: messageData.msisdn,
      text_length: messageData.text.length,
      idempotent,
      message_id,
      provider_shape: messageData.provider_shape
    }));
    
    return res.status(202).json({ ok, idempotent, message_id });
  } catch (err) {
    console.error('[sms/plain] ingest error:', JSON.stringify({
      message: err && err.message,
      code: err && err.code,
      stack: err && err.stack
    }));
    return res.status(500).json({ error: 'internal_error', message: 'Failed to process SMS message' });
  }
});

module.exports = router;
