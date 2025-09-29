/**
 * WhatsApp Bridge HTTP client with retry logic
 * Handles HTTP requests to the WA Bridge with exponential backoff and jitter
 */

const fetch = require('node-fetch');

/**
 * @typedef {Object} WaBridgeConfig
 * @property {string} baseUrl - Bridge base URL
 * @property {string} apiKey - Bridge API key
 * @property {number} timeout - Request timeout in ms
 * @property {number} maxAttempts - Maximum retry attempts
 * @property {string[]} retrySchedule - Retry delays (e.g., ["1s", "4s", "15s"])
 * @property {number} jitterMs - Jitter range in milliseconds
 */

/**
 * @typedef {Object} WaBridgeResponse
 * @property {boolean} success - Whether the request succeeded
 * @property {number} httpCode - HTTP status code
 * @property {Object} data - Response data
 * @property {string} error - Error message if failed
 * @property {number} latencyMs - Request latency in milliseconds
 * @property {string} responseExcerpt - Short excerpt of response
 */

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  timeout: 10000,
  maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '4'),
  retrySchedule: (process.env.RETRY_SCHEDULE || '1s,4s,15s,60s').split(','),
  jitterMs: parseInt(process.env.RETRY_JITTER_MS || '200'),
  baseUrl: process.env.BRIDGE_BASE_URL || 'https://wa.woosh.ai',
  apiKey: process.env.BRIDGE_API_KEY || ''
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
 * Check if HTTP status code should trigger a retry
 * @param {number} statusCode - HTTP status code
 * @returns {boolean} Whether to retry
 */
function shouldRetry(statusCode) {
  // Retry on timeouts, 5xx errors, and rate limiting
  return statusCode >= 500 || statusCode === 429 || statusCode === 408;
}

/**
 * Get error kind for logging
 * @param {number} statusCode - HTTP status code
 * @param {Error} error - Error object
 * @returns {string} Error kind
 */
function getErrorKind(statusCode, error) {
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
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
 * Make HTTP request to WA Bridge
 * @param {string} endpoint - API endpoint
 * @param {Object} payload - Request payload
 * @param {WaBridgeConfig} config - Configuration
 * @returns {Promise<WaBridgeResponse>} Response
 */
async function makeRequest(endpoint, payload, config = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const url = `${finalConfig.baseUrl.replace(/\/+$/, '')}${endpoint}`;
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalConfig.apiKey}`,
        'X-Api-Key': finalConfig.apiKey
      },
      body: JSON.stringify(payload),
      timeout: finalConfig.timeout
    });
    
    const latencyMs = Date.now() - startTime;
    const responseText = await response.text();
    
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = { raw: responseText };
    }
    
    return {
      success: response.ok,
      httpCode: response.status,
      data,
      error: response.ok ? null : `HTTP ${response.status}`,
      latencyMs,
      responseExcerpt: responseText.slice(0, 200)
    };
    
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      success: false,
      httpCode: 0,
      data: null,
      error: error.message,
      latencyMs,
      responseExcerpt: error.message.slice(0, 200)
    };
  }
}

/**
 * Send message with retry logic
 * @param {Object} message - Message to send
 * @param {WaBridgeConfig} config - Configuration
 * @returns {Promise<WaBridgeResponse>} Final response
 */
async function sendMessage(message, config = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const endpoint = '/v1/send';
  
  // Force error for development testing
  if (process.env.DEV_FORCE_BRIDGE_ERROR && process.env.NODE_ENV !== 'production') {
    const errorType = process.env.DEV_FORCE_BRIDGE_ERROR;
    if (errorType === 'timeout') {
      throw new Error('Simulated timeout');
    }
    if (errorType === '500') {
      return {
        success: false,
        httpCode: 500,
        data: { error: 'Simulated server error' },
        error: 'Simulated server error',
        latencyMs: 100,
        responseExcerpt: 'Simulated server error'
      };
    }
  }
  
  let lastResponse;
  
  for (let attempt = 1; attempt <= finalConfig.maxAttempts; attempt++) {
    const response = await makeRequest(endpoint, message, finalConfig);
    lastResponse = response;
    
    // Success - return immediately
    if (response.success) {
      return response;
    }
    
    // Don't retry on client errors (4xx except 429)
    if (response.httpCode >= 400 && response.httpCode < 500 && response.httpCode !== 429) {
      return response;
    }
    
    // Don't retry on last attempt
    if (attempt === finalConfig.maxAttempts) {
      return response;
    }
    
    // Don't retry if not a retryable error
    if (!shouldRetry(response.httpCode)) {
      return response;
    }
    
    // Calculate delay with jitter
    const delayIndex = Math.min(attempt - 1, finalConfig.retrySchedule.length - 1);
    const baseDelay = parseDelay(finalConfig.retrySchedule[delayIndex]);
    const jitteredDelay = addJitter(baseDelay, finalConfig.jitterMs);
    
    console.log(`[waBridge] Attempt ${attempt} failed (${response.httpCode}), retrying in ${Math.round(jitteredDelay)}ms`);
    
    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, jitteredDelay));
  }
  
  return lastResponse;
}

/**
 * Send template message with retry logic
 * @param {Object} template - Template message to send
 * @param {WaBridgeConfig} config - Configuration
 * @returns {Promise<WaBridgeResponse>} Final response
 */
async function sendTemplate(template, config = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const endpoint = '/v1/send';
  
  return sendMessage(template, finalConfig);
}

module.exports = {
  sendMessage,
  sendTemplate,
  makeRequest,
  shouldRetry,
  getErrorKind,
  DEFAULT_CONFIG
};
