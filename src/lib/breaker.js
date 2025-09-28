/**
 * Circuit breaker for WA Bridge requests
 * Implements circuit breaker pattern to prevent cascading failures
 */

const { query } = require('../db');

/**
 * @typedef {Object} BreakerConfig
 * @property {number} failThreshold - Number of failures before opening
 * @property {number} halfOpenAfter - Time in seconds before half-open
 * @property {number} successThreshold - Successes needed to close from half-open
 */

/**
 * Default breaker configuration
 */
const DEFAULT_BREAKER_CONFIG = {
  failThreshold: parseInt(process.env.BREAKER_FAIL_THRESHOLD || '8'),
  halfOpenAfter: parseInt(process.env.BREAKER_HALF_OPEN_AFTER || '60'),
  successThreshold: 3
};

/**
 * Breaker states
 */
const BREAKER_STATES = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open'
};

/**
 * Get current breaker state from database
 * @returns {Promise<string>} Current breaker state
 */
async function getBreakerState() {
  try {
    const result = await query(`
      SELECT state, opened_at, failure_count, success_count
      FROM breaker_state 
      WHERE service = 'wa_bridge'
      ORDER BY updated_at DESC 
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return BREAKER_STATES.CLOSED;
    }
    
    const state = result.rows[0];
    const now = new Date();
    
    // Check if we should transition from open to half-open
    if (state.state === BREAKER_STATES.OPEN) {
      const openedAt = new Date(state.opened_at);
      const timeSinceOpened = (now - openedAt) / 1000; // seconds
      
      if (timeSinceOpened >= DEFAULT_BREAKER_CONFIG.halfOpenAfter) {
        await updateBreakerState(BREAKER_STATES.HALF_OPEN, 0, 0);
        return BREAKER_STATES.HALF_OPEN;
      }
    }
    
    return state.state;
  } catch (error) {
    console.error('[breaker] Error getting breaker state:', error);
    return BREAKER_STATES.CLOSED;
  }
}

/**
 * Update breaker state in database
 * @param {string} state - New breaker state
 * @param {number} failureCount - Current failure count
 * @param {number} successCount - Current success count
 * @returns {Promise<void>}
 */
async function updateBreakerState(state, failureCount = 0, successCount = 0) {
  try {
    await query(`
      INSERT INTO breaker_state (service, state, failure_count, success_count, opened_at, updated_at)
      VALUES ('wa_bridge', $1, $2, $3, $4, now())
      ON CONFLICT (service) DO UPDATE SET
        state = EXCLUDED.state,
        failure_count = EXCLUDED.failure_count,
        success_count = EXCLUDED.success_count,
        opened_at = EXCLUDED.opened_at,
        updated_at = now()
    `, [
      state,
      failureCount,
      successCount,
      state === BREAKER_STATES.OPEN ? new Date() : null
    ]);
    
    console.log(`[breaker] State updated to ${state} (failures: ${failureCount}, successes: ${successCount})`);
  } catch (error) {
    console.error('[breaker] Error updating breaker state:', error);
  }
}

/**
 * Record a breaker attempt
 * @param {boolean} success - Whether the attempt was successful
 * @param {number} httpCode - HTTP status code
 * @returns {Promise<void>}
 */
async function recordAttempt(success, httpCode) {
  try {
    const currentState = await getBreakerState();
    
    if (currentState === BREAKER_STATES.CLOSED) {
      if (success) {
        // Reset failure count on success
        await updateBreakerState(BREAKER_STATES.CLOSED, 0, 0);
      } else {
        // Increment failure count
        const result = await query(`
          SELECT failure_count FROM breaker_state 
          WHERE service = 'wa_bridge' 
          ORDER BY updated_at DESC LIMIT 1
        `);
        
        const currentFailures = result.rows.length > 0 ? result.rows[0].failure_count : 0;
        const newFailureCount = currentFailures + 1;
        
        if (newFailureCount >= DEFAULT_BREAKER_CONFIG.failThreshold) {
          await updateBreakerState(BREAKER_STATES.OPEN, newFailureCount, 0);
          console.log(`[breaker] Circuit opened after ${newFailureCount} failures`);
        } else {
          await updateBreakerState(BREAKER_STATES.CLOSED, newFailureCount, 0);
        }
      }
    } else if (currentState === BREAKER_STATES.HALF_OPEN) {
      if (success) {
        // Increment success count in half-open
        const result = await query(`
          SELECT success_count FROM breaker_state 
          WHERE service = 'wa_bridge' 
          ORDER BY updated_at DESC LIMIT 1
        `);
        
        const currentSuccesses = result.rows.length > 0 ? result.rows[0].success_count : 0;
        const newSuccessCount = currentSuccesses + 1;
        
        if (newSuccessCount >= DEFAULT_BREAKER_CONFIG.successThreshold) {
          await updateBreakerState(BREAKER_STATES.CLOSED, 0, 0);
          console.log(`[breaker] Circuit closed after ${newSuccessCount} successes`);
        } else {
          await updateBreakerState(BREAKER_STATES.HALF_OPEN, 0, newSuccessCount);
        }
      } else {
        // Failed in half-open, go back to open
        await updateBreakerState(BREAKER_STATES.OPEN, 1, 0);
        console.log(`[breaker] Circuit reopened after failure in half-open state`);
      }
    }
    // If state is OPEN, we don't record attempts (they're blocked)
    
  } catch (error) {
    console.error('[breaker] Error recording attempt:', error);
  }
}

/**
 * Check if request should be allowed through breaker
 * @returns {Promise<boolean>} Whether request is allowed
 */
async function isRequestAllowed() {
  const state = await getBreakerState();
  return state !== BREAKER_STATES.OPEN;
}

/**
 * Get breaker statistics
 * @returns {Promise<Object>} Breaker statistics
 */
async function getBreakerStats() {
  try {
    const result = await query(`
      SELECT state, failure_count, success_count, opened_at, updated_at
      FROM breaker_state 
      WHERE service = 'wa_bridge'
      ORDER BY updated_at DESC 
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return {
        state: BREAKER_STATES.CLOSED,
        failureCount: 0,
        successCount: 0,
        openedAt: null,
        updatedAt: null
      };
    }
    
    const row = result.rows[0];
    return {
      state: row.state,
      failureCount: parseInt(row.failure_count),
      successCount: parseInt(row.success_count),
      openedAt: row.opened_at,
      updatedAt: row.updated_at
    };
  } catch (error) {
    console.error('[breaker] Error getting breaker stats:', error);
    return {
      state: BREAKER_STATES.CLOSED,
      failureCount: 0,
      successCount: 0,
      openedAt: null,
      updatedAt: null
    };
  }
}

/**
 * Reset breaker state (for testing/admin)
 * @returns {Promise<void>}
 */
async function resetBreaker() {
  await updateBreakerState(BREAKER_STATES.CLOSED, 0, 0);
  console.log('[breaker] Breaker state reset to closed');
}

/**
 * Force breaker open (for testing/admin)
 * @returns {Promise<void>}
 */
async function forceOpenBreaker() {
  await updateBreakerState(BREAKER_STATES.OPEN, DEFAULT_BREAKER_CONFIG.failThreshold, 0);
  console.log('[breaker] Breaker forced open');
}

/**
 * Get breaker configuration
 * @returns {Object} Breaker configuration
 */
function getBreakerConfig() {
  return { ...DEFAULT_BREAKER_CONFIG };
}

module.exports = {
  getBreakerState,
  recordAttempt,
  isRequestAllowed,
  getBreakerStats,
  resetBreaker,
  forceOpenBreaker,
  getBreakerConfig,
  BREAKER_STATES,
  DEFAULT_BREAKER_CONFIG
};
