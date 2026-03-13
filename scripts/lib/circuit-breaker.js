/**
 * Circuit Breaker for Anthropic API
 *
 * Prevents cascading failures when the API is down or rate-limited.
 * Three states: CLOSED (normal), OPEN (blocking), HALF_OPEN (testing).
 */

const STATES = {
  CLOSED: "closed",     // Normal operation — requests pass through
  OPEN: "open",         // API is down — requests fail fast without calling API
  HALF_OPEN: "half_open", // Testing — allow one request to see if API recovered
};

class CircuitBreaker {
  /**
   * @param {object} options
   * @param {number} options.failureThreshold - Failures before opening (default: 5)
   * @param {number} options.resetTimeout - Ms before trying again after opening (default: 30000)
   * @param {number} options.halfOpenMax - Max concurrent requests in half-open state (default: 1)
   */
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.halfOpenMax = options.halfOpenMax || 1;

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;
    this.successCount = 0;
    this.totalCalls = 0;
  }

  /**
   * Check if a request should be allowed
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canExecute() {
    this.totalCalls++;

    if (this.state === STATES.CLOSED) {
      return { allowed: true };
    }

    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeout) {
        // Transition to half-open: allow a test request
        this.state = STATES.HALF_OPEN;
        this.halfOpenAttempts = 0;
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Circuit breaker OPEN — API down, retry in ${Math.ceil((this.resetTimeout - elapsed) / 1000)}s`,
      };
    }

    if (this.state === STATES.HALF_OPEN) {
      if (this.halfOpenAttempts < this.halfOpenMax) {
        this.halfOpenAttempts++;
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Circuit breaker HALF_OPEN — waiting for test request result",
      };
    }

    return { allowed: true };
  }

  /**
   * Record a successful API call
   */
  recordSuccess() {
    this.successCount++;

    if (this.state === STATES.HALF_OPEN) {
      // API is back — close the circuit
      this.state = STATES.CLOSED;
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    } else if (this.state === STATES.CLOSED) {
      // Reset failure count on success
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  /**
   * Record a failed API call
   * @param {Error} error - The error that occurred
   */
  recordFailure(error) {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === STATES.HALF_OPEN) {
      // Test request failed — re-open the circuit
      this.state = STATES.OPEN;
      return;
    }

    if (this.state === STATES.CLOSED && this.failureCount >= this.failureThreshold) {
      this.state = STATES.OPEN;
    }
  }

  /**
   * Execute a function through the circuit breaker
   * @param {Function} fn - Async function to execute
   * @returns {Promise<*>} Result of the function
   */
  async execute(fn) {
    const check = this.canExecute();
    if (!check.allowed) {
      const err = new Error(check.reason);
      err.circuitBreakerOpen = true;
      throw err;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      // Only count API/network errors, not application-level errors
      if (this._isInfrastructureError(err)) {
        this.recordFailure(err);
      }
      throw err;
    }
  }

  /**
   * Check if an error is an infrastructure error (not application logic)
   * @param {Error} err
   * @returns {boolean}
   */
  _isInfrastructureError(err) {
    if (err.status === 429) return true;  // Rate limited
    if (err.status === 529) return true;  // Overloaded
    if (err.status >= 500) return true;   // Server error
    if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") return true;
    if (err.message?.includes("fetch failed")) return true;
    return false;
  }

  /**
   * Get circuit breaker stats
   * @returns {object}
   */
  getStats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalCalls: this.totalCalls,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
    };
  }

  /**
   * Force reset to closed state (manual override)
   */
  reset() {
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }
}

export { CircuitBreaker, STATES };
export default CircuitBreaker;
