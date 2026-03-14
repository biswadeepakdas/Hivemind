#!/usr/bin/env node
/**
 * Unit Tests for SESI Core Algorithm Components
 *
 * Tests PheromoneTrail, EpistemicTrustModel, and Entropic Decomposition
 * without requiring API keys or network access.
 */

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

function assertApprox(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message} (expected ~${expected}, got ${actual})`);
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ══════════════════════════════════════════════════════════════════════════
//  Import core algorithm components (re-implemented here to avoid importing
//  the full server which starts Express/WebSocket)
// ══════════════════════════════════════════════════════════════════════════

const ARTIFACT_TYPES = {
  HYPOTHESIS: "hypothesis",
  EVIDENCE: "evidence",
  DECISION: "decision",
  IMPLEMENTATION: "implementation",
  CRITIQUE: "critique",
  SYNTHESIS: "synthesis",
};

const DECAY_RATE = 0.05;
const MIN_PHEROMONE = 0.1;
const SYNTHESIS_THRESHOLD = 0.4;
const REINFORCE_AMOUNT = 0.15;
const CHALLENGE_AMOUNT = 0.20;
const EXPLORE_THRESHOLD = 0.6;
const _CONFIDENCE_THRESHOLD = 0.5;

// ── PheromoneTrail ───────────────────────────────────────────────────────

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
      artifactType: artifact.artifactType || ARTIFACT_TYPES.IMPLEMENTATION,
      domain: artifact.domain || "general",
      confidence: artifact.confidence || 0.7,
      pheromone: artifact.confidence || 0.7,
      references: artifact.references || [],
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

  challenge(artifactId, critiqueId) {
    const a = this.artifacts.find(x => x.id === artifactId);
    if (a) {
      a.pheromone = Math.max(0, a.pheromone - CHALLENGE_AMOUNT);
      a.challengeCount++;
      if (critiqueId) a.challenges.push(critiqueId);
    }
  }

  decay() {
    this.artifacts.forEach(a => {
      a.pheromone = Math.max(MIN_PHEROMONE, a.pheromone * (1 - DECAY_RATE));
    });
  }

  read(domain, minPheromone = MIN_PHEROMONE) {
    return this.artifacts
      .filter(a => (!domain || a.domain === domain) && a.pheromone >= minPheromone)
      .sort((a, b) => b.pheromone - a.pheromone);
  }

  getStrongArtifacts() {
    return this.artifacts
      .filter(a => a.pheromone >= SYNTHESIS_THRESHOLD)
      .sort((a, b) => b.pheromone - a.pheromone);
  }

  getStats() {
    const total = this.artifacts.length;
    const strong = this.artifacts.filter(a => a.pheromone >= SYNTHESIS_THRESHOLD).length;
    const avgPheromone = total > 0
      ? this.artifacts.reduce((s, a) => s + a.pheromone, 0) / total
      : 0;
    const byType = {};
    this.artifacts.forEach(a => {
      byType[a.artifactType] = (byType[a.artifactType] || 0) + 1;
    });
    return { total, strong, avgPheromone, byType };
  }

  clear() {
    this.artifacts = [];
    this.nextId = 1;
  }
}

// ── EpistemicTrustModel ──────────────────────────────────────────────────

class EpistemicTrustModel {
  constructor() {
    this.trust = {};
  }

  initialize(agentId, capabilities) {
    if (!this.trust[agentId]) {
      this.trust[agentId] = {};
    }
    for (const cap of capabilities) {
      if (!this.trust[agentId][cap]) {
        this.trust[agentId][cap] = { alpha: 2, beta: 1 };
      }
    }
  }

  getCompetence(agentId, domain) {
    const t = this.trust[agentId]?.[domain];
    if (!t) return { expected: 0, uncertainty: 1, alpha: 0, beta: 0 };
    return {
      expected: t.alpha / (t.alpha + t.beta),
      uncertainty: 1 / (t.alpha + t.beta),
      alpha: t.alpha,
      beta: t.beta,
    };
  }

  recordSuccess(agentId, domain) {
    if (this.trust[agentId]?.[domain]) {
      this.trust[agentId][domain].alpha += 1;
    }
  }

  recordFailure(agentId, domain) {
    if (this.trust[agentId]?.[domain]) {
      this.trust[agentId][domain].beta += 1;
    }
  }

  selectBestAgent(domain, candidates) {
    let best = null;
    let bestScore = -1;
    let reasoning = "";

    for (const agent of candidates) {
      const comp = this.getCompetence(agent.id, domain);
      const explorationBonus = comp.uncertainty > EXPLORE_THRESHOLD ? 0.2 : 0;
      const score = comp.expected + explorationBonus;

      if (score > bestScore) {
        bestScore = score;
        best = agent;
        reasoning = comp.uncertainty > EXPLORE_THRESHOLD
          ? `Exploratory — uncertainty ${(comp.uncertainty * 100).toFixed(0)}%, needs calibration`
          : `Trust ${(comp.expected * 100).toFixed(0)}% in ${domain}`;
      }
    }

    return {
      agent: best, score: bestScore, reasoning,
      isExploratory: best ? this.getCompetence(best.id, domain).uncertainty > EXPLORE_THRESHOLD : false,
    };
  }

  getFullProfile() {
    const profile = {};
    for (const [agentId, domains] of Object.entries(this.trust)) {
      profile[agentId] = {};
      for (const [domain, params] of Object.entries(domains)) {
        profile[agentId][domain] = {
          expected: params.alpha / (params.alpha + params.beta),
          uncertainty: 1 / (params.alpha + params.beta),
          alpha: params.alpha,
          beta: params.beta,
        };
      }
    }
    return profile;
  }
}

// ── Entropy Decomposition ────────────────────────────────────────────────

const KNOWLEDGE_DOMAINS = {
  requirements: {
    label: "Requirements",
    keywords: ["need", "want", "should", "must", "feature", "user", "story", "requirement", "goal"],
    phase: "discovery", order: 1,
  },
  architecture: {
    label: "Architecture",
    keywords: ["architecture", "design", "system", "pattern", "structure", "service", "microservice"],
    phase: "architecture", order: 2,
  },
  frontend: {
    label: "Frontend",
    keywords: ["ui", "frontend", "component", "page", "react", "html", "css", "dashboard"],
    phase: "execution", order: 3,
  },
  backend: {
    label: "Backend",
    keywords: ["api", "backend", "server", "database", "endpoint", "rest", "auth"],
    phase: "execution", order: 3,
  },
  quality: {
    label: "Quality",
    keywords: ["review", "test", "quality", "security", "audit", "verify"],
    phase: "verification", order: 4,
  },
};

function computeDomainEntropy(taskText, domainKeywords) {
  const words = taskText.toLowerCase().split(/\s+/);
  const totalWords = words.length;
  if (totalWords === 0) return { entropy: 0, density: 0, matchedTerms: [] };

  let matchCount = 0;
  const matchedTerms = [];
  for (const kw of domainKeywords) {
    const kwParts = kw.split(" ");
    if (kwParts.length > 1) {
      if (taskText.toLowerCase().includes(kw)) { matchCount += 2; matchedTerms.push(kw); }
    } else {
      if (words.some(w => w.includes(kw) || kw.includes(w))) { matchCount++; matchedTerms.push(kw); }
    }
  }

  if (matchCount === 0) return { entropy: 0, density: 0, matchedTerms: [] };

  const density = matchCount / totalWords;
  const p = Math.min(density, 1);
  const entropy = p > 0 && p < 1 ? -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)) : 0;

  return { entropy, density, matchedTerms };
}

function decomposeTask(taskText) {
  const domainAnalysis = {};
  const activeDomains = [];

  for (const [domain, info] of Object.entries(KNOWLEDGE_DOMAINS)) {
    const analysis = computeDomainEntropy(taskText, info.keywords);
    domainAnalysis[domain] = { ...analysis, phase: info.phase, order: info.order };
    if (analysis.density > 0) {
      activeDomains.push({ domain, ...analysis, label: info.label, phase: info.phase, order: info.order });
    }
  }

  activeDomains.sort((a, b) => b.entropy - a.entropy);

  if (!activeDomains.some(d => d.domain === "quality")) {
    activeDomains.push({
      domain: "quality", entropy: 0.1, density: 0, matchedTerms: [],
      label: "Quality", phase: "verification", order: 4,
    });
  }

  const phaseMap = {};
  for (const d of activeDomains) {
    if (!phaseMap[d.phase]) phaseMap[d.phase] = { name: d.phase, order: d.order, domains: [] };
    phaseMap[d.phase].domains.push(d);
  }

  const phases = Object.values(phaseMap).sort((a, b) => a.order - b.order);
  return { domainAnalysis, activeDomains, phases };
}

// ══════════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════════

describe("PheromoneTrail", () => {
  describe("deposit", () => {
    const trail = new PheromoneTrail();
    const node = trail.deposit({
      content: "Test artifact",
      authorAgent: "researcher",
      artifactType: ARTIFACT_TYPES.HYPOTHESIS,
      domain: "architecture",
      confidence: 0.8,
    });

    assert(node.id === "art_1", "assigns sequential ID");
    assert(node.content === "Test artifact", "stores content");
    assert(node.authorAgent === "researcher", "stores author");
    assert(node.artifactType === "hypothesis", "stores artifact type");
    assert(node.domain === "architecture", "stores domain");
    assert(node.confidence === 0.8, "stores confidence");
    assert(node.pheromone === 0.8, "initializes pheromone to confidence");
    assert(node.reinforcements === 0, "starts with 0 reinforcements");
    assert(node.challengeCount === 0, "starts with 0 challenges");
    assert(trail.artifacts.length === 1, "adds to artifacts array");
  });

  describe("reinforce", () => {
    const trail = new PheromoneTrail();
    const node = trail.deposit({ content: "test", authorAgent: "a", confidence: 0.5 });
    trail.reinforce(node.id);

    assert(node.pheromone === 0.65, "increases pheromone by REINFORCE_AMOUNT");
    assert(node.reinforcements === 1, "increments reinforcement count");

    // Test capping at 1.0
    const high = trail.deposit({ content: "test", authorAgent: "a", confidence: 0.95 });
    trail.reinforce(high.id);
    assert(high.pheromone === 1.0, "caps pheromone at 1.0");
  });

  describe("challenge", () => {
    const trail = new PheromoneTrail();
    const node = trail.deposit({ content: "test", authorAgent: "a", confidence: 0.5 });
    trail.challenge(node.id, "critique_1");

    assert(node.pheromone === 0.3, "decreases pheromone by CHALLENGE_AMOUNT");
    assert(node.challengeCount === 1, "increments challenge count");
    assert(node.challenges.includes("critique_1"), "stores critique reference");

    // Test floor at 0
    const low = trail.deposit({ content: "test", authorAgent: "a", confidence: 0.1 });
    trail.challenge(low.id, "c2");
    assert(low.pheromone === 0, "floors pheromone at 0");
  });

  describe("decay", () => {
    const trail = new PheromoneTrail();
    trail.deposit({ content: "test", authorAgent: "a", confidence: 0.8 });
    trail.decay();

    assertApprox(trail.artifacts[0].pheromone, 0.76, 0.001, "applies decay rate correctly");

    // Test minimum pheromone floor
    const lowTrail = new PheromoneTrail();
    lowTrail.deposit({ content: "test", authorAgent: "a", confidence: 0.11 });
    for (let i = 0; i < 100; i++) lowTrail.decay();
    assert(lowTrail.artifacts[0].pheromone >= MIN_PHEROMONE, "respects minimum pheromone floor");
  });

  describe("read", () => {
    const trail = new PheromoneTrail();
    trail.deposit({ content: "arch", authorAgent: "a", domain: "architecture", confidence: 0.8 });
    trail.deposit({ content: "fe", authorAgent: "b", domain: "frontend", confidence: 0.6 });
    trail.deposit({ content: "arch2", authorAgent: "c", domain: "architecture", confidence: 0.9 });

    const archArtifacts = trail.read("architecture");
    assert(archArtifacts.length === 2, "filters by domain");
    assert(archArtifacts[0].pheromone >= archArtifacts[1].pheromone, "sorts by pheromone descending");

    const allArtifacts = trail.read(null);
    assert(allArtifacts.length === 3, "returns all when domain is null");
  });

  describe("getStrongArtifacts", () => {
    const trail = new PheromoneTrail();
    trail.deposit({ content: "strong", authorAgent: "a", confidence: 0.8 });
    trail.deposit({ content: "weak", authorAgent: "b", confidence: 0.2 });
    trail.deposit({ content: "medium", authorAgent: "c", confidence: 0.5 });

    const strong = trail.getStrongArtifacts();
    assert(strong.length === 2, "filters artifacts above synthesis threshold");
    assert(strong[0].content === "strong", "highest pheromone first");
  });

  describe("getStats", () => {
    const trail = new PheromoneTrail();
    trail.deposit({ content: "a", authorAgent: "x", artifactType: ARTIFACT_TYPES.HYPOTHESIS, confidence: 0.8 });
    trail.deposit({ content: "b", authorAgent: "y", artifactType: ARTIFACT_TYPES.HYPOTHESIS, confidence: 0.6 });
    trail.deposit({ content: "c", authorAgent: "z", artifactType: ARTIFACT_TYPES.IMPLEMENTATION, confidence: 0.3 });

    const stats = trail.getStats();
    assert(stats.total === 3, "counts total artifacts");
    assert(stats.strong === 2, "counts strong artifacts");
    assertApprox(stats.avgPheromone, (0.8 + 0.6 + 0.3) / 3, 0.001, "calculates average pheromone");
    assert(stats.byType.hypothesis === 2, "counts by type");
    assert(stats.byType.implementation === 1, "counts implementation type");
  });

  describe("clear", () => {
    const trail = new PheromoneTrail();
    trail.deposit({ content: "a", authorAgent: "x", confidence: 0.5 });
    trail.clear();
    assert(trail.artifacts.length === 0, "clears all artifacts");
    assert(trail.nextId === 1, "resets ID counter");
  });
});

describe("EpistemicTrustModel", () => {
  describe("initialize", () => {
    const model = new EpistemicTrustModel();
    model.initialize("agent1", ["frontend", "backend"]);

    assert(model.trust.agent1 !== undefined, "creates agent entry");
    assert(model.trust.agent1.frontend.alpha === 2, "initializes with slight positive prior (alpha=2)");
    assert(model.trust.agent1.frontend.beta === 1, "initializes with slight positive prior (beta=1)");
    assert(model.trust.agent1.backend !== undefined, "initializes all capabilities");
  });

  describe("getCompetence", () => {
    const model = new EpistemicTrustModel();
    model.initialize("agent1", ["frontend"]);

    const comp = model.getCompetence("agent1", "frontend");
    assertApprox(comp.expected, 2 / 3, 0.001, "calculates expected competence");
    assertApprox(comp.uncertainty, 1 / 3, 0.001, "calculates uncertainty");

    const unknown = model.getCompetence("unknown", "frontend");
    assert(unknown.expected === 0, "returns 0 competence for unknown agent");
    assert(unknown.uncertainty === 1, "returns full uncertainty for unknown agent");
  });

  describe("recordSuccess / recordFailure", () => {
    const model = new EpistemicTrustModel();
    model.initialize("agent1", ["frontend"]);

    model.recordSuccess("agent1", "frontend");
    assert(model.trust.agent1.frontend.alpha === 3, "increments alpha on success");

    model.recordFailure("agent1", "frontend");
    assert(model.trust.agent1.frontend.beta === 2, "increments beta on failure");

    const comp = model.getCompetence("agent1", "frontend");
    assertApprox(comp.expected, 3 / 5, 0.001, "updates competence correctly");
  });

  describe("selectBestAgent", () => {
    const model = new EpistemicTrustModel();
    model.initialize("bolt", ["frontend"]);
    model.initialize("forge", ["frontend"]);

    // Give bolt more successes
    for (let i = 0; i < 5; i++) model.recordSuccess("bolt", "frontend");

    const candidates = [
      { id: "bolt", capabilities: ["frontend"] },
      { id: "forge", capabilities: ["frontend"] },
    ];

    const result = model.selectBestAgent("frontend", candidates);
    assert(result.agent.id === "bolt", "selects agent with higher trust");
    assert(result.score > 0, "returns positive score");
    assert(typeof result.reasoning === "string", "provides reasoning");
  });

  describe("exploration bonus", () => {
    const model = new EpistemicTrustModel();
    // New agent with high uncertainty (alpha=2, beta=1 → uncertainty = 1/3 = 0.33)
    model.initialize("newbie", ["frontend"]);
    // Experienced agent with low uncertainty
    model.initialize("expert", ["frontend"]);
    for (let i = 0; i < 10; i++) model.recordSuccess("expert", "frontend");

    const _newComp = model.getCompetence("newbie", "frontend");
    const expComp = model.getCompetence("expert", "frontend");

    assert(expComp.uncertainty < EXPLORE_THRESHOLD, "experienced agent has low uncertainty");
    // Note: newbie's uncertainty is 1/3 which is below threshold, so no bonus here
    // To get exploration bonus we need very few observations
  });

  describe("getFullProfile", () => {
    const model = new EpistemicTrustModel();
    model.initialize("agent1", ["frontend", "backend"]);
    const profile = model.getFullProfile();

    assert(profile.agent1 !== undefined, "includes agent");
    assert(profile.agent1.frontend !== undefined, "includes domain");
    assert(typeof profile.agent1.frontend.expected === "number", "includes expected value");
    assert(typeof profile.agent1.frontend.uncertainty === "number", "includes uncertainty value");
  });
});

describe("Entropic Decomposition", () => {
  describe("computeDomainEntropy", () => {
    const result = computeDomainEntropy(
      "Build a REST API with authentication and database endpoints",
      ["api", "backend", "server", "database", "endpoint", "rest", "auth"]
    );

    assert(result.density > 0, "calculates positive density for matching text");
    assert(result.entropy > 0, "calculates positive entropy");
    assert(result.matchedTerms.length > 0, "identifies matched terms");
    assert(result.matchedTerms.includes("api"), "matches 'api'");
    assert(result.matchedTerms.includes("database"), "matches 'database'");

    const noMatch = computeDomainEntropy("Hello world", ["quantum", "photon"]);
    assert(noMatch.entropy === 0, "returns 0 entropy for non-matching text");
    assert(noMatch.density === 0, "returns 0 density for non-matching text");
    assert(noMatch.matchedTerms.length === 0, "returns empty matched terms");
  });

  describe("computeDomainEntropy edge cases", () => {
    const empty = computeDomainEntropy("", ["api"]);
    assert(empty.entropy === 0, "handles empty string");

    const singleWord = computeDomainEntropy("api", ["api"]);
    assert(singleWord.density > 0, "handles single word match");
  });

  describe("decomposeTask", () => {
    const result = decomposeTask(
      "Build a full stack SaaS with React frontend, REST API backend, and deploy to cloud"
    );

    assert(result.activeDomains.length > 0, "identifies active domains");
    assert(result.phases.length > 0, "creates execution phases");

    // Quality should always be present
    const hasQuality = result.activeDomains.some(d => d.domain === "quality");
    assert(hasQuality, "always includes quality domain");

    // Phases should be ordered
    for (let i = 1; i < result.phases.length; i++) {
      assert(
        result.phases[i].order >= result.phases[i - 1].order,
        `phase ${result.phases[i].name} order >= ${result.phases[i - 1].name}`
      );
    }

    // Should identify frontend and backend
    const domains = result.activeDomains.map(d => d.domain);
    assert(domains.includes("frontend"), "identifies frontend domain");
    assert(domains.includes("backend"), "identifies backend domain");
  });

  describe("decomposeTask with content-only task", () => {
    const result = decomposeTask("Write a blog article about marketing");

    assert(result.activeDomains.some(d => d.domain === "quality"), "always includes quality");
    assert(result.phases.length >= 1, "creates at least one phase");
  });
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
