/**
 * SMS message ingestion with idempotency
 * Handles database storage and audit logging for normalized SMS messages
 */

const { query, withTxn } = require('../db');

/**
 * @typedef {Object} InboundSms
 * @property {'twilio'|'infobip'|'mtn'|'vodacom'|'generic'} provider
 * @property {string} provider_id - message SID / ID from provider (required)
 * @property {string} msisdn - E.164, e.g. +27824537125 (required)
 * @property {string} text - non-empty trimmed (required)
 * @property {string} ts - ISO timestamp; provider event time or server time
 * @property {Record<string, any>} [meta] - untouched original extras
 */

/**
 * @typedef {Object} IngestResult
 * @property {string} stored_message_id - UUID of stored message
 * @property {boolean} idempotent - Whether this was a duplicate message
 */

/**
 * Ingest a normalized SMS message with idempotency
 * @param {InboundSms} msg - Normalized SMS message
 * @returns {Promise<IngestResult>} Result of ingestion
 */
async function ingestMessage(msg) {
  return await withTxn(async (client) => {
    // Check if message already exists (idempotency check)
    const existingResult = await client.query(
      'SELECT id FROM messages WHERE provider = $1 AND provider_id = $2',
      [msg.provider, msg.provider_id]
    );
    
    if (existingResult.rows.length > 0) {
      // Message already exists, return idempotent response
      return {
        stored_message_id: existingResult.rows[0].id,
        idempotent: true
      };
    }
    
    // Insert new message with upsert on conflict
    const messageResult = await client.query(`
      INSERT INTO messages (
        channel, 
        provider, 
        provider_id, 
        direction, 
        from_msisdn, 
        to_msisdn, 
        body, 
        meta, 
        ts
      ) VALUES (
        'sms', 
        $1, 
        $2, 
        'in', 
        $3, 
        NULL, 
        $4, 
        $5, 
        $6
      ) 
      ON CONFLICT (provider, provider_id) DO NOTHING
      RETURNING id
    `, [
      msg.provider,
      msg.provider_id,
      msg.msisdn,
      msg.text,
      JSON.stringify(msg.meta),
      msg.ts
    ]);
    
    if (messageResult.rows.length === 0) {
      // Conflict occurred, fetch the existing message
      const conflictResult = await client.query(
        'SELECT id FROM messages WHERE provider = $1 AND provider_id = $2',
        [msg.provider, msg.provider_id]
      );
      
      return {
        stored_message_id: conflictResult.rows[0].id,
        idempotent: true
      };
    }
    
    const messageId = messageResult.rows[0].id;
    
    // Create audit event
    await client.query(`
      INSERT INTO events (type, payload, ts)
      VALUES ('ingest', $1, now())
    `, [JSON.stringify({
      ingested_ok: true,
      message_id: messageId,
      meta: {
        original: msg.meta.original,
        provider: msg.provider
      }
    })]);
    
    return {
      stored_message_id: messageId,
      idempotent: false
    };
  });
}

/**
 * Get message by provider and provider_id
 * @param {string} provider - Provider name
 * @param {string} provider_id - Provider message ID
 * @returns {Promise<Object|null>} Message record or null
 */
async function getMessageByProviderId(provider, provider_id) {
  const result = await query(
    'SELECT * FROM messages WHERE provider = $1 AND provider_id = $2',
    [provider, provider_id]
  );
  
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Get recent messages for a MSISDN
 * @param {string} msisdn - Phone number in E.164 format
 * @param {number} limit - Maximum number of messages to return
 * @returns {Promise<Array>} Array of message records
 */
async function getMessagesForMsisdn(msisdn, limit = 10) {
  const result = await query(`
    SELECT * FROM messages 
    WHERE from_msisdn = $1 
    ORDER BY ts DESC 
    LIMIT $2
  `, [msisdn, limit]);
  
  return result.rows;
}

module.exports = {
  ingestMessage,
  getMessageByProviderId,
  getMessagesForMsisdn
};
