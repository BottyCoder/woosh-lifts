/**
 * Retry queue for scheduling and processing retries
 * Manages retry scheduling with exponential backoff and jitter
 */

const { query } = require('../db');
const { sendMessage, sendTemplate } = require('./waBridge');
const { getBreakerState, recordAttempt } = require('./breaker');

/**
 * @typedef {Object} RetryConfig
 * @property {number} maxAttempts - Maximum retry attempts
 * @property {string[]} retrySchedule - Retry delays (e.g., ["1s", "4s", "15s"])
 * @property {number} jitterMs - Jitter range in milliseconds
 */

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG = {
  maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '4'),
  retrySchedule: (process.env.RETRY_SCHEDULE || '1s,4s,15s,60s').split(','),
  jitterMs: parseInt(process.env.RETRY_JITTER_MS || '200')
};

/**
 * Parse delay string to milliseconds
 * @param {string} delay - Delay string (e.g., "1s", "4s", "15s", "60s")
 * @returns {number} Milliseconds
 */
function parseDelay(delay) {
  const match = delay.match(/^(\d+)([smh])$/);
  if (!match) return 1000; // Default 1 second
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return 1000;
  }
}

/**
 * Add jitter to delay
 * @param {number} baseDelay - Base delay in milliseconds
 * @param {number} jitterMs - Jitter range in milliseconds
 * @returns {number} Jittered delay
 */
function addJitter(baseDelay, jitterMs) {
  const jitter = Math.random() * jitterMs;
  return baseDelay + jitter;
}

/**
 * Calculate next attempt time
 * @param {number} attemptNumber - Current attempt number (1-based)
 * @param {RetryConfig} config - Retry configuration
 * @returns {Date} Next attempt time
 */
function calculateNextAttempt(attemptNumber, config = DEFAULT_RETRY_CONFIG) {
  const delayIndex = Math.min(attemptNumber - 1, config.retrySchedule.length - 1);
  const baseDelay = parseDelay(config.retrySchedule[delayIndex]);
  const jitteredDelay = addJitter(baseDelay, config.jitterMs);
  
  return new Date(Date.now() + jitteredDelay);
}

/**
 * Update message status in database
 * @param {string} messageId - Message ID
 * @param {string} status - New status
 * @param {Object} updates - Additional updates
 * @returns {Promise<void>}
 */
async function updateMessageStatus(messageId, status, updates = {}) {
  const setClause = ['status = $2'];
  const values = [messageId, status];
  let paramIndex = 3;
  
  if (updates.attempt_count !== undefined) {
    setClause.push(`attempt_count = $${paramIndex++}`);
    values.push(updates.attempt_count);
  }
  
  if (updates.last_error !== undefined) {
    setClause.push(`last_error = $${paramIndex++}`);
    values.push(updates.last_error);
  }
  
  if (updates.last_error_at !== undefined) {
    setClause.push(`last_error_at = $${paramIndex++}`);
    values.push(updates.last_error_at);
  }
  
  if (updates.next_attempt_at !== undefined) {
    setClause.push(`next_attempt_at = $${paramIndex++}`);
    values.push(updates.next_attempt_at);
  }
  
  await query(`
    UPDATE messages 
    SET ${setClause.join(', ')}
    WHERE id = $1
  `, values);
}

/**
 * Record attempt in wa_attempts table
 * @param {string} messageId - Message ID
 * @param {number} attemptNumber - Attempt number
 * @param {Object} attempt - Attempt details
 * @returns {Promise<void>}
 */
async function recordWaAttempt(messageId, attemptNumber, attempt) {
  await query(`
    INSERT INTO wa_attempts (
      message_id, 
      attempt_number, 
      http_code, 
      status, 
      latency_ms, 
      error_kind, 
      response_excerpt
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    messageId,
    attemptNumber,
    attempt.httpCode,
    attempt.status,
    attempt.latencyMs,
    attempt.errorKind,
    attempt.responseExcerpt
  ]);
}

/**
 * Process a single message retry
 * @param {Object} message - Message record from database
 * @returns {Promise<void>}
 */
async function processRetry(message) {
  const messageId = message.id;
  const attemptNumber = (message.attempt_count || 0) + 1;
  
  console.log(`[retryQueue] Processing retry ${attemptNumber} for message ${messageId}`);
  
  try {
    // Check circuit breaker
    const breakerState = await getBreakerState();
    if (breakerState === 'open') {
      console.log(`[retryQueue] Circuit breaker is open, skipping retry for message ${messageId}`);
      
      await updateMessageStatus(messageId, 'queued', {
        attempt_count: attemptNumber,
        last_error: 'Circuit breaker open',
        last_error_at: new Date()
      });
      
      await recordWaAttempt(messageId, attemptNumber, {
        httpCode: 0,
        status: 'breaker_open',
        latencyMs: 0,
        errorKind: 'breaker_open',
        responseExcerpt: 'Circuit breaker open'
      });
      
      return;
    }
    
    // Prepare message payload
    let payload;
    if (message.template_name) {
      payload = {
        to: message.to_msisdn,
        type: 'template',
        template: {
          name: message.template_name,
          language: { code: message.template_language || 'en' },
          components: message.template_components ? JSON.parse(message.template_components) : []
        }
      };
    } else {
      payload = {
        to: message.to_msisdn,
        type: 'text',
        text: { body: message.body }
      };
    }
    
    // Make the request
    const startTime = Date.now();
    const response = message.template_name 
      ? await sendTemplate(payload)
      : await sendMessage(payload);
    
    const latencyMs = Date.now() - startTime;
    
    // Record attempt
    await recordWaAttempt(messageId, attemptNumber, {
      httpCode: response.httpCode,
      status: response.success ? 'success' : 'retry',
      latencyMs,
      errorKind: response.success ? null : getErrorKind(response.httpCode, response.error),
      responseExcerpt: response.responseExcerpt
    });
    
    // Update message status
    if (response.success) {
      await updateMessageStatus(messageId, 'sent', {
        attempt_count: attemptNumber
      });
      
      console.log(`[retryQueue] Message ${messageId} sent successfully on attempt ${attemptNumber}`);
    } else {
      // Check if we should retry again
      if (attemptNumber >= DEFAULT_RETRY_CONFIG.maxAttempts) {
        await updateMessageStatus(messageId, 'permanently_failed', {
          attempt_count: attemptNumber,
          last_error: response.error,
          last_error_at: new Date()
        });
        
        console.log(`[retryQueue] Message ${messageId} permanently failed after ${attemptNumber} attempts`);
        
        // Emit DLQ event if enabled
        if (process.env.DLQ_ENABLED === 'true') {
          await emitDLQEvent(messageId, message, response);
        }
      } else {
        const nextAttempt = calculateNextAttempt(attemptNumber, DEFAULT_RETRY_CONFIG);
        await updateMessageStatus(messageId, 'queued', {
          attempt_count: attemptNumber,
          last_error: response.error,
          last_error_at: new Date(),
          next_attempt_at: nextAttempt
        });
        
        console.log(`[retryQueue] Message ${messageId} scheduled for retry ${attemptNumber + 1} at ${nextAttempt}`);
      }
    }
    
    // Record breaker attempt
    await recordAttempt(response.success, response.httpCode);
    
  } catch (error) {
    console.error(`[retryQueue] Error processing retry for message ${messageId}:`, error);
    
    await recordWaAttempt(messageId, attemptNumber, {
      httpCode: 0,
      status: 'fail',
      latencyMs: 0,
      errorKind: 'system_error',
      responseExcerpt: error.message
    });
    
    await updateMessageStatus(messageId, 'queued', {
      attempt_count: attemptNumber,
      last_error: error.message,
      last_error_at: new Date()
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
 * Emit DLQ event for permanently failed message
 * @param {string} messageId - Message ID
 * @param {Object} message - Message record
 * @param {Object} lastResponse - Last response
 * @returns {Promise<void>}
 */
async function emitDLQEvent(messageId, message, lastResponse) {
  const dlqEvent = {
    type: 'message_permanently_failed',
    message_id: messageId,
    message: {
      id: message.id,
      to_msisdn: message.to_msisdn,
      body: message.body,
      template_name: message.template_name,
      template_language: message.template_language,
      template_components: message.template_components,
      attempt_count: message.attempt_count,
      last_error: message.last_error,
      last_error_at: message.last_error_at
    },
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
  
  console.log(`[retryQueue] DLQ event emitted for message ${messageId}`);
}

/**
 * Process all pending retries
 * @returns {Promise<void>}
 */
async function processPendingRetries() {
  const now = new Date();
  
  const result = await query(`
    SELECT * FROM messages 
    WHERE status = 'queued' 
    AND next_attempt_at <= $1
    ORDER BY next_attempt_at ASC
    LIMIT 10
  `, [now]);
  
  console.log(`[retryQueue] Found ${result.rows.length} pending retries`);
  
  for (const message of result.rows) {
    await processRetry(message);
  }
}

/**
 * Start retry queue processor
 * @param {number} intervalMs - Processing interval in milliseconds
 */
function startRetryProcessor(intervalMs = 5000) {
  console.log(`[retryQueue] Starting retry processor with ${intervalMs}ms interval`);
  
  setInterval(async () => {
    try {
      await processPendingRetries();
    } catch (error) {
      console.error('[retryQueue] Error in retry processor:', error);
    }
  }, intervalMs);
}

module.exports = {
  processRetry,
  processPendingRetries,
  startRetryProcessor,
  updateMessageStatus,
  recordWaAttempt,
  calculateNextAttempt,
  DEFAULT_RETRY_CONFIG
};
