/**
 * Cost Tracking and Token Estimation for Hivemind SESI
 *
 * Tracks API usage costs per session and globally.
 * Inspired by cost-tracker from everything-claude-code.
 */

import fs from "fs";
import path from "path";

// Approximate per-1M-token rates for Claude models
const MODEL_PRICING = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  // Fallback
  default: { input: 3.0, output: 15.0 },
};

class CostTracker {
  constructor(options = {}) {
    this.metricsDir = options.metricsDir || path.join(process.cwd(), ".hivemind", "metrics");
    this.sessions = new Map();
    this.globalStats = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalCalls: 0,
    };
  }

  /**
   * Estimate cost for a given model and token counts
   * @param {string} model - Model ID
   * @param {number} inputTokens - Input token count
   * @param {number} outputTokens - Output token count
   * @returns {number} Estimated cost in USD
   */
  estimateCost(model, inputTokens, outputTokens) {
    const rates = MODEL_PRICING[model] || MODEL_PRICING.default;
    const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
    return Math.round(cost * 1e6) / 1e6;
  }

  /**
   * Estimate token count from text length (rough approximation)
   * @param {string} text - Text to estimate
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Record an API call
   * @param {string} sessionId - Session identifier
   * @param {object} params - Call parameters
   * @param {string} params.model - Model used
   * @param {string} params.agentId - Agent that made the call
   * @param {string} params.domain - Domain being processed
   * @param {number} params.inputTokens - Input token count
   * @param {number} params.outputTokens - Output token count
   */
  recordCall(sessionId, { model, agentId, domain, inputTokens, outputTokens }) {
    const cost = this.estimateCost(model, inputTokens, outputTokens);

    // Update session stats
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        breakdown: [],
      });
    }

    const session = this.sessions.get(sessionId);
    session.calls++;
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.cost += cost;
    session.breakdown.push({
      timestamp: new Date().toISOString(),
      agentId,
      domain,
      model,
      inputTokens,
      outputTokens,
      cost,
    });

    // Update global stats
    this.globalStats.totalInputTokens += inputTokens;
    this.globalStats.totalOutputTokens += outputTokens;
    this.globalStats.totalCost += cost;
    this.globalStats.totalCalls++;

    return cost;
  }

  /**
   * Get session usage summary
   * @param {string} sessionId - Session identifier
   * @returns {object|null} Session cost summary
   */
  getSessionStats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      calls: session.calls,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      totalTokens: session.inputTokens + session.outputTokens,
      estimatedCost: Math.round(session.cost * 1e6) / 1e6,
      breakdown: session.breakdown,
    };
  }

  /**
   * Get global usage summary
   * @returns {object} Global cost summary
   */
  getGlobalStats() {
    return {
      totalCalls: this.globalStats.totalCalls,
      totalInputTokens: this.globalStats.totalInputTokens,
      totalOutputTokens: this.globalStats.totalOutputTokens,
      totalTokens: this.globalStats.totalInputTokens + this.globalStats.totalOutputTokens,
      estimatedTotalCost: Math.round(this.globalStats.totalCost * 1e6) / 1e6,
      activeSessions: this.sessions.size,
    };
  }

  /**
   * Persist metrics to disk (JSONL format)
   * @param {string} sessionId - Session to persist
   */
  persistMetrics(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.breakdown.length === 0) return;

    try {
      if (!fs.existsSync(this.metricsDir)) {
        fs.mkdirSync(this.metricsDir, { recursive: true });
      }

      const metricsFile = path.join(this.metricsDir, "costs.jsonl");
      const rows = session.breakdown.map(entry =>
        JSON.stringify({ sessionId, ...entry }) + "\n"
      ).join("");

      fs.appendFileSync(metricsFile, rows, "utf8");
    } catch {
      // Non-blocking — don't fail on metrics persistence
    }
  }
}

export { CostTracker, MODEL_PRICING };
export default CostTracker;
