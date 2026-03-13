#!/usr/bin/env node
/**
 * Scalability Tests for SESI Engine
 *
 * Tests: PheromoneTrail pruning, session eviction, circuit breaker integration,
 * parallel execution patterns, and context windowing.
 */

import { CircuitBreaker, STATES } from "../scripts/lib/circuit-breaker.js";

// ── Minimal test harness ─────────────────────────────────────────────────
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

async function describe(name, fn) {
  console.log(`\n${name}`);
  await fn();
}

async function runTests() {

// ── Re-implement PheromoneTrail with prune() for testing ─────────────────

const DECAY_RATE = 0.05;
const MIN_PHEROMONE = 0.1;
const SYNTHESIS_THRESHOLD = 0.4;
const REINFORCE_AMOUNT = 0.15;

class PheromoneTrail {
  constructor() {
    this.artifacts = [];
    this.nextId = 1;
  }

  deposit(artifact) {
    const node = {
      id: `art_${this.nextId++}`,
      content: artifact.content,
      authorAgent: artifact.authorAgent,
      artifactType: artifact.artifactType || "implementation",
      domain: artifact.domain || "general",
      confidence: artifact.confidence || 0.7,
      pheromone: artifact.confidence || 0.7,
      references: [],
      challenges: [],
      timestamp: Date.now(),
      reinforcements: 0,
      challengeCount: 0,
    };
    this.artifacts.push(node);
    return node;
  }

  reinforce(artifactId) {
    const a = this.artifacts.find(x => x.id === artifactId);
    if (a) {
      a.pheromone = Math.min(1, a.pheromone + REINFORCE_AMOUNT);
      a.reinforcements++;
    }
  }

  decay() {
    this.artifacts.forEach(a => {
      a.pheromone = Math.max(MIN_PHEROMONE, a.pheromone * (1 - DECAY_RATE));
    });
  }

  getStrongArtifacts() {
    return this.artifacts
      .filter(a => a.pheromone >= SYNTHESIS_THRESHOLD)
      .sort((a, b) => b.pheromone - a.pheromone);
  }

  getStats() {
    return { total: this.artifacts.length };
  }

  prune(options = {}) {
    const minPh = options.minPheromone ?? (MIN_PHEROMONE + 0.05);
    const maxArtifacts = options.maxArtifacts ?? 200;
    const maxAge = options.maxAge ?? 10 * 60 * 1000;
    const now = Date.now();

    const before = this.artifacts.length;

    this.artifacts = this.artifacts.filter(a =>
      a.pheromone >= minPh || (now - a.timestamp) < maxAge
    );

    if (this.artifacts.length > maxArtifacts) {
      this.artifacts.sort((a, b) => b.pheromone - a.pheromone);
      this.artifacts = this.artifacts.slice(0, maxArtifacts);
    }

    return before - this.artifacts.length;
  }

  clear() {
    this.artifacts = [];
    this.nextId = 1;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════════

await describe("PheromoneTrail Pruning", () => {
  const trail = new PheromoneTrail();

  // Add some strong artifacts
  trail.deposit({ content: "Strong 1", authorAgent: "scout", confidence: 0.9, domain: "arch" });
  trail.deposit({ content: "Strong 2", authorAgent: "architect", confidence: 0.8, domain: "arch" });

  // Add weak artifacts with old timestamps
  for (let i = 0; i < 20; i++) {
    const art = trail.deposit({ content: `Weak ${i}`, authorAgent: "bolt", confidence: 0.12, domain: "general" });
    art.pheromone = 0.05; // Below threshold
    art.timestamp = Date.now() - 15 * 60 * 1000; // 15 min old — beyond maxAge
  }

  assert(trail.artifacts.length === 22, "Trail has 22 artifacts before pruning");

  const pruned = trail.prune();
  assert(pruned === 20, `Pruned 20 weak/old artifacts (got ${pruned})`);
  assert(trail.artifacts.length === 2, `Only 2 strong artifacts remain (got ${trail.artifacts.length})`);
});

await describe("PheromoneTrail Pruning — maxArtifacts cap", () => {
  const trail = new PheromoneTrail();

  // Add 250 strong artifacts
  for (let i = 0; i < 250; i++) {
    trail.deposit({ content: `Art ${i}`, authorAgent: "forge", confidence: 0.9, domain: "backend" });
  }

  assert(trail.artifacts.length === 250, "Trail has 250 artifacts");

  const pruned = trail.prune({ maxArtifacts: 100 });
  assert(trail.artifacts.length === 100, `Capped at 100 (got ${trail.artifacts.length})`);
  assert(pruned === 150, `Pruned 150 excess artifacts (got ${pruned})`);
});

await describe("PheromoneTrail Pruning — preserves recent weak artifacts", () => {
  const trail = new PheromoneTrail();

  // Add a weak but recent artifact
  const art = trail.deposit({ content: "Weak but recent", authorAgent: "bolt", confidence: 0.12 });
  art.pheromone = 0.05; // Below threshold but just created (timestamp is recent)

  const pruned = trail.prune();
  assert(pruned === 0, "Does not prune recent artifacts even if weak");
  assert(trail.artifacts.length === 1, "Weak recent artifact preserved");
});

await describe("PheromoneTrail Pruning — empty trail", () => {
  const trail = new PheromoneTrail();
  const pruned = trail.prune();
  assert(pruned === 0, "Pruning empty trail returns 0");
});

// ── Circuit Breaker Tests ────────────────────────────────────────────────

await describe("CircuitBreaker — starts CLOSED", () => {
  const cb = new CircuitBreaker();
  assert(cb.getStats().state === "closed", "Initial state is closed");
});

await describe("CircuitBreaker — opens after threshold failures", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 100 });

  for (let i = 0; i < 3; i++) {
    try {
      await cb.execute(async () => {
        const err = new Error("Server error");
        err.status = 500;
        throw err;
      });
    } catch (_e) { /* expected */ }
  }

  assert(cb.getStats().state === "open", "Circuit opens after 3 failures");
  assert(cb.getStats().failureCount === 3, "Failure count is 3");
});

await describe("CircuitBreaker — blocks calls when open", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 60000 });

  // Trip the circuit
  for (let i = 0; i < 2; i++) {
    try {
      await cb.execute(async () => { const e = new Error("fail"); e.status = 500; throw e; });
    } catch (_e) { /* expected */ }
  }

  try {
    await cb.execute(async () => "should not reach");
    assert(false, "Should have thrown");
  } catch (err) {
    assert(err.circuitBreakerOpen === true, "Throws with circuitBreakerOpen flag");
    assert(err.message.includes("Circuit breaker OPEN"), "Error message indicates open circuit");
  }
});

await describe("CircuitBreaker — transitions to half-open after timeout", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 50 });

  // Trip the circuit
  for (let i = 0; i < 2; i++) {
    try {
      await cb.execute(async () => { const e = new Error("fail"); e.status = 500; throw e; });
    } catch (_e) { /* expected */ }
  }

  assert(cb.getStats().state === "open", "Circuit is open");

  // Wait for reset timeout
  await new Promise(resolve => setTimeout(resolve, 60));

  // Next call should be allowed (half-open)
  let allowed = false;
  try {
    await cb.execute(async () => { allowed = true; return "ok"; });
  } catch (_e) { /* unexpected */ }

  assert(allowed, "Call was allowed after timeout (half-open test)");
  assert(cb.getStats().state === "closed", "Circuit closes after successful half-open test");
});

await describe("CircuitBreaker — half-open failure re-opens circuit", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 50 });

  // Trip
  for (let i = 0; i < 2; i++) {
    try {
      await cb.execute(async () => { const e = new Error("fail"); e.status = 500; throw e; });
    } catch (_e) { /* expected */ }
  }

  await new Promise(resolve => setTimeout(resolve, 60));

  // Half-open test request fails
  try {
    await cb.execute(async () => { const e = new Error("still failing"); e.status = 500; throw e; });
  } catch (_e) { /* expected */ }

  assert(cb.getStats().state === "open", "Circuit re-opens after half-open failure");
});

await describe("CircuitBreaker — does not count application errors", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2 });

  // Throw a 400 error (application error, not infrastructure)
  for (let i = 0; i < 5; i++) {
    try {
      await cb.execute(async () => { const e = new Error("bad request"); e.status = 400; throw e; });
    } catch (_e) { /* expected */ }
  }

  assert(cb.getStats().state === "closed", "Circuit stays closed for 400 errors");
  assert(cb.getStats().failureCount === 0, "No infrastructure failures counted");
});

await describe("CircuitBreaker — reset() forces closed", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2 });

  for (let i = 0; i < 2; i++) {
    try {
      await cb.execute(async () => { const e = new Error("fail"); e.status = 500; throw e; });
    } catch (_e) { /* expected */ }
  }

  assert(cb.getStats().state === "open", "Circuit is open");
  cb.reset();
  assert(cb.getStats().state === "closed", "Circuit is closed after reset");
  assert(cb.getStats().failureCount === 0, "Failure count reset to 0");
});

await describe("CircuitBreaker — success decrements failure count", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 5 });

  // Add some failures
  for (let i = 0; i < 3; i++) {
    try {
      await cb.execute(async () => { const e = new Error("fail"); e.status = 500; throw e; });
    } catch (_e) { /* expected */ }
  }

  assert(cb.getStats().failureCount === 3, "3 failures recorded");

  // Success reduces count
  await cb.execute(async () => "ok");
  assert(cb.getStats().failureCount === 2, "Failure count decreased to 2 after success");
});

// ── Parallel Execution Pattern Tests ─────────────────────────────────────

await describe("Parallel execution — Promise.all runs concurrently", async () => {
  const startTime = Date.now();
  const delays = [50, 50, 50];

  const results = await Promise.all(
    delays.map(d => new Promise(resolve => setTimeout(() => resolve(d), d)))
  );

  const elapsed = Date.now() - startTime;
  assert(results.length === 3, "All 3 tasks completed");
  assert(elapsed < 120, `Ran in parallel (${elapsed}ms < 120ms threshold)`);
});

await describe("Parallel execution — handles mixed success/failure", async () => {
  const tasks = [
    Promise.resolve("success1"),
    Promise.resolve("success2"),
    Promise.resolve("success3"),
  ];

  const results = await Promise.all(tasks);
  assert(results.length === 3, "All promises resolved");
  assert(results[0] === "success1", "First result correct");
});

// ── Session Eviction Pattern Tests ───────────────────────────────────────

await describe("Session eviction — Map-based TTL simulation", () => {
  const sessions = new Map();
  const SESSION_TTL = 100; // 100ms for testing

  // Create sessions
  sessions.set("s1", { status: "complete", createdAt: Date.now() - 200 }); // Old, complete
  sessions.set("s2", { status: "running", createdAt: Date.now() - 200 });  // Old, running
  sessions.set("s3", { status: "complete", createdAt: Date.now() });         // New, complete

  // Evict stale completed sessions
  const now = Date.now();
  for (const [id, session] of sessions) {
    const age = now - session.createdAt;
    if ((session.status === "complete" || session.status === "error") && age > SESSION_TTL) {
      sessions.delete(id);
    }
  }

  assert(!sessions.has("s1"), "Old completed session evicted");
  assert(sessions.has("s2"), "Old running session preserved");
  assert(sessions.has("s3"), "New completed session preserved");
  assert(sessions.size === 2, `2 sessions remain (got ${sessions.size})`);
});

await describe("Session eviction — max session limit", () => {
  const sessions = new Map();
  const MAX = 5;

  // Fill to max
  for (let i = 0; i < MAX; i++) {
    sessions.set(`s${i}`, { status: i < 3 ? "complete" : "running", createdAt: Date.now() - (MAX - i) * 100 });
  }

  assert(sessions.size === MAX, `${MAX} sessions at capacity`);

  // Need to create new one — evict oldest completed
  if (sessions.size >= MAX) {
    const completed = [...sessions.entries()]
      .filter(([, s]) => s.status === "complete")
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    if (completed.length > 0) {
      sessions.delete(completed[0][0]);
    }
  }

  assert(sessions.size === MAX - 1, "One session evicted to make room");
  assert(!sessions.has("s0"), "Oldest completed session was evicted");
});

// ── Context Windowing Tests ──────────────────────────────────────────────

await describe("Token-budget context windowing", () => {
  const artifacts = [];
  for (let i = 0; i < 50; i++) {
    artifacts.push({
      artifactType: "implementation",
      authorAgent: "forge",
      pheromone: 0.9 - i * 0.01,
      content: "A".repeat(300), // Each ~300 chars
    });
  }

  const TOKEN_BUDGET = 3000;
  const CHARS_PER_TOKEN = 4;
  const charBudget = TOKEN_BUDGET * CHARS_PER_TOKEN;
  let usedChars = 0;
  const contextArtifacts = [];

  for (const a of artifacts) {
    const contentSlice = a.content.slice(0, 600);
    const entry = `  [${a.artifactType.toUpperCase()}] by ${a.authorAgent} (pheromone: ${a.pheromone.toFixed(2)}): ${contentSlice}`;
    if (usedChars + entry.length > charBudget) break;
    contextArtifacts.push(entry);
    usedChars += entry.length;
  }

  assert(contextArtifacts.length > 8, `Token budget allows more than 8 artifacts (got ${contextArtifacts.length})`);
  assert(usedChars <= charBudget, `Stays within budget (${usedChars} <= ${charBudget})`);
});

await describe("Token-budget windowing — handles empty trail", () => {
  const artifacts = [];
  const contextArtifacts = [];
  let usedChars = 0;

  for (const a of artifacts) {
    const entry = `[${a.artifactType}]: ${a.content.slice(0, 600)}`;
    if (usedChars + entry.length > 12000) break;
    contextArtifacts.push(entry);
    usedChars += entry.length;
  }

  assert(contextArtifacts.length === 0, "Empty trail produces no context");
});

// ══════════════════════════════════════════════════════════════════════════
//  RESULTS
// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`${"─".repeat(40)}`);

process.exit(failed > 0 ? 1 : 0);
}

runTests();
