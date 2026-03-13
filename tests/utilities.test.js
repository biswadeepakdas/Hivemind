#!/usr/bin/env node
/**
 * Unit Tests for Utility Modules
 *
 * Tests cost-tracker, retry, persistence, and validation modules.
 */

import { CostTracker, MODEL_PRICING } from "../scripts/lib/cost-tracker.js";
import { withRetry, sleep, defaultShouldRetry } from "../scripts/lib/retry.js";
import { validateTaskInput, validateSessionId } from "../scripts/lib/validate-input.js";
import { TrustPersistence } from "../scripts/lib/persistence.js";
import { createLogger } from "../scripts/lib/logger.js";
import fs from "fs";
import path from "path";
import os from "os";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ── CostTracker Tests ────────────────────────────────────────────────────

describe("CostTracker", () => {
  describe("estimateCost", () => {
    const tracker = new CostTracker();

    const cost = tracker.estimateCost("claude-sonnet-4-20250514", 1000, 500);
    assert(cost > 0, "calculates positive cost");
    assert(cost < 1, "reasonable cost for small token counts");

    const cost2 = tracker.estimateCost("claude-sonnet-4-20250514", 1000000, 500000);
    assert(cost2 === 3.0 + 7.5, "correctly calculates 1M input + 500K output for Sonnet");
  });

  describe("estimateTokens", () => {
    const tracker = new CostTracker();
    assert(tracker.estimateTokens("hello world") > 0, "estimates tokens for text");
    assert(tracker.estimateTokens("") === 0, "returns 0 for empty text");
    assert(tracker.estimateTokens(null) === 0, "returns 0 for null");
  });

  describe("recordCall", () => {
    const tracker = new CostTracker();
    const cost = tracker.recordCall("session1", {
      model: "claude-sonnet-4-20250514",
      agentId: "researcher",
      domain: "backend",
      inputTokens: 500,
      outputTokens: 200,
    });

    assert(cost > 0, "returns positive cost");

    const stats = tracker.getSessionStats("session1");
    assert(stats.calls === 1, "tracks call count");
    assert(stats.inputTokens === 500, "tracks input tokens");
    assert(stats.outputTokens === 200, "tracks output tokens");
    assert(stats.breakdown.length === 1, "stores call breakdown");
  });

  describe("getGlobalStats", () => {
    const tracker = new CostTracker();
    tracker.recordCall("s1", { model: "claude-sonnet-4-20250514", agentId: "a", domain: "d", inputTokens: 100, outputTokens: 50 });
    tracker.recordCall("s2", { model: "claude-sonnet-4-20250514", agentId: "b", domain: "d", inputTokens: 200, outputTokens: 100 });

    const global = tracker.getGlobalStats();
    assert(global.totalCalls === 2, "counts all calls globally");
    assert(global.totalInputTokens === 300, "sums input tokens globally");
    assert(global.activeSessions === 2, "counts active sessions");
  });
});

// ── Retry Tests ──────────────────────────────────────────────────────────

describe("Retry Logic", () => {
  describe("withRetry success", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      return "success";
    });
    assert(result === "success", "returns result on success");
    assert(callCount === 1, "calls function once on success");
  });

  describe("withRetry with retries", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      if (callCount < 3) {
        const err = new Error("rate limited");
        err.status = 429;
        throw err;
      }
      return "eventual success";
    }, { maxRetries: 3, baseDelay: 10 });
    assert(result === "eventual success", "succeeds after retries");
    assert(callCount === 3, "retries correct number of times");
  });

  describe("withRetry exhaustion", async () => {
    try {
      await withRetry(async () => {
        const err = new Error("always fails");
        err.status = 500;
        throw err;
      }, { maxRetries: 2, baseDelay: 10 });
      assert(false, "should have thrown");
    } catch (err) {
      assert(err.message === "always fails", "throws final error after exhausting retries");
    }
  });

  describe("defaultShouldRetry", () => {
    assert(defaultShouldRetry({ status: 429 }), "retries rate limit errors");
    assert(defaultShouldRetry({ status: 500 }), "retries server errors");
    assert(defaultShouldRetry({ status: 529 }), "retries overloaded errors");
    assert(defaultShouldRetry({ code: "ECONNRESET" }), "retries network reset");
    assert(!defaultShouldRetry({ status: 400 }), "does not retry client errors");
    assert(!defaultShouldRetry({ status: 401 }), "does not retry auth errors");
  });
});

// ── Validation Tests ─────────────────────────────────────────────────────

describe("Input Validation", () => {
  describe("validateTaskInput", () => {
    const valid = validateTaskInput("Build a REST API");
    assert(valid.valid === true, "accepts valid task");
    assert(valid.sanitized === "Build a REST API", "returns sanitized text");

    const empty = validateTaskInput("");
    assert(empty.valid === false, "rejects empty string");

    const nullInput = validateTaskInput(null);
    assert(nullInput.valid === false, "rejects null");

    const spaces = validateTaskInput("   Build API   ");
    assert(spaces.valid === true, "accepts trimmed task");
    assert(spaces.sanitized === "Build API", "trims whitespace");

    const long = validateTaskInput("x".repeat(10001));
    assert(long.valid === false, "rejects overly long task");
  });

  describe("validateSessionId", () => {
    const valid = validateSessionId("a1b2c3d4");
    assert(valid.valid === true, "accepts valid session ID");

    const invalid = validateSessionId("'; DROP TABLE;--");
    assert(invalid.valid === false, "rejects SQL injection attempt");

    const empty = validateSessionId("");
    assert(empty.valid === false, "rejects empty ID");

    const nullId = validateSessionId(null);
    assert(nullId.valid === false, "rejects null ID");
  });
});

// ── Persistence Tests ────────────────────────────────────────────────────

describe("TrustPersistence", () => {
  const tmpDir = path.join(os.tmpdir(), `hivemind-test-${Date.now()}`);

  describe("save and load trust model", () => {
    const persistence = new TrustPersistence({ dataDir: tmpDir });
    const trustData = {
      agent1: { frontend: { alpha: 5, beta: 2 } },
      agent2: { backend: { alpha: 3, beta: 1 } },
    };

    const saved = persistence.saveTrustModel(trustData);
    assert(saved === true, "saves trust model successfully");

    const loaded = persistence.loadTrustModel();
    assert(loaded !== null, "loads trust model successfully");
    assert(loaded.agent1.frontend.alpha === 5, "preserves alpha values");
    assert(loaded.agent2.backend.beta === 1, "preserves beta values");
  });

  describe("save session", () => {
    const persistence = new TrustPersistence({ dataDir: tmpDir });
    const saved = persistence.saveSession("test123", {
      task: "Build API",
      status: "complete",
      metrics: { agentCalls: 3 },
    });
    assert(saved === true, "saves session successfully");

    const sessions = persistence.listSessions();
    assert(sessions.length >= 1, "lists saved sessions");
    assert(sessions[0].task === "Build API", "session has correct task");
  });

  describe("load nonexistent trust model", () => {
    const persistence = new TrustPersistence({ dataDir: path.join(os.tmpdir(), "nonexistent-dir-xyz") });
    const loaded = persistence.loadTrustModel();
    assert(loaded === null, "returns null for missing file");
  });

  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ── Logger Tests ─────────────────────────────────────────────────────────

describe("Logger", () => {
  describe("createLogger", () => {
    const logger = createLogger("TestComponent");
    assert(typeof logger.debug === "function", "has debug method");
    assert(typeof logger.info === "function", "has info method");
    assert(typeof logger.warn === "function", "has warn method");
    assert(typeof logger.error === "function", "has error method");
  });
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
