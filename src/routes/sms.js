/**
 * SMS routes with provider-agnostic normalization
 * Supports multiple SMS providers with consistent internal processing
 */

const express = require('express');
const { normalizeInbound, fromGeneric } = require('../lib/normalize');
const { ingestMessage } = require('../lib/ingest');
const { query } = require('../db');

const router = express.Router();

// JSON parser for all routes
const jsonParser = express.json({ limit: '128kb' });

/**
 * Generic provider endpoint handler
 * @param {string} providerKey - Provider identifier
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
async function handleProviderMessage(providerKey, req, res) {
  try {
    // Normalize the incoming message
    const normalizedMsg = normalizeInbound(providerKey, req);
    
    // Ingest with idempotency
    const result = await ingestMessage(normalizedMsg);
    
    // Log the successful ingestion
    console.log(JSON.stringify({
      event: 'sms_ingested',
      provider: normalizedMsg.provider,
      provider_id: normalizedMsg.provider_id,
      msisdn: normalizedMsg.msisdn,
      text_length: normalizedMsg.text.length,
      idempotent: result.idempotent,
      message_id: result.stored_message_id
    }));
    
    // Return success response
    res.status(202).json({
      ok: true,
      message_id: result.stored_message_id,
      idempotent: result.idempotent,
      provider: normalizedMsg.provider
    });
    
  } catch (error) {
    console.error(`[sms/${providerKey}] error:`, error);
    
    // Handle validation errors with specific field information
    if (error.message.includes('Missing required field')) {
      const fieldMatch = error.message.match(/Missing required field: (\w+)/);
      const field = fieldMatch ? fieldMatch[1] : 'unknown';
      
      return res.status(400).json({
        error: 'validation_error',
        field: field,
        message: error.message
      });
    }
    
    if (error.message.includes('Invalid E.164 format')) {
      return res.status(400).json({
        error: 'validation_error',
        field: 'msisdn',
        message: 'Invalid phone number format'
      });
    }
    
    if (error.message.includes('Text cannot be empty')) {
      return res.status(400).json({
        error: 'validation_error',
        field: 'text',
        message: 'Message text cannot be empty'
      });
    }
    
    // Generic error response
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to process SMS message'
    });
  }
}

// Provider-specific endpoints
router.post('/provider/twilio', jsonParser, (req, res) => {
  handleProviderMessage('twilio', req, res);
});

router.post('/provider/infobip', jsonParser, (req, res) => {
  handleProviderMessage('infobip', req, res);
});

router.post('/provider/mtn', jsonParser, (req, res) => {
  handleProviderMessage('mtn', req, res);
});

router.post('/provider/vodacom', jsonParser, (req, res) => {
  handleProviderMessage('vodacom', req, res);
});

router.post('/provider/generic', jsonParser, (req, res) => {
  handleProviderMessage('generic', req, res);
});

// Legacy /sms/plain endpoint with backward compatibility
router.post('/plain', jsonParser, async (req, res) => {
  try {
    const body = req.body || {};
    
    // Detect if this is already in the new format
    if (body.provider && body.provider_id && body.msisdn && body.text) {
      // Already normalized, use generic adapter
      const normalizedMsg = fromGeneric(body);
      const result = await ingestMessage(normalizedMsg);
      
      return res.status(202).json({
        ok: true,
        message_id: result.stored_message_id,
        idempotent: result.idempotent,
        provider: 'generic'
      });
    }
    
    // Legacy format - convert to generic format
    const legacyMsg = {
      msisdn: body.phoneNumber || body.from || body.msisdn,
      text: body.incomingData || body.text || body.body || body.message,
      provider_id: body.id || body.messageId || `legacy-${Date.now()}`,
      ts: body.timestamp || new Date().toISOString()
    };
    
    // Validate required fields
    if (!legacyMsg.msisdn || !legacyMsg.text) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Missing required fields: phoneNumber/incomingData or from/text'
      });
    }
    
    // Normalize using generic adapter
    const normalizedMsg = fromGeneric(legacyMsg);
    const result = await ingestMessage(normalizedMsg);
    
    // Log the successful ingestion
    console.log(JSON.stringify({
      event: 'sms_ingested_legacy',
      provider: 'legacy',
      provider_id: normalizedMsg.provider_id,
      msisdn: normalizedMsg.msisdn,
      text_length: normalizedMsg.text.length,
      idempotent: result.idempotent,
      message_id: result.stored_message_id
    }));
    
    // Return success response
    res.status(202).json({
      ok: true,
      message_id: result.stored_message_id,
      idempotent: result.idempotent,
      provider: 'legacy'
    });
    
  } catch (error) {
    console.error('[sms/plain] error:', error);
    
    // Handle validation errors
    if (error.message.includes('Invalid E.164 format')) {
      return res.status(400).json({
        error: 'validation_error',
        field: 'msisdn',
        message: 'Invalid phone number format'
      });
    }
    
    if (error.message.includes('Text cannot be empty')) {
      return res.status(400).json({
        error: 'validation_error',
        field: 'text',
        message: 'Message text cannot be empty'
      });
    }
    
    // Generic error response
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to process SMS message'
    });
  }
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'sms-routes' });
});

module.exports = router;
