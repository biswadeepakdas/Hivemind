/**
 * Input Validation and Security Middleware for Hivemind SESI
 *
 * Validates and sanitizes all API inputs to prevent injection attacks.
 * Inspired by security patterns from everything-claude-code.
 */

/**
 * Validate task text input
 * @param {string} task - Task text to validate
 * @returns {{ valid: boolean, error?: string, sanitized?: string }}
 */
function validateTaskInput(task) {
  if (!task || typeof task !== "string") {
    return { valid: false, error: "task must be a non-empty string" };
  }

  const trimmed = task.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "task cannot be empty" };
  }

  if (trimmed.length > 10000) {
    return { valid: false, error: "task exceeds maximum length of 10000 characters" };
  }

  return { valid: true, sanitized: trimmed };
}

/**
 * Validate session ID format
 * @param {string} id - Session ID to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSessionId(id) {
  if (!id || typeof id !== "string") {
    return { valid: false, error: "session ID is required" };
  }

  // Session IDs are 8 lowercase hex chars (randomUUID().slice(0, 8))
  if (!/^[a-f0-9]{8}$/.test(id)) {
    return { valid: false, error: "invalid session ID format" };
  }

  return { valid: true };
}

/**
 * Express middleware for rate limiting (simple in-memory)
 * @param {object} options - Rate limit options
 * @param {number} options.windowMs - Time window in ms (default: 60000)
 * @param {number} options.maxRequests - Max requests per window (default: 60)
 * @returns {Function} Express middleware
 */
function rateLimit(options = {}) {
  const { windowMs = 60000, maxRequests = 60 } = options;
  const requests = new Map();

  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of requests) {
      if (now - data.windowStart > windowMs) {
        requests.delete(key);
      }
    }
  }, windowMs);

  return (req, res, next) => {
    const key = req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();

    if (!requests.has(key) || now - requests.get(key).windowStart > windowMs) {
      requests.set(key, { windowStart: now, count: 1 });
      return next();
    }

    const data = requests.get(key);
    data.count++;

    if (data.count > maxRequests) {
      return res.status(429).json({
        error: "Too many requests",
        retryAfter: Math.ceil((data.windowStart + windowMs - now) / 1000),
      });
    }

    next();
  };
}

/**
 * Express middleware to validate that required env vars are present
 * @returns {Function} Express middleware
 */
function requireApiKey() {
  return (req, res, next) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: "Server misconfigured: ANTHROPIC_API_KEY not set",
      });
    }
    next();
  };
}

/**
 * Express error handler middleware
 * @returns {Function} Express error handler
 */
function errorHandler() {
  return (err, req, res, _next) => {
    // Don't leak internal error details to clients
    const status = err.status || err.statusCode || 500;
    const message = status >= 500 ? "Internal server error" : err.message;

    if (status >= 500) {
      console.error(`[ErrorHandler] ${err.message}`, err.stack);
    }

    res.status(status).json({ error: message });
  };
}

export {
  validateTaskInput,
  validateSessionId,
  rateLimit,
  requireApiKey,
  errorHandler,
};
