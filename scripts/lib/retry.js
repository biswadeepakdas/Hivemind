/**
 * Retry Logic with Exponential Backoff for API Calls
 *
 * Provides resilient API calling with configurable retry behavior.
 * Inspired by patterns from everything-claude-code.
 */

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 16000)
 * @param {Function} options.shouldRetry - Function to determine if error is retryable (default: checks for rate limit/network errors)
 * @param {Function} options.onRetry - Callback on each retry (receives error, attempt, delay)
 * @returns {Promise<*>} Result of the function
 */
async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 16000,
    shouldRetry = defaultShouldRetry,
    onRetry = null,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * (0.5 + Math.random() * 0.5);

      if (onRetry) {
        onRetry(err, attempt + 1, Math.round(jitter));
      }

      await sleep(Math.round(jitter));
    }
  }

  throw lastError;
}

/**
 * Default retry condition — retries on rate limits, network errors, and 5xx errors
 * @param {Error} err - The error to check
 * @returns {boolean} Whether the error is retryable
 */
function defaultShouldRetry(err) {
  // Authentication errors — fail immediately, retrying won't help
  if (err.status === 401 || err.status === 403) return false;

  // Rate limit errors
  if (err.status === 429) return true;

  // Server errors
  if (err.status >= 500 && err.status < 600) return true;

  // Network errors
  if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") return true;
  if (err.message?.includes("fetch failed") || err.message?.includes("network")) return true;

  // Anthropic overloaded
  if (err.status === 529) return true;

  return false;
}

export { withRetry, sleep, defaultShouldRetry };
export default withRetry;
