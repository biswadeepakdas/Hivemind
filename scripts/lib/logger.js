/**
 * Structured Logging Module for Hivemind SESI
 *
 * Replaces raw console.log with leveled, structured logging.
 * Inspired by patterns from everything-claude-code.
 *
 * Levels: debug < info < warn < error
 * Set LOG_LEVEL env var to control verbosity (default: info)
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel = () => {
  const env = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LOG_LEVELS[env] ?? LOG_LEVELS.info;
};

function formatTimestamp() {
  const now = new Date();
  return now.toISOString();
}

function formatMessage(level, component, message, meta = {}) {
  const base = {
    timestamp: formatTimestamp(),
    level,
    component,
    message,
  };

  if (Object.keys(meta).length > 0) {
    base.meta = meta;
  }

  return base;
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= currentLevel();
}

function log(level, component, message, meta = {}) {
  if (!shouldLog(level)) return;

  const formatted = formatMessage(level, component, message, meta);

  if (process.env.LOG_FORMAT === "json") {
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(formatted) + "\n");
  } else {
    const prefix = `[${formatted.timestamp}] [${level.toUpperCase().padEnd(5)}] [${component}]`;
    const metaStr = Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
    const stream = level === "error" || level === "warn" ? console.error : console.log;
    stream(`${prefix} ${message}${metaStr}`);
  }
}

/**
 * Create a logger scoped to a component
 * @param {string} component - Component name (e.g., "SESIEngine", "PheromoneTrail")
 * @returns {object} Logger with debug, info, warn, error methods
 */
function createLogger(component) {
  return {
    debug: (msg, meta) => log("debug", component, msg, meta),
    info: (msg, meta) => log("info", component, msg, meta),
    warn: (msg, meta) => log("warn", component, msg, meta),
    error: (msg, meta) => log("error", component, msg, meta),
  };
}

export { createLogger, LOG_LEVELS };
export default createLogger;
