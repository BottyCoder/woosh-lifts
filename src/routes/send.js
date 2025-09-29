/**
 * Send routes for WhatsApp messages
 * Handles sending messages with retry logic, circuit breaker, and DLQ
 */

const express = require('express');
const { query } = require('../db');
const { sendMessage, sendTemplate } = require('../lib/waBridge');
const { isRequestAllowed, recordAttempt } = require('../lib/breaker');
const { updateMessageStatus, recordWaAttempt } = require('../lib/retryQueue');

const router = express.Router();

// JSON parser for all routes
const jsonParser = express.json({ limit: '128kb' });

/**
 * Send text message
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
async function sendTextMessage(req, res) {
  try {
    const { to, text } = req.body;
    
    if (!to || !text) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Missing required fields: to, text'
      });
    }
    
    // Check circuit breaker
    const allowed = await isRequestAllowed();
    if (!allowed) {
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Circuit breaker is open'
      });
    }
    
    // Create message record
    const messageResult = await query(`
      INSERT INTO messages (
        channel, 
        provider, 
        provider_id, 
        direction, 
        from_msisdn, 
        to_msisdn, 
        body, 
        status,
        attempt_count,
        next_attempt_at
      ) VALUES (
        'wa', 
        'internal', 
        $1, 
        'out', 
        NULL, 
        $2, 
        $3, 
        'queued',
        0,
        now()
      ) 
      RETURNING id
    `, [
      `text-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      to,
      text
    ]);
    
    const messageId = messageResult.rows[0].id;
    
    // Attempt to send immediately
    const startTime = Date.now();
    const response = await sendMessage({
      to,
      type: 'text',
      text: { body: text }
    });
    
    const latencyMs = Date.now() - startTime;
    
    // Record attempt
    await recordWaAttempt(messageId, 1, {
      httpCode: response.httpCode,
      status: response.success ? 'success' : 'retry',
      latencyMs,
      errorKind: response.success ? null : getErrorKind(response.httpCode, response.error),
      responseExcerpt: response.responseExcerpt
    });
    
    // Record breaker attempt
    await recordAttempt(response.success, response.httpCode);
    
    if (response.success) {
      // Update message status to sent
      await updateMessageStatus(messageId, 'sent', {
        attempt_count: 1
      });
      
      return res.status(200).json({
        ok: true,
        message_id: messageId,
        status: 'sent',
        attempt_count: 1,
        latency_ms: latencyMs
      });
    } else {
      // Check if we should retry
      const maxAttempts = parseInt(process.env.RETRY_MAX_ATTEMPTS || '4');
      if (1 >= maxAttempts) {
        // Mark as permanently failed
        await updateMessageStatus(messageId, 'permanently_failed', {
          attempt_count: 1,
          last_error: response.error,
          last_error_at: new Date()
        });
        
        // Emit DLQ event if enabled
        if (process.env.DLQ_ENABLED === 'true') {
          await emitDLQEvent(messageId, { to, text }, response);
        }
        
        return res.status(502).json({
          error: 'send_failed',
          message: 'Message failed to send and exceeded retry limit',
          message_id: messageId,
          status: 'permanently_failed'
        });
      } else {
        // Schedule for retry
        const nextAttempt = calculateNextAttempt(1);
        await updateMessageStatus(messageId, 'queued', {
          attempt_count: 1,
          last_error: response.error,
          last_error_at: new Date(),
          next_attempt_at: nextAttempt
        });
        
        return res.status(202).json({
          ok: true,
          message_id: messageId,
          status: 'queued',
          attempt_count: 1,
          next_attempt_at: nextAttempt
        });
      }
    }
    
  } catch (error) {
    console.error('[send/text] Error:', error);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to send message'
    });
  }
}

/**
 * Send template message
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
async function sendTemplateMessage(req, res) {
  try {
    const { to, template_name, template_language, template_components } = req.body;
    
    if (!to || !template_name) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Missing required fields: to, template_name'
      });
    }
    
    // Check circuit breaker
    const allowed = await isRequestAllowed();
    if (!allowed) {
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Circuit breaker is open'
      });
    }
    
    // Create message record
    const messageResult = await query(`
      INSERT INTO messages (
        channel, 
        provider, 
        provider_id, 
        direction, 
        from_msisdn, 
        to_msisdn, 
        body, 
        template_name,
        template_language,
        template_components,
        status,
        attempt_count,
        next_attempt_at
      ) VALUES (
        'wa', 
        'internal', 
        $1, 
        'out', 
        NULL, 
        $2, 
        NULL, 
        $3,
        $4,
        $5,
        'queued',
        0,
        now()
      ) 
      RETURNING id
    `, [
      `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      to,
      template_name,
      template_language || 'en',
      template_components ? JSON.stringify(template_components) : null
    ]);
    
    const messageId = messageResult.rows[0].id;
    
    // Attempt to send immediately
    const startTime = Date.now();
    const response = await sendTemplate({
      to,
      type: 'template',
      template: {
        name: template_name,
        language: { code: template_language || 'en' },
        components: template_components || []
      }
    });
    
    const latencyMs = Date.now() - startTime;
    
    // Record attempt
    await recordWaAttempt(messageId, 1, {
      httpCode: response.httpCode,
      status: response.success ? 'success' : 'retry',
      latencyMs,
      errorKind: response.success ? null : getErrorKind(response.httpCode, response.error),
      responseExcerpt: response.responseExcerpt
    });
    
    // Record breaker attempt
    await recordAttempt(response.success, response.httpCode);
    
    if (response.success) {
      // Update message status to sent
      await updateMessageStatus(messageId, 'sent', {
        attempt_count: 1
      });
      
      return res.status(200).json({
        ok: true,
        message_id: messageId,
        status: 'sent',
        attempt_count: 1,
        latency_ms: latencyMs
      });
    } else {
      // Check if we should retry
      const maxAttempts = parseInt(process.env.RETRY_MAX_ATTEMPTS || '4');
      if (1 >= maxAttempts) {
        // Mark as permanently failed
        await updateMessageStatus(messageId, 'permanently_failed', {
          attempt_count: 1,
          last_error: response.error,
          last_error_at: new Date()
        });
        
        // Emit DLQ event if enabled
        if (process.env.DLQ_ENABLED === 'true') {
          await emitDLQEvent(messageId, { to, template_name, template_language, template_components }, response);
        }
        
        return res.status(502).json({
          error: 'send_failed',
          message: 'Message failed to send and exceeded retry limit',
          message_id: messageId,
          status: 'permanently_failed'
        });
      } else {
        // Schedule for retry
        const nextAttempt = calculateNextAttempt(1);
        await updateMessageStatus(messageId, 'queued', {
          attempt_count: 1,
          last_error: response.error,
          last_error_at: new Date(),
          next_attempt_at: nextAttempt
        });
        
        return res.status(202).json({
          ok: true,
          message_id: messageId,
          status: 'queued',
          attempt_count: 1,
          next_attempt_at: nextAttempt
        });
      }
    }
    
  } catch (error) {
    console.error('[send/template] Error:', error);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to send template message'
    });
  }
}

/**
 * Get message status
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
async function getMessageStatus(req, res) {
  try {
    const { messageId } = req.params;
    
    const result = await query(`
      SELECT 
        id, 
        status, 
        attempt_count, 
        last_error, 
        last_error_at, 
        next_attempt_at,
        created_at
      FROM messages 
      WHERE id = $1
    `, [messageId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Message not found'
      });
    }
    
    const message = result.rows[0];
    
    // Get attempt history
    const attemptsResult = await query(`
      SELECT 
        attempt_number,
        http_code,
        status,
        latency_ms,
        error_kind,
        response_excerpt,
        created_at
      FROM wa_attempts 
      WHERE message_id = $1 
      ORDER BY attempt_number
    `, [messageId]);
    
    return res.status(200).json({
      ok: true,
      message: {
        id: message.id,
        status: message.status,
        attempt_count: message.attempt_count,
        last_error: message.last_error,
        last_error_at: message.last_error_at,
        next_attempt_at: message.next_attempt_at,
        created_at: message.created_at
      },
      attempts: attemptsResult.rows
    });
    
  } catch (error) {
    console.error('[send/status] Error:', error);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to get message status'
    });
  }
}

/**
 * Get breaker status
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
async function getBreakerStatus(req, res) {
  try {
    const { getBreakerStats } = require('../lib/breaker');
    const stats = await getBreakerStats();
    
    return res.status(200).json({
      ok: true,
      breaker: stats
    });
    
  } catch (error) {
    console.error('[send/breaker] Error:', error);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to get breaker status'
    });
  }
}

/**
 * Get error kind for logging
 * @param {number} statusCode - HTTP status code
 * @param {string} error - Error message
 * @returns {string} Error kind
 */
function getErrorKind(statusCode, error) {
  if (error && error.includes('timeout')) {
    return 'timeout';
  }
  if (statusCode >= 500) {
    return 'server_error';
  }
  if (statusCode === 429) {
    return 'rate_limited';
  }
  if (statusCode >= 400) {
    return 'client_error';
  }
  return 'unknown';
}

/**
 * Calculate next attempt time
 * @param {number} attemptNumber - Current attempt number
 * @returns {Date} Next attempt time
 */
function calculateNextAttempt(attemptNumber) {
  const retrySchedule = (process.env.RETRY_SCHEDULE || '1s,4s,15s,60s').split(',');
  const jitterMs = parseInt(process.env.RETRY_JITTER_MS || '200');
  
  const delayIndex = Math.min(attemptNumber - 1, retrySchedule.length - 1);
  const delayStr = retrySchedule[delayIndex];
  
  let baseDelay;
  if (delayStr.endsWith('s')) {
    baseDelay = parseInt(delayStr) * 1000;
  } else if (delayStr.endsWith('m')) {
    baseDelay = parseInt(delayStr) * 60 * 1000;
  } else {
    baseDelay = 1000; // Default 1 second
  }
  
  const jitter = Math.random() * jitterMs;
  return new Date(Date.now() + baseDelay + jitter);
}

/**
 * Emit DLQ event for permanently failed message
 * @param {string} messageId - Message ID
 * @param {Object} message - Message data
 * @param {Object} lastResponse - Last response
 * @returns {Promise<void>}
 */
async function emitDLQEvent(messageId, message, lastResponse) {
  const dlqEvent = {
    type: 'message_permanently_failed',
    message_id: messageId,
    message,
    last_response: {
      http_code: lastResponse.httpCode,
      error: lastResponse.error,
      response_excerpt: lastResponse.responseExcerpt
    },
    failed_at: new Date().toISOString()
  };
  
  await query(`
    INSERT INTO events (type, payload, ts)
    VALUES ('dlq_message_failed', $1, now())
  `, [JSON.stringify(dlqEvent)]);
  
  console.log(`[send] DLQ event emitted for message ${messageId}`);
}

// Routes
router.post('/text', jsonParser, sendTextMessage);
router.post('/template', jsonParser, sendTemplateMessage);
router.get('/status/:messageId', getMessageStatus);
router.get('/breaker', getBreakerStatus);

// Health check
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'send-routes' });
});

module.exports = router;
