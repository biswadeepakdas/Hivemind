// ═══════════════════════════════════════════════════════════════════════════
//  HIVEMIND PROTOCOL v2 — Powered by SESI Algorithm
//  Stigmergic Epistemic Swarm Intelligence
//  Deploy anywhere: Railway, Render, Fly.io, VPS, or Docker
// ═══════════════════════════════════════════════════════════════════════════
//
//  THREE PILLARS:
//  1. Stigmergic Pheromone Trail — agents communicate via shared knowledge artifacts
//  2. Epistemic Trust Model — Bayesian Beta-distributed competence per domain
//  3. Entropic Task Decomposition — uncertainty-first execution ordering
//
//  SETUP:
//    npm install
//    echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
//    node sesi-swarm-server.js
//
//  Then open http://localhost:3000 in your browser
// ═══════════════════════════════════════════════════════════════════════════

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import cors from "cors";
import { createLogger } from "./scripts/lib/logger.js";
import { withRetry } from "./scripts/lib/retry.js";
import { CostTracker } from "./scripts/lib/cost-tracker.js";
import { TrustPersistence } from "./scripts/lib/persistence.js";
import { validateTaskInput, validateSessionId, rateLimit, requireApiKey, errorHandler } from "./scripts/lib/validate-input.js";
import { CircuitBreaker } from "./scripts/lib/circuit-breaker.js";

dotenv.config();

const log = createLogger("Server");
const engineLog = createLogger("SESIEngine");
const trailLog = createLogger("PheromoneTrail");
const trustLog = createLogger("TrustModel");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60000, maxRequests: 120 }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Validate API key at startup
if (!process.env.ANTHROPIC_API_KEY) {
  log.warn("ANTHROPIC_API_KEY not set — API calls will fail");
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Initialize cost tracker, persistence, and circuit breaker
const costTracker = new CostTracker();
const persistence = new TrustPersistence();
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenMax: 1,
});

// ═══════════════════════════════════════════════════════════════════════════
//  SESI PILLAR 1: Pheromone Trail (Stigmergic Knowledge Environment)
// ═══════════════════════════════════════════════════════════════════════════

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

  /**
   * Prune low-pheromone artifacts to prevent unbounded growth.
   * Keeps artifacts above threshold or younger than maxAge ms.
   * @param {object} options
   * @param {number} options.minPheromone - Minimum pheromone to survive (default: MIN_PHEROMONE + 0.05)
   * @param {number} options.maxArtifacts - Hard cap on total artifacts (default: 200)
   * @param {number} options.maxAge - Max age in ms before pruning eligible (default: 10 min)
   */
  prune(options = {}) {
    const minPh = options.minPheromone ?? (MIN_PHEROMONE + 0.05);
    const maxArtifacts = options.maxArtifacts ?? 200;
    const maxAge = options.maxAge ?? 10 * 60 * 1000;
    const now = Date.now();

    const before = this.artifacts.length;

    // Keep artifacts that are strong enough OR recent enough
    this.artifacts = this.artifacts.filter(a =>
      a.pheromone >= minPh || (now - a.timestamp) < maxAge
    );

    // If still over hard cap, keep only the strongest
    if (this.artifacts.length > maxArtifacts) {
      this.artifacts.sort((a, b) => b.pheromone - a.pheromone);
      this.artifacts = this.artifacts.slice(0, maxArtifacts);
    }

    const pruned = before - this.artifacts.length;
    if (pruned > 0) {
      trailLog.info(`Pruned ${pruned} low-pheromone artifacts`, { before, after: this.artifacts.length });
    }
    return pruned;
  }

  clear() {
    this.artifacts = [];
    this.nextId = 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SESI PILLAR 2: Epistemic Trust Model (Bayesian Agent Competence)
// ═══════════════════════════════════════════════════════════════════════════

const EXPLORE_THRESHOLD = 0.6;
const CONFIDENCE_THRESHOLD = 0.5;

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
        this.trust[agentId][cap] = { alpha: 2, beta: 1 }; // slight positive prior
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
      // UCB1-inspired: expected competence + exploration bonus for uncertain agents
      const explorationBonus = comp.uncertainty > EXPLORE_THRESHOLD ? 0.2 : 0;
      const score = comp.expected + explorationBonus;

      if (score > bestScore) {
        bestScore = score;
        best = agent;
        reasoning = comp.uncertainty > EXPLORE_THRESHOLD
          ? `Exploratory — uncertainty ${(comp.uncertainty * 100).toFixed(0)}%, needs calibration`
          : `Trust ${(comp.expected * 100).toFixed(0)}% in ${domain} (a=${comp.alpha}, b=${comp.beta})`;
      }
    }

    return { agent: best, score: bestScore, reasoning, isExploratory: best ? this.getCompetence(best.id, domain).uncertainty > EXPLORE_THRESHOLD : false };
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

// ═══════════════════════════════════════════════════════════════════════════
//  SESI PILLAR 3: Entropic Task Decomposition
// ═══════════════════════════════════════════════════════════════════════════

const KNOWLEDGE_DOMAINS = {
  requirements: {
    label: "Requirements",
    keywords: ["need", "want", "should", "must", "feature", "user", "story", "requirement", "goal", "objective", "specification", "scope", "criteria"],
    phase: "discovery",
    order: 1,
  },
  architecture: {
    label: "Architecture",
    keywords: ["architecture", "design", "system", "pattern", "structure", "service", "microservice", "monolith", "serverless", "distributed", "scale", "event", "domain", "cqrs", "saga", "gateway", "mesh", "cloud", "container", "docker", "kubernetes", "saas", "platform", "mvp", "full stack", "fullstack", "migrate", "modernize", "legacy"],
    phase: "architecture",
    order: 2,
  },
  frontend: {
    label: "Frontend",
    keywords: ["ui", "frontend", "component", "page", "react", "vue", "html", "css", "responsive", "animation", "dashboard", "widget", "layout", "button", "form", "modal", "chart", "landing", "website", "web", "interface", "display", "visual", "interactive"],
    phase: "execution",
    order: 3,
  },
  backend: {
    label: "Backend",
    keywords: ["api", "backend", "server", "database", "endpoint", "rest", "graphql", "auth", "middleware", "route", "schema", "migration", "query", "sql", "cache", "queue", "webhook", "lambda", "function", "pipeline", "socket", "grpc"],
    phase: "execution",
    order: 3,
  },
  infrastructure: {
    label: "Infrastructure",
    keywords: ["deploy", "devops", "docker", "ci/cd", "terraform", "aws", "gcp", "azure", "monitoring", "logging", "infrastructure", "config", "environment", "kubernetes", "container"],
    phase: "execution",
    order: 3,
  },
  content: {
    label: "Content",
    keywords: ["write", "blog", "article", "documentation", "readme", "copy", "email", "report", "proposal", "tutorial", "guide", "content", "marketing", "seo", "draft", "story", "pitch", "presentation"],
    phase: "execution",
    order: 3,
  },
  quality: {
    label: "Quality",
    keywords: ["review", "test", "quality", "security", "audit", "verify", "validate", "bug", "lint", "fix", "optimize", "performance", "benchmark"],
    phase: "verification",
    order: 4,
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

  // Sort by entropy (highest first — tackle uncertainty first)
  activeDomains.sort((a, b) => b.entropy - a.entropy);

  // Always include quality (review) at the end
  if (!activeDomains.some(d => d.domain === "quality")) {
    activeDomains.push({
      domain: "quality", entropy: 0.1, density: 0, matchedTerms: [],
      label: "Quality", phase: "verification", order: 4,
    });
  }

  // Group into phases respecting dependency order
  const phaseMap = {};
  for (const d of activeDomains) {
    if (!phaseMap[d.phase]) phaseMap[d.phase] = { name: d.phase, order: d.order, domains: [] };
    phaseMap[d.phase].domains.push(d);
  }

  const phases = Object.values(phaseMap).sort((a, b) => a.order - b.order);

  return { domainAnalysis, activeDomains, phases };
}

// ═══════════════════════════════════════════════════════════════════════════
//  AGENT DEFINITIONS — capabilities + domain mappings for trust routing
// ═══════════════════════════════════════════════════════════════════════════

const AGENT_DEFS = {
  orchestrator: {
    id: "orchestrator", name: "Nexus", emoji: "🧠", role: "Orchestrator", color: "#8B5CF6",
    capabilities: ["decomposition", "synthesis", "routing"],
    systemPrompt: `You are Nexus, the orchestrator of the SESI multi-agent swarm.

Your job: You receive a task that has already been decomposed by the SESI entropic decomposition engine. You will be given:
- The entropy analysis (which domains are uncertain)
- The pheromone trail (what knowledge artifacts exist so far)
- The trust-selected agents for each domain

Your role is to:
1. Provide additional context or constraints the decomposition may have missed
2. When asked to synthesize: combine all high-pheromone artifacts into a cohesive deliverable
3. Assess whether the pheromone trail is complete or needs more artifacts

Output clear, actionable guidance. When synthesizing, create a polished final deliverable — NOT a summary of what agents did.`,
  },

  researcher: {
    id: "researcher", name: "Scout", emoji: "🔍", role: "Research Agent", color: "#3B82F6",
    capabilities: ["requirements", "architecture", "content", "quality"],
    systemPrompt: `You are Scout, the research agent in the SESI swarm.

Your job: Deposit EVIDENCE artifacts into the pheromone trail. Gather information, analyze options, find best practices, and provide data-backed context.

You will receive:
- The pheromone trail context (high-strength artifacts from other agents)
- Your assigned domain and specific task

Output format: Structured findings with clear reasoning. Rate your confidence (0-1) in your findings. Flag uncertainties as HYPOTHESIS artifacts, confirmed findings as EVIDENCE artifacts.`,
  },

  planner: {
    id: "planner", name: "Architect", emoji: "📐", role: "Planning Agent", color: "#F59E0B",
    capabilities: ["requirements", "architecture", "frontend", "backend"],
    systemPrompt: `You are Architect, the planning agent in the SESI swarm.

Your job: Deposit DECISION artifacts — structured plans, execution strategies, and task breakdowns.

Read existing pheromone trail artifacts (especially EVIDENCE and HYPOTHESIS) before making decisions. Your plans should BUILD ON prior artifacts, reinforcing strong ones and challenging weak ones.

Output format: Structured plan with dependencies and success criteria. Rate your confidence (0-1).`,
  },

  senior_architect: {
    id: "senior_architect", name: "Sage", emoji: "🏛️", role: "Senior Architect", color: "#D97706",
    capabilities: ["architecture", "infrastructure", "backend"],
    systemPrompt: `You are Sage, the senior architect in the SESI swarm.

Your job: Deposit DECISION artifacts with deep trade-off reasoning. You produce Architecture Decision Records (ADRs).

REASONING PROCESS:
1. Read pheromone trail — identify existing HYPOTHESIS and EVIDENCE artifacts
2. Identify constraints and quality attributes
3. Enumerate candidate architectures (at least 3)
4. Build a trade-off matrix
5. Select optimal architecture with justification
6. Produce ADR with component boundaries and risk mitigation

You may deposit CRITIQUE artifacts that CHALLENGE other agents' artifacts if you see flaws. When you challenge, the challenged artifact's pheromone decreases.

Rate your confidence (0-1) for each decision.`,
  },

  coder_frontend: {
    id: "coder_frontend", name: "Bolt", emoji: "⚡", role: "Frontend Coder", color: "#10B981",
    capabilities: ["frontend"],
    systemPrompt: `You are Bolt, the frontend coding agent in the SESI swarm.

Your job: Deposit IMPLEMENTATION artifacts — production-quality frontend code. Read DECISION artifacts from the trail to follow architectural guidance.

Output: Clean, well-commented code. Reference which DECISION artifacts you're implementing. Rate your confidence (0-1).`,
  },

  coder_backend: {
    id: "coder_backend", name: "Forge", emoji: "🔧", role: "Backend Coder", color: "#06B6D4",
    capabilities: ["backend", "infrastructure"],
    systemPrompt: `You are Forge, the backend coding agent in the SESI swarm.

Your job: Deposit IMPLEMENTATION artifacts — APIs, database schemas, server logic. Read DECISION and EVIDENCE artifacts from the trail.

Output: Clean, well-structured code with security considerations. Rate your confidence (0-1).`,
  },

  coder_systems: {
    id: "coder_systems", name: "Core", emoji: "🔩", role: "Systems Coder", color: "#A855F7",
    capabilities: ["infrastructure", "backend", "quality"],
    systemPrompt: `You are Core, the systems coding agent in the SESI swarm.

Your job: Deposit IMPLEMENTATION artifacts — algorithms, DevOps configs, CI/CD pipelines, infrastructure code.

Output: Production-ready configs and scripts. Rate your confidence (0-1).`,
  },

  writer: {
    id: "writer", name: "Quill", emoji: "✍️", role: "Writing Agent", color: "#EC4899",
    capabilities: ["content", "requirements"],
    systemPrompt: `You are Quill, the writing agent in the SESI swarm.

Your job: Deposit IMPLEMENTATION artifacts — documentation, blog posts, copy, emails, READMEs.

Read the pheromone trail for EVIDENCE and DECISION artifacts to inform your writing. Your content should accurately reflect what other agents have determined.

Output: Polished, well-structured prose. Rate your confidence (0-1).`,
  },

  reviewer: {
    id: "reviewer", name: "Sentinel", emoji: "🛡️", role: "Review Agent", color: "#EF4444",
    capabilities: ["quality"],
    systemPrompt: `You are Sentinel, the review agent and EPISTEMIC TRUST GATE in the SESI swarm.

Your job is CRITICAL — you determine whether artifacts pass quality gates. Your verdicts update the Bayesian trust model:
- APPROVE: The author agent's trust score increases (alpha += 1)
- REJECT: The author agent's trust score decreases (beta += 1)

For each artifact you review:
1. Check for correctness, completeness, security, and consistency
2. Rate severity of any issues (critical/major/minor)
3. Give a clear APPROVE or REJECT verdict
4. If rejecting, deposit a CRITIQUE artifact that challenges the original

You may also CHALLENGE architectural decisions by depositing CRITIQUE artifacts against DECISION artifacts.

Output format:
VERDICT: [APPROVE/REJECT]
QUALITY_SCORE: [0-100]
ISSUES: [list of issues with severity]
RECOMMENDATION: [what to fix]`,
  },
};

// Initialize trust model with agent capabilities (load persisted state if available)
const globalTrustModel = new EpistemicTrustModel();
for (const [id, def] of Object.entries(AGENT_DEFS)) {
  globalTrustModel.initialize(id, def.capabilities);
}

// Restore persisted trust model from disk
const savedTrust = persistence.loadTrustModel();
if (savedTrust) {
  globalTrustModel.trust = savedTrust;
  trustLog.info("Restored trust model from disk", { agents: Object.keys(savedTrust).length });
} else {
  trustLog.info("Starting with fresh trust model (no persisted state found)");
}

// ═══════════════════════════════════════════════════════════════════════════
//  SESI ENGINE — Entropic Decomposition + Trust Routing + Pheromone Trail
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 50;
const SESSION_CLEANUP_INTERVAL = 60 * 1000; // Check every minute

class SESIEngine {
  constructor() {
    this.sessions = new Map();
    this.spectators = new Map();

    // Periodic session eviction
    this._cleanupTimer = setInterval(() => this._evictStaleSessions(), SESSION_CLEANUP_INTERVAL);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref(); // Don't keep process alive
  }

  _evictStaleSessions() {
    const now = Date.now();
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      const age = now - (session.metrics.startTime || session.createdAt || now);
      const isComplete = session.status === "complete" || session.status === "error";
      if (isComplete && age > SESSION_TTL) {
        this.sessions.delete(id);
        this.spectators.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      engineLog.info(`Evicted ${evicted} stale sessions`, { remaining: this.sessions.size });
    }
  }

  createSession() {
    // Enforce max session limit — evict oldest completed sessions first
    if (this.sessions.size >= MAX_SESSIONS) {
      const completed = [...this.sessions.entries()]
        .filter(([, s]) => s.status === "complete" || s.status === "error")
        .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));

      if (completed.length > 0) {
        const [oldId] = completed[0];
        this.sessions.delete(oldId);
        this.spectators.delete(oldId);
        engineLog.info(`Evicted oldest session to make room`, { evicted: oldId, total: this.sessions.size });
      } else {
        engineLog.warn("Max sessions reached with no completed sessions to evict", { max: MAX_SESSIONS });
      }
    }

    const sessionId = randomUUID().slice(0, 8);
    this.sessions.set(sessionId, {
      id: sessionId,
      status: "idle",
      task: null,
      trail: new PheromoneTrail(),
      log: [],
      decomposition: null,
      agentSelections: [],
      createdAt: Date.now(),
      metrics: { startTime: null, phaseTimings: {}, agentCalls: 0, tokensEstimate: 0 },
    });
    this.spectators.set(sessionId, new Set());
    return sessionId;
  }

  addSpectator(sessionId, ws) {
    if (!this.spectators.has(sessionId)) this.spectators.set(sessionId, new Set());
    this.spectators.get(sessionId).add(ws);
    const session = this.sessions.get(sessionId);
    if (session) {
      ws.send(JSON.stringify({ type: "session_state", data: { ...session, trail: session.trail.getStats() } }));
    }
  }

  removeSpectator(sessionId, ws) {
    this.spectators.get(sessionId)?.delete(ws);
  }

  broadcast(sessionId, message) {
    const spectators = this.spectators.get(sessionId);
    if (!spectators) return;
    const data = JSON.stringify(message);
    for (const ws of spectators) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  // ─── Call an agent with streaming, deposit artifact to trail ────
  async callAgent(sessionId, agentId, task, domain, artifactType, trailContext = "") {
    const agentDef = AGENT_DEFS[agentId];
    if (!agentDef) throw new Error(`Unknown agent: ${agentId}`);
    const session = this.sessions.get(sessionId);

    this.broadcast(sessionId, {
      type: "agent_start",
      data: { agentId, name: agentDef.name, emoji: agentDef.emoji, role: agentDef.role, color: agentDef.color, task, domain },
    });

    // Build context from pheromone trail with token-budget-aware windowing
    const trailArtifacts = session.trail.getStrongArtifacts();
    const TOKEN_BUDGET = 3000; // ~3000 tokens for trail context
    const CHARS_PER_TOKEN = 4;
    const charBudget = TOKEN_BUDGET * CHARS_PER_TOKEN;
    let usedChars = 0;
    const contextArtifacts = [];
    for (const a of trailArtifacts) {
      // Prioritize domain-relevant artifacts, then include general ones
      const contentSlice = a.content.slice(0, 600); // Up from 200
      const entry = `  [${a.artifactType.toUpperCase()}] by ${a.authorAgent} (pheromone: ${a.pheromone.toFixed(2)}): ${contentSlice}`;
      if (usedChars + entry.length > charBudget) break;
      contextArtifacts.push(entry);
      usedChars += entry.length;
    }
    const trailSummary = contextArtifacts.length > 0
      ? `\nPHEROMONE TRAIL (${contextArtifacts.length}/${trailArtifacts.length} artifacts):\n` + contextArtifacts.join("\n")
      : "";

    const trustProfile = globalTrustModel.getCompetence(agentId, domain);

    const messages = [{
      role: "user",
      content: `TASK: ${task}
DOMAIN: ${domain}
YOUR TRUST SCORE: ${(trustProfile.expected * 100).toFixed(0)}% competence, ${(trustProfile.uncertainty * 100).toFixed(0)}% uncertainty
${trailSummary}
${trailContext ? `\nADDITIONAL CONTEXT:\n${trailContext}` : ""}

Complete your assigned task. End your response with:
CONFIDENCE: [0.0-1.0]`,
    }];

    let fullResponse = "";
    const model = process.env.SESI_MODEL || "claude-sonnet-4-20250514";

    try {
      await circuitBreaker.execute(async () => {
        await withRetry(async (attempt) => {
          if (attempt > 0) {
            engineLog.info(`Retry attempt ${attempt} for agent ${agentId}`, { domain });
          }

          const stream = await anthropic.messages.stream({
            model,
            max_tokens: 4096,
            system: agentDef.systemPrompt,
            messages,
          });

          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta?.text) {
              const token = event.delta.text;
              fullResponse += token;
              this.broadcast(sessionId, {
                type: "agent_token",
                data: { agentId, token, name: agentDef.name },
              });
            }
          }
        }, {
          maxRetries: 3,
          baseDelay: 2000,
          onRetry: (err, attempt, delay) => {
            engineLog.warn(`Agent ${agentId} call failed, retrying in ${delay}ms`, {
              attempt, error: err.message, status: err.status,
            });
          },
        });
      });
    } catch (err) {
      if (err.circuitBreakerOpen) {
        fullResponse = `[Circuit breaker OPEN — API temporarily unavailable. ${err.message}]`;
        engineLog.warn(`Circuit breaker blocked agent ${agentId}`, { domain, stats: circuitBreaker.getStats() });
      } else {
        fullResponse = `[Agent error: ${err.message}]`;
        engineLog.error(`Agent ${agentId} failed after retries`, { error: err.message, domain });
      }
      this.broadcast(sessionId, {
        type: "agent_error",
        data: { agentId, error: err.message },
      });
    }

    // Extract confidence from response
    const confMatch = fullResponse.match(/CONFIDENCE:\s*([\d.]+)/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.7;

    // Deposit artifact to pheromone trail
    const artifact = session.trail.deposit({
      content: fullResponse.slice(0, 2000),
      authorAgent: agentId,
      artifactType: artifactType || ARTIFACT_TYPES.IMPLEMENTATION,
      domain,
      confidence,
    });

    // Reinforce referenced artifacts
    for (const strong of trailArtifacts.slice(0, 3)) {
      session.trail.reinforce(strong.id);
    }

    session.metrics.agentCalls++;
    const estimatedInputTokens = costTracker.estimateTokens(messages[0].content + (agentDef.systemPrompt || ""));
    const estimatedOutputTokens = costTracker.estimateTokens(fullResponse);
    session.metrics.tokensEstimate += estimatedInputTokens + estimatedOutputTokens;

    // Track cost
    costTracker.recordCall(sessionId, {
      model: process.env.SESI_MODEL || "claude-sonnet-4-20250514",
      agentId,
      domain,
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
    });

    this.broadcast(sessionId, {
      type: "agent_complete",
      data: {
        agentId, name: agentDef.name, output: fullResponse,
        artifactId: artifact.id, artifactType, domain, confidence,
        pheromone: artifact.pheromone,
      },
    });

    session.log.push({
      agentId, name: agentDef.name, output: fullResponse,
      artifactId: artifact.id, artifactType, domain, confidence,
      timestamp: Date.now(),
    });

    return { output: fullResponse, artifact, confidence };
  }

  // ─── Epistemic Trust Gate (Sentinel reviews + updates trust) ────
  async verifyArtifact(sessionId, artifact, isExploratory) {
    const session = this.sessions.get(sessionId);

    // Only verify if low confidence, exploratory, or has critiques
    if (!isExploratory && artifact.confidence >= CONFIDENCE_THRESHOLD && artifact.challengeCount === 0) {
      // Auto-approve high-confidence artifacts from trusted agents
      globalTrustModel.recordSuccess(artifact.authorAgent, artifact.domain);
      session.trail.reinforce(artifact.id);
      return { approved: true, autoApproved: true };
    }

    // Sentinel reviews
    const result = await this.callAgent(
      sessionId, "reviewer",
      `Review this ${artifact.artifactType} artifact by ${artifact.authorAgent}:\n\n${artifact.content.slice(0, 1500)}`,
      "quality",
      ARTIFACT_TYPES.CRITIQUE,
      `Original artifact confidence: ${artifact.confidence}\nAuthor trust: ${JSON.stringify(globalTrustModel.getCompetence(artifact.authorAgent, artifact.domain))}`
    );

    const approved = result.output.includes("APPROVE");

    if (approved) {
      globalTrustModel.recordSuccess(artifact.authorAgent, artifact.domain);
      session.trail.reinforce(artifact.id);
    } else {
      globalTrustModel.recordFailure(artifact.authorAgent, artifact.domain);
      session.trail.challenge(artifact.id, result.artifact.id);
    }

    this.broadcast(sessionId, {
      type: "trust_update",
      data: {
        agentId: artifact.authorAgent,
        domain: artifact.domain,
        approved,
        newTrust: globalTrustModel.getCompetence(artifact.authorAgent, artifact.domain),
      },
    });

    return { approved, reviewOutput: result.output, confidence: result.confidence };
  }

  // ─── Main SESI Execution Loop ──────────────────────────────────
  async executeTask(sessionId, taskText) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    session.status = "running";
    session.task = taskText;
    session.metrics.startTime = Date.now();
    session.log = [];
    session.trail.clear();

    this.broadcast(sessionId, {
      type: "swarm_start",
      data: { task: taskText, sessionId, algorithm: "SESI" },
    });

    // ── PHASE 0: Entropic Decomposition ──────────────────────────
    this.broadcast(sessionId, { type: "phase_change", data: { phase: "decomposing", label: "ENTROPIC DECOMPOSITION" } });

    const decomposition = decomposeTask(taskText);
    session.decomposition = decomposition;

    this.broadcast(sessionId, {
      type: "decomposition_complete",
      data: {
        activeDomains: decomposition.activeDomains.map(d => ({
          domain: d.domain, label: d.label, entropy: d.entropy, density: d.density,
          matchedTerms: d.matchedTerms.slice(0, 5),
        })),
        phases: decomposition.phases.map(p => ({
          name: p.name, domains: p.domains.map(d => d.label),
        })),
      },
    });

    // ── Execute each phase ───────────────────────────────────────
    const artifactsToVerify = [];
    let phaseIndex = 0;

    for (const phase of decomposition.phases) {
      const phaseStart = Date.now();
      const phaseName = phase.name;

      this.broadcast(sessionId, {
        type: "phase_change",
        data: { phase: phaseName, label: phaseName.toUpperCase() },
      });

      // Prepare all domain tasks for this phase, then execute in parallel
      const domainTasks = [];
      for (const domainInfo of phase.domains) {
        const domain = domainInfo.domain;

        // Select agent via epistemic trust
        const candidates = Object.values(AGENT_DEFS).filter(a =>
          a.capabilities.includes(domain) && a.id !== "orchestrator" && a.id !== "reviewer"
        );

        if (candidates.length === 0) continue;

        const selection = globalTrustModel.selectBestAgent(domain, candidates);
        if (!selection.agent) continue;

        session.agentSelections.push({
          domain, agent: selection.agent.id, score: selection.score,
          reasoning: selection.reasoning, isExploratory: selection.isExploratory,
        });

        // Broadcast routing decision
        this.broadcast(sessionId, {
          type: "trust_routing",
          data: {
            domain, agentId: selection.agent.id, agentName: selection.agent.name,
            score: selection.score, reasoning: selection.reasoning,
            isExploratory: selection.isExploratory,
          },
        });

        // Determine artifact type based on phase
        let artifactType = ARTIFACT_TYPES.IMPLEMENTATION;
        if (phaseName === "discovery") artifactType = ARTIFACT_TYPES.EVIDENCE;
        else if (phaseName === "architecture") artifactType = ARTIFACT_TYPES.DECISION;
        else if (phaseName === "verification") artifactType = ARTIFACT_TYPES.CRITIQUE;

        domainTasks.push({ domainInfo, selection, artifactType });
      }

      // Execute all agents in this phase concurrently
      const phaseResults = await Promise.all(
        domainTasks.map(async ({ domainInfo, selection, artifactType }) => {
          const result = await this.callAgent(
            sessionId, selection.agent.id,
            `[${domainInfo.label} domain, entropy: ${domainInfo.entropy.toFixed(2)}] ${taskText}`,
            domainInfo.domain, artifactType
          );
          return { result, selection };
        })
      );

      // Queue for verification if exploratory or low confidence
      for (const { result, selection } of phaseResults) {
        if (selection.isExploratory || result.confidence < CONFIDENCE_THRESHOLD) {
          artifactsToVerify.push({ artifact: result.artifact, isExploratory: selection.isExploratory });
        }
      }

      session.metrics.phaseTimings[phaseName] = Date.now() - phaseStart;

      // Decay pheromone and prune zombie artifacts between phases
      session.trail.decay();
      session.trail.prune();
      phaseIndex++;
    }

    // ── Epistemic Trust Gate: Verify flagged artifacts (parallel) ─
    if (artifactsToVerify.length > 0) {
      this.broadcast(sessionId, { type: "phase_change", data: { phase: "verifying", label: "EPISTEMIC TRUST GATE" } });

      await Promise.all(
        artifactsToVerify.map(({ artifact, isExploratory }) =>
          this.verifyArtifact(sessionId, artifact, isExploratory)
        )
      );
    }

    // ── SYNTHESIS: Combine high-pheromone artifacts ───────────────
    this.broadcast(sessionId, { type: "phase_change", data: { phase: "synthesis", label: "PHEROMONE SYNTHESIS" } });

    const strongArtifacts = session.trail.getStrongArtifacts();
    const trailSummary = strongArtifacts.map(a =>
      `[${a.artifactType.toUpperCase()} | pheromone: ${a.pheromone.toFixed(2)} | by ${a.authorAgent}]\n${a.content.slice(0, 800)}`
    ).join("\n\n---\n\n");

    const synthesis = await this.callAgent(
      sessionId, "orchestrator",
      `Synthesize all high-pheromone artifacts into a final, cohesive deliverable for: "${taskText}"\n\nDo NOT output JSON. Write the actual polished deliverable.`,
      "synthesis",
      ARTIFACT_TYPES.SYNTHESIS,
      `HIGH-PHEROMONE ARTIFACTS (${strongArtifacts.length}):\n\n${trailSummary}`
    );

    // ── Final Decay & Metrics ────────────────────────────────────
    session.trail.decay();
    session.status = "complete";

    const totalDuration = Date.now() - session.metrics.startTime;

    // Persist trust model and session data to disk
    persistence.saveTrustModel(globalTrustModel.trust);
    persistence.saveSession(sessionId, {
      task: taskText,
      status: "complete",
      metrics: session.metrics,
      decomposition: session.decomposition,
      agentSelections: session.agentSelections,
      trailStats: session.trail.getStats(),
    });
    costTracker.persistMetrics(sessionId);
    engineLog.info("Task complete", { sessionId, duration: totalDuration, agentCalls: session.metrics.agentCalls });

    this.broadcast(sessionId, {
      type: "swarm_complete",
      data: {
        task: taskText,
        algorithm: "SESI",
        finalOutput: synthesis.output,
        metrics: {
          duration: totalDuration,
          agentCalls: session.metrics.agentCalls,
          tokensEstimate: session.metrics.tokensEstimate,
          pheromoneTrail: session.trail.getStats(),
          trustProfile: globalTrustModel.getFullProfile(),
          phaseTimings: session.metrics.phaseTimings,
          decomposition: {
            activeDomains: decomposition.activeDomains.length,
            phases: decomposition.phases.length,
          },
          agentSelections: session.agentSelections,
        },
      },
    });

    return {
      finalOutput: synthesis.output,
      metrics: {
        duration: totalDuration,
        agentCalls: session.metrics.agentCalls,
        tokensEstimate: session.metrics.tokensEstimate,
        pheromoneTrail: session.trail.getStats(),
        trustProfile: globalTrustModel.getFullProfile(),
        phaseTimings: session.metrics.phaseTimings,
        decomposition: { activeDomains: decomposition.activeDomains.length, phases: decomposition.phases.length },
        agentSelections: session.agentSelections,
      },
    };
  }
}

const sesi = new SESIEngine();

// ═══════════════════════════════════════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════════════════════════════════════

// Health check endpoint (used by Docker HEALTHCHECK)
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    algorithm: "SESI",
    version: "2.1.0",
    uptime: process.uptime(),
    activeSessions: sesi.sessions.size,
    circuitBreaker: circuitBreaker.getStats(),
  });
});

app.post("/api/sessions", (req, res) => {
  const sessionId = sesi.createSession();
  log.info("Session created", { sessionId });
  res.json({ sessionId, wsUrl: `/ws/${sessionId}`, algorithm: "SESI" });
});

app.post("/api/sessions/:id/run", requireApiKey(), async (req, res) => {
  const { id } = req.params;

  const idCheck = validateSessionId(id);
  if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

  const taskCheck = validateTaskInput(req.body?.task);
  if (!taskCheck.valid) return res.status(400).json({ error: taskCheck.error });

  try {
    const result = await sesi.executeTask(id, taskCheck.sanitized);
    res.json({ success: true, ...result });
  } catch (err) {
    log.error("Task execution failed", { sessionId: id, error: err.message });
    res.status(500).json({ error: "Task execution failed" });
  }
});

app.get("/api/sessions/:id", (req, res) => {
  const idCheck = validateSessionId(req.params.id);
  if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

  const session = sesi.sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    ...session,
    trail: session.trail.getStats(),
    trustProfile: globalTrustModel.getFullProfile(),
  });
});

app.get("/api/trust", (req, res) => {
  res.json(globalTrustModel.getFullProfile());
});

app.get("/api/decompose", (req, res) => {
  const taskCheck = validateTaskInput(req.query?.task);
  if (!taskCheck.valid) return res.status(400).json({ error: taskCheck.error });
  res.json(decomposeTask(taskCheck.sanitized));
});

// Cost tracking endpoint
app.get("/api/costs", (req, res) => {
  res.json(costTracker.getGlobalStats());
});

app.get("/api/costs/:sessionId", (req, res) => {
  const stats = costTracker.getSessionStats(req.params.sessionId);
  if (!stats) return res.status(404).json({ error: "No cost data for session" });
  res.json(stats);
});

// Session history endpoint
app.get("/api/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  res.json(persistence.listSessions(limit));
});

// Error handler (must be last middleware)
app.use(errorHandler());

// ═══════════════════════════════════════════════════════════════════════════
//  WEBSOCKET — real-time streaming to spectators
// ═══════════════════════════════════════════════════════════════════════════

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.pathname.replace("/ws/", "");

  if (!sesi.sessions.has(sessionId)) {
    const newId = sesi.createSession();
    // re-map if needed
  }

  sesi.addSpectator(sessionId, ws);
  ws.send(JSON.stringify({
    type: "connected",
    data: {
      sessionId,
      algorithm: "SESI",
      agents: Object.keys(AGENT_DEFS).map(id => ({ id, name: AGENT_DEFS[id].name, emoji: AGENT_DEFS[id].emoji, role: AGENT_DEFS[id].role, color: AGENT_DEFS[id].color, capabilities: AGENT_DEFS[id].capabilities })),
      trustProfile: globalTrustModel.getFullProfile(),
    },
  }));

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "run_task" && msg.task) {
        sesi.executeTask(sessionId, msg.task).catch(console.error);
      } else if (msg.type === "decompose" && msg.task) {
        ws.send(JSON.stringify({ type: "decomposition", data: decomposeTask(msg.task) }));
      }
    } catch {}
  });

  ws.on("close", () => sesi.removeSpectator(sessionId, ws));
});

// ═══════════════════════════════════════════════════════════════════════════
//  EMBEDDED FRONTEND — served at root
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SESI — Stigmergic Epistemic Swarm Intelligence</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a1a;color:#e0e0e0;font-family:'Inter',system-ui,-apple-system,sans-serif;overflow:hidden}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#2a2a4a;border-radius:3px}
@keyframes sweep{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes typing{0%{opacity:.3}50%{opacity:1}100%{opacity:.3}}

/* Kawaii character animations */
@keyframes idleBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(0.1)}}
@keyframes typing{0%{opacity:.3}50%{opacity:1}100%{opacity:.3}}
@keyframes typingHands{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-1px) rotate(2deg)}}
@keyframes screenGlow{0%,100%{opacity:0.6}50%{opacity:1}}
@keyframes blockDrop{0%{opacity:0;transform:translateY(-20px) scale(0.5)}60%{transform:translateY(2px) scale(1.05)}100%{opacity:1;transform:translateY(0) scale(1)}}
@keyframes blockShine{0%{left:-100%}100%{left:200%}}
@keyframes celebrateJump{0%,100%{transform:translateY(0)}30%{transform:translateY(-8px)}60%{transform:translateY(-4px)}}
@keyframes starPop{0%{opacity:0;transform:scale(0) rotate(0)}50%{opacity:1;transform:scale(1.2) rotate(180deg)}100%{opacity:0;transform:scale(0) rotate(360deg)}}
@keyframes floatUp{0%{opacity:0;transform:translateY(8px)}15%{opacity:1;transform:translateY(0)}85%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-4px)}}
@keyframes blushPulse{0%,100%{opacity:0.4}50%{opacity:0.7}}
@keyframes laptopType{0%,100%{transform:scaleY(1)}50%{transform:scaleY(0.97)}}

.app{display:flex;height:100vh;flex-direction:column}
.header{padding:14px 20px;border-bottom:1px solid #1a1a2e;display:flex;align-items:center;gap:12px}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#8B5CF6,#D97706,#10B981);background-size:200% 200%;animation:gradientShift 4s ease infinite;display:flex;align-items:center;justify-content:center;font-size:18px}
.header h1{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.5px}
.header .sub{font-size:10px;color:#666;margin-top:1px}
.phase-badge{margin-left:auto;display:flex;align-items:center;gap:6px}
.phase-dot{width:8px;height:8px;border-radius:99px;animation:pulse 1s infinite}
.phase-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}

.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:250px;border-right:1px solid #1a1a2e;overflow-y:auto;padding:14px 10px;flex-shrink:0}
.sidebar-title{font-size:9px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;padding-left:4px}

.agent-card{background:#13132a;border:2px solid #222244;border-radius:12px;padding:10px 12px;margin-bottom:6px;transition:all .4s ease;position:relative;overflow:hidden}
.agent-card.active{transform:scale(1.02)}
.agent-card .sweep-bar{position:absolute;top:0;left:0;height:3px;width:100%;animation:sweep 1.5s infinite}
.agent-card .head{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.agent-card .emoji{font-size:20px}
.agent-card .name{font-weight:700;color:#fff;font-size:12px}
.agent-card .role{font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:1px}
.agent-card .trust-bar{height:3px;background:#1a1a2e;border-radius:2px;margin-top:4px;overflow:hidden}
.agent-card .trust-fill{height:100%;border-radius:2px;transition:width .5s ease}
.agent-card .trust-label{font-size:8px;color:#555;margin-top:2px}
.agent-card .action{margin-top:5px;padding:5px 7px;background:#0b0b1a;border-radius:5px;font-size:9px;font-family:'JetBrains Mono',monospace;line-height:1.4;border-left:3px solid}
.agent-card .badge{margin-left:auto;border-radius:99px;font-size:8px;font-weight:700;padding:2px 5px;color:#fff}

.content{flex:1;display:flex;flex-direction:column;min-width:0}
.input-area{padding:12px 18px;border-bottom:1px solid #1a1a2e}
.input-row{display:flex;gap:8px}
.input-row input{flex:1;padding:10px 13px;background:#12122a;border:2px solid #2a2a4a;border-radius:10px;color:#fff;font-size:13px;outline:none;font-family:inherit}
.input-row input::placeholder{color:#555}
.input-row button{padding:10px 18px;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;white-space:nowrap}
.btn-deploy{background:linear-gradient(135deg,#8B5CF6,#D97706);color:#fff}
.btn-deploy:disabled{background:#2a2a4a;color:#555;cursor:default}
.presets{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap}
.presets button{padding:3px 8px;background:#13132a;border:1px solid #222244;border-radius:5px;color:#777;font-size:9px;cursor:pointer;font-family:inherit}

.stream-indicator{display:inline-flex;gap:2px;margin-left:4px;vertical-align:middle}
.stream-indicator span{width:4px;height:4px;border-radius:50%;animation:typing .8s infinite}
.stream-indicator span:nth-child(2){animation-delay:.15s}
.stream-indicator span:nth-child(3){animation-delay:.3s}

/* Canvas area */
.canvas-area{flex:1;position:relative;overflow:hidden;background:radial-gradient(ellipse at 50% 100%,#12122e 0%,#0a0a1a 70%)}
.canvas-floor{position:absolute;bottom:0;left:0;right:0;height:50px;background:linear-gradient(180deg,#13132a00,#13132a);border-top:1px solid #1e1e3a}
.canvas-stars{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.canvas-star{position:absolute;width:2px;height:2px;background:#fff;border-radius:50%;opacity:0.2;animation:pulse 3s infinite}

/* Kawaii character wrapper */
.kw-char{position:absolute;bottom:55px;display:flex;flex-direction:column;align-items:center;transition:left 1s ease,opacity 0.4s ease}
.kw-char.idle .kw-body{animation:idleBob 2.5s ease-in-out infinite}
.kw-char.busy .kw-body{animation:idleBob 1.2s ease-in-out infinite}
.kw-char.done .kw-body{animation:celebrateJump 0.6s ease infinite}

/* Bubble */
.kw-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:6px;background:#181835ee;border:1px solid;border-radius:10px;padding:4px 10px;font-size:8px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;animation:floatUp 4s ease-in-out infinite;backdrop-filter:blur(6px)}
.kw-bubble::after{content:'';position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:4px solid #181835}

/* Name label */
.kw-name{font-size:9px;font-weight:700;letter-spacing:0.5px;margin-bottom:3px;white-space:nowrap;text-shadow:0 1px 4px rgba(0,0,0,0.6)}

/* Body container */
.kw-body{position:relative;width:56px;height:62px}

/* Big round head (kawaii = big head!) */
.kw-head{position:absolute;top:0;left:50%;transform:translateX(-50%);width:32px;height:30px;border-radius:50%;border:2px solid;z-index:2}
.kw-eyes{position:absolute;top:11px;left:50%;transform:translateX(-50%);display:flex;gap:8px}
.kw-eye{width:4px;height:5px;background:#fff;border-radius:50%;animation:blink 3.5s infinite;position:relative}
.kw-eye::after{content:'';position:absolute;top:0;right:0;width:2px;height:2px;background:#fff;border-radius:50%;opacity:0.8}
.kw-mouth{position:absolute;top:19px;left:50%;transform:translateX(-50%);width:5px;height:3px;border-radius:0 0 5px 5px;background:#ffffff40}
.kw-blush-l,.kw-blush-r{position:absolute;top:16px;width:5px;height:3px;border-radius:50%;opacity:0.5;animation:blushPulse 2s infinite}
.kw-blush-l{left:4px}
.kw-blush-r{right:4px}

/* Hair - boy style */
.kw-hair-boy{position:absolute;top:-5px;left:50%;transform:translateX(-50%);z-index:3;width:30px;height:12px}
.kw-spike{position:absolute;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent}
.kw-spike:nth-child(1){left:2px;top:0}
.kw-spike:nth-child(2){left:9px;top:-3px}
.kw-spike:nth-child(3){right:2px;top:1px}

/* Hair - girl style */
.kw-hair-girl{position:absolute;top:-5px;left:50%;transform:translateX(-50%);z-index:3;width:36px;height:16px;border-radius:18px 18px 0 0}
.kw-pigtail-l,.kw-pigtail-r{position:absolute;bottom:-10px;width:5px;height:14px;border-radius:0 0 4px 4px}
.kw-pigtail-l{left:2px}
.kw-pigtail-r{right:2px}
.kw-bow{position:absolute;top:-2px;right:0;z-index:4}
.kw-bow::before,.kw-bow::after{content:'';position:absolute;width:5px;height:5px;border-radius:50%;top:0}
.kw-bow::before{left:-3px}
.kw-bow::after{right:-3px}

/* Small body */
.kw-torso{position:absolute;top:28px;left:50%;transform:translateX(-50%);width:20px;height:14px;border-radius:6px 6px 3px 3px;border:2px solid;z-index:1}

/* Tiny arms - one types! */
.kw-arm-l,.kw-arm-r{position:absolute;top:30px;width:5px;height:10px;border-radius:3px;z-index:1}
.kw-arm-l{left:10px}
.kw-arm-r{right:10px}
.busy .kw-arm-l,.busy .kw-arm-r{animation:typingHands 0.3s ease-in-out infinite}
.busy .kw-arm-r{animation-delay:0.15s}

/* Tiny legs */
.kw-leg-l,.kw-leg-r{position:absolute;top:40px;width:5px;height:10px;border-radius:3px}
.kw-leg-l{left:18px}
.kw-leg-r{right:18px}
.kw-foot-l,.kw-foot-r{position:absolute;top:49px;width:7px;height:4px;border-radius:2px 4px 2px 2px}
.kw-foot-l{left:16px}
.kw-foot-r{right:16px}

/* Laptop/desk */
.kw-desk{position:absolute;bottom:-2px;left:50%;transform:translateX(-50%);width:48px;height:6px;border-radius:2px;z-index:0}
.kw-laptop{position:absolute;bottom:4px;left:50%;transform:translateX(-50%);z-index:0}
.kw-laptop-base{width:24px;height:3px;border-radius:1px;margin:0 auto}
.kw-laptop-screen{width:20px;height:14px;border-radius:2px 2px 0 0;margin:0 auto;position:relative;overflow:hidden}
.busy .kw-laptop-screen{animation:laptopType 0.5s ease-in-out infinite}
.kw-screen-lines{position:absolute;top:3px;left:3px;right:3px;bottom:2px;display:flex;flex-direction:column;gap:2px}
.kw-screen-line{height:1px;border-radius:1px;opacity:0.7}
.busy .kw-screen-line{animation:screenGlow 1.5s ease-in-out infinite}
.busy .kw-screen-line:nth-child(2){animation-delay:0.3s}
.busy .kw-screen-line:nth-child(3){animation-delay:0.6s}

/* Code block stack */
.kw-blocks{position:absolute;bottom:10px;display:flex;flex-direction:column-reverse;align-items:center;gap:2px}
.kw-block{width:28px;height:10px;border-radius:3px;animation:blockDrop 0.4s ease-out;position:relative;overflow:hidden;display:flex;align-items:center;padding-left:3px}
.kw-block::after{content:'';position:absolute;top:0;width:10px;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.15),transparent);animation:blockShine 2s linear infinite}
.kw-block-line{width:60%;height:2px;border-radius:1px;background:rgba(255,255,255,0.3)}

/* Done stars */
.kw-star{position:absolute;width:6px;height:6px;animation:starPop 1s ease-out infinite}
.kw-star::before,.kw-star::after{content:'';position:absolute;background:currentColor}
.kw-star::before{width:6px;height:2px;top:2px;left:0;border-radius:1px}
.kw-star::after{width:2px;height:6px;top:0;left:2px;border-radius:1px}

/* Shadow */
.kw-shadow{position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);width:36px;height:5px;border-radius:50%;opacity:0.2}

/* Status area below canvas */
.status-bar{padding:6px 18px;border-top:1px solid #1a1a2e;display:flex;align-items:center;gap:12px;background:#0a0a1a;flex-shrink:0}
.status-bar .phase-info{font-size:10px;font-weight:600;letter-spacing:0.5px}
.status-bar .stats{font-size:9px;color:#666;margin-left:auto;display:flex;gap:10px}
.status-bar .stats span{color:#F59E0B;font-weight:600}

/* Output panel */
.output-panel{max-height:45vh;overflow-y:auto;border-top:1px solid #1a1a2e;padding:12px 18px;flex-shrink:0}
.output-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px}
.output-toggle .label{font-size:10px;font-weight:700;color:#10B981;text-transform:uppercase;letter-spacing:1px}
.output-toggle .arrow{font-size:10px;color:#10B981;transition:transform 0.2s}

.final-output{text-align:left;background:#0a0a1a;border:1px solid #10B98130;border-radius:10px;overflow:hidden;animation:fadeIn 0.3s ease}
.final-output-header{padding:10px 14px;background:#10B98110;border-bottom:1px solid #10B98120;display:flex;align-items:center;gap:8px}
.final-output-header .label{font-size:11px;font-weight:700;color:#10B981;text-transform:uppercase;letter-spacing:1px}
.final-output-body{padding:14px 16px;font-size:11px;color:#c8d6e5;line-height:1.6;max-height:400px;overflow-y:auto}

.complete-banner{text-align:center;padding:12px;margin-bottom:10px;background:linear-gradient(135deg,#10B98112,#D9770612);border-radius:10px;border:1px solid #10B98130}
.complete-banner .title{font-weight:700;color:#10B981;font-size:13px}
.complete-banner .sub{font-size:10px;color:#666;margin-top:3px}
.metrics{display:flex;gap:12px;justify-content:center;margin-top:6px;flex-wrap:wrap}
.metric{font-size:9px;color:#888}.metric span{color:#10B981;font-weight:600}

/* Empty state in canvas */
.canvas-empty{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#333}
.canvas-empty .icon{font-size:48px;margin-bottom:12px}
.canvas-empty .title{font-size:15px;font-weight:600;color:#555;margin-bottom:6px}
.canvas-empty .sub{font-size:11px;color:#444;max-width:350px;line-height:1.5}
</style>
</head>
<body>
<div class="app" id="app"></div>
<script>
const state={sessionId:null,ws:null,connected:false,running:false,agents:{},activeAgents:new Set(),busyAgents:new Set(),agentActions:{},agentStreams:{},messageCounts:{},log:[],phase:null,decomposition:null,trustProfile:{},trailStats:null,metrics:null,finalOutput:null,completedSteps:0,totalSteps:0,taskCount:0};
const PC={decomposing:"#8B5CF6",discovery:"#3B82F6",architecture:"#D97706",execution:"#10B981",verification:"#EF4444",verifying:"#EF4444",synthesis:"#8B5CF6"};

async function init(){
  const r=await fetch("/api/sessions",{method:"POST"});const{sessionId}=await r.json();state.sessionId=sessionId;
  const proto=location.protocol==="https:"?"wss":"ws";
  const ws=new WebSocket(proto+"://"+location.host+"/ws/"+sessionId);state.ws=ws;
  ws.onopen=()=>{state.connected=true;scheduleRender()};ws.onclose=()=>{state.connected=false;scheduleRender()};
  ws.onmessage=(e)=>handle(JSON.parse(e.data));
}

function handle(m){
  switch(m.type){
    case "connected":m.data.agents.forEach(a=>{state.agents[a.id]=a});state.trustProfile=m.data.trustProfile||{};scheduleRender();break;
    case "swarm_start":state.running=true;state.log=[];state.decomposition=null;state.trailStats=null;state.metrics=null;state.finalOutput=null;state.activeAgents.clear();state.busyAgents.clear();state.agentActions={};state.agentStreams={};state.messageCounts={};state.completedSteps=0;scheduleRender();break;
    case "phase_change":state.phase=m.data;scheduleRender();break;
    case "decomposition_complete":state.decomposition=m.data;state.totalSteps=m.data.activeDomains.length+2;scheduleRender();break;
    case "trust_routing":state.log.push({type:"routing",...m.data,time:ts()});scheduleRender();break;
    case "trust_update":if(state.trustProfile[m.data.agentId])state.trustProfile[m.data.agentId][m.data.domain]=m.data.newTrust;scheduleRender();break;
    case "agent_start":state.activeAgents.add(m.data.agentId);state.busyAgents.add(m.data.agentId);state.agentActions[m.data.agentId]=m.data.task?.slice(0,80)+"...";state.agentStreams[m.data.agentId]="";state.messageCounts[m.data.agentId]=(state.messageCounts[m.data.agentId]||0)+1;scheduleRender();break;
    case "agent_token":state.agentStreams[m.data.agentId]=(state.agentStreams[m.data.agentId]||"")+m.data.token;state.agentActions[m.data.agentId]=state.agentStreams[m.data.agentId].slice(-120);updateAgentToken(m.data.agentId);break;
    case "agent_complete":state.busyAgents.delete(m.data.agentId);state.agentActions[m.data.agentId]=null;state.agentStreams[m.data.agentId]="";state.completedSteps++;state.log.push({agentId:m.data.agentId,name:m.data.name,output:m.data.output,artifactType:m.data.artifactType,domain:m.data.domain,confidence:m.data.confidence,pheromone:m.data.pheromone,time:ts(),agent:state.agents[m.data.agentId]});scheduleRender();break;
    case "swarm_complete":state.running=false;state.phase=null;state.metrics=m.data.metrics;state.finalOutput=m.data.finalOutput||null;state.taskCount++;scheduleRender();break;
  }
}

function ts(){return new Date().toTimeString().slice(0,8)}
function submit(t){if(!t.trim()||state.running||!state.ws)return;state.ws.send(JSON.stringify({type:"run_task",task:t}))}
function esc(s){return(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function md(s){
  return esc(s)
    .replace(/^### (.+)$/gm,'<div style="font-size:11px;font-weight:700;color:#c4b5fd;margin:8px 0 3px">$1</div>')
    .replace(/^## (.+)$/gm,'<div style="font-size:12px;font-weight:700;color:#e0e0e0;margin:10px 0 4px;border-bottom:1px solid #ffffff10;padding-bottom:3px">$1</div>')
    .replace(/^# (.+)$/gm,'<div style="font-size:13px;font-weight:800;color:#fff;margin:10px 0 5px">$1</div>')
    .replace(/\*\*(.+?)\*\*/g,'<strong style="color:#f0f0f0">$1</strong>')
    .replace(/^- (.+)$/gm,'<div style="padding-left:10px;margin:1px 0"><span style="color:#8B5CF6;margin-right:4px">&#8226;</span>$1</div>')
    .replace(/\n/g,'<br>');
}

let renderPending=false;
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;render()});}

function updateAgentToken(agentId){
  // Update sidebar card action text
  const cards=document.querySelectorAll(".agent-card");
  const al=Object.values(state.agents);
  const idx=al.findIndex(a=>a.id===agentId);
  if(idx<0||!cards[idx])return scheduleRender();
  const card=cards[idx];const a=al[idx];
  const action=state.agentActions[agentId];const busy=state.busyAgents.has(agentId);
  let actionEl=card.querySelector(".action");
  if(action){
    const html=esc(action.slice(-100))+(busy?'<span class="stream-indicator"><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span></span>':"");
    if(actionEl){actionEl.innerHTML=html;}
    else{actionEl=document.createElement("div");actionEl.className="action";actionEl.style.cssText="color:"+a.color+";border-color:"+a.color;actionEl.innerHTML=html;card.appendChild(actionEl);}
  }else if(actionEl){actionEl.remove();}
  // Update canvas bubble
  const bubble=document.querySelector('.kw-bubble[data-agent="'+agentId+'"]');
  if(bubble&&action){bubble.textContent=action.slice(-35);}
}

// Gender assignment for kawaii characters (alternating boy/girl)
const GENDER_MAP={orchestrator:'boy',researcher:'girl',planner:'boy',senior:'girl',frontend:'boy',backend:'girl',systems:'boy',writer:'girl',reviewer:'boy'};

function buildKawaii(agent,idx,total,isBusy,isDone,action,blockCount){
  const g=GENDER_MAP[agent.id]||(idx%2===0?'boy':'girl');
  const spacing=total>1?80/(total-1):50;
  const leftPct=total>1?10+idx*spacing:50;
  const st=isBusy?'busy':(isDone?'done':'idle');
  const c=agent.color;
  const blocks=Math.min(blockCount||0,6);

  // Build stacking code blocks
  var blockHtml='';
  if(blocks>0){
    blockHtml='<div class="kw-blocks" style="right:-18px">';
    for(var b=0;b<blocks;b++){
      var opacity=0.5+b*0.1;
      blockHtml+='<div class="kw-block" style="background:'+c+';opacity:'+opacity+';animation-delay:'+b*0.1+'s"><div class="kw-block-line"></div></div>';
    }
    blockHtml+='</div>';
  }

  return '<div class="kw-char '+st+'" style="left:'+leftPct+'%;transform:translateX(-50%)">'
    // Speech bubble
    +(action?'<div class="kw-bubble" data-agent="'+agent.id+'" style="border-color:'+c+'50;color:'+c+'">'+esc((action||'').slice(-35))+'</div>':'')
    // Name
    +'<div class="kw-name" style="color:'+c+'">'+agent.emoji+' '+agent.name+'</div>'
    +'<div class="kw-body">'
    // Head (big kawaii head!)
    +'<div class="kw-head" style="background:'+c+'18;border-color:'+c+'">'
    +'<div class="kw-eyes"><div class="kw-eye"></div><div class="kw-eye"></div></div>'
    +'<div class="kw-mouth"></div>'
    +'<div class="kw-blush-l" style="background:'+c+'"></div>'
    +'<div class="kw-blush-r" style="background:'+c+'"></div>'
    +'</div>'
    // Hair
    +(g==='girl'
      ?'<div class="kw-hair-girl" style="background:'+c+'70">'
       +'<div class="kw-pigtail-l" style="background:'+c+'70"></div>'
       +'<div class="kw-pigtail-r" style="background:'+c+'70"></div>'
       +'<div class="kw-bow" style="color:'+c+'"><span style="position:absolute;top:-1px;left:50%;transform:translateX(-50%);width:3px;height:3px;background:'+c+';border-radius:50%"></span></div>'
       +'</div>'
      :'<div class="kw-hair-boy">'
       +'<div class="kw-spike" style="border-bottom:9px solid '+c+'"></div>'
       +'<div class="kw-spike" style="border-bottom:11px solid '+c+'"></div>'
       +'<div class="kw-spike" style="border-bottom:8px solid '+c+'"></div>'
       +'</div>')
    // Body
    +'<div class="kw-torso" style="background:'+c+'20;border-color:'+c+'60"></div>'
    +'<div class="kw-arm-l" style="background:'+c+'50"></div>'
    +'<div class="kw-arm-r" style="background:'+c+'50"></div>'
    +'<div class="kw-leg-l" style="background:'+c+'35"></div>'
    +'<div class="kw-leg-r" style="background:'+c+'35"></div>'
    +'<div class="kw-foot-l" style="background:'+c+'"></div>'
    +'<div class="kw-foot-r" style="background:'+c+'"></div>'
    // Laptop
    +'<div class="kw-laptop">'
    +'<div class="kw-laptop-screen" style="background:'+c+'30;border:1px solid '+c+'50">'
    +'<div class="kw-screen-lines">'
    +'<div class="kw-screen-line" style="background:'+c+';width:70%"></div>'
    +'<div class="kw-screen-line" style="background:'+c+';width:50%"></div>'
    +'<div class="kw-screen-line" style="background:'+c+';width:85%"></div>'
    +'</div></div>'
    +'<div class="kw-laptop-base" style="background:'+c+'60"></div>'
    +'</div>'
    // Desk
    +'<div class="kw-desk" style="background:'+c+'15;border:1px solid '+c+'25"></div>'
    // Shadow
    +'<div class="kw-shadow" style="background:'+c+'"></div>'
    +'</div>'
    // Stacking blocks
    +blockHtml
    // Done stars
    +(isDone
      ?'<div class="kw-star" style="color:'+c+';top:-5px;left:0;animation-delay:0s"></div>'
       +'<div class="kw-star" style="color:'+c+';top:-10px;right:0;animation-delay:0.3s"></div>'
       +'<div class="kw-star" style="color:'+c+';top:5px;right:-8px;animation-delay:0.6s"></div>'
      :'')
    +'</div>';
}

function generateStars(){
  let s='';
  for(let i=0;i<40;i++){
    const x=Math.random()*100;const y=Math.random()*100;const d=Math.random()*3;const sz=1+Math.random()*2;
    s+='<div class="canvas-star" style="left:'+x+'%;top:'+y+'%;width:'+sz+'px;height:'+sz+'px;animation-delay:'+d+'s"></div>';
  }
  return s;
}

function render(){
  const app=document.getElementById("app");
  const al=Object.values(state.agents);
  // Determine which agents to show on canvas
  const canvasAgents=al.filter(a=>state.activeAgents.has(a.id));
  const hasActivity=canvasAgents.length>0||state.finalOutput||state.decomposition;

  app.innerHTML=
    '<div class="header">'
    +'<div class="logo">🧬</div>'
    +'<div><h1>SESI Protocol</h1><p class="sub">Stigmergic Epistemic Swarm Intelligence · '+al.length+' agents · '+state.taskCount+' task'+(state.taskCount===1?'':'s')+'</p></div>'
    +(state.phase?'<div class="phase-badge"><div class="phase-dot" style="background:'+(PC[state.phase.phase]||'#8B5CF6')+'"></div><span class="phase-label" style="color:'+(PC[state.phase.phase]||'#8B5CF6')+'">'+state.phase.label+'</span></div>':'')
    +'<div style="font-size:10px;color:#555;margin-left:auto">'+(state.connected?'<span style="color:#10B981">● Live</span>':'Connecting...')+' · '+(state.sessionId||'...')+'</div>'
    +'</div>'
    +'<div class="main">'
    // Sidebar
    +'<div class="sidebar">'
    +'<div class="sidebar-title">Agent Fleet + Trust</div>'
    +al.map(function(a){
      var active=state.activeAgents.has(a.id),busy=state.busyAgents.has(a.id);
      var action=state.agentActions[a.id],count=state.messageCounts[a.id]||0;
      var tp=state.trustProfile[a.id]||{};
      var entries=Object.entries(tp).sort(function(x,y){return(y[1].expected||0)-(x[1].expected||0)});
      var bestDomain=entries[0];
      var trustPct=bestDomain?Math.round((bestDomain[1].expected||0)*100):0;
      return '<div class="agent-card'+(active?' active':'')+'" style="border-color:'+(active?a.color:'#222244')+';'+(active?'box-shadow:0 0 12px '+a.color+'30;background:'+a.color+'12':'')+'">'
        +(busy?'<div class="sweep-bar" style="background:linear-gradient(90deg,transparent,'+a.color+',transparent)"></div>':'')
        +'<div class="head"><span class="emoji">'+a.emoji+'</span><div style="flex:1"><div class="name">'+a.name+'</div><div class="role" style="color:'+a.color+'">'+a.role+'</div></div>'
        +(count?'<span class="badge" style="background:'+a.color+'">'+count+'</span>':'')
        +'</div>'
        +(bestDomain?'<div class="trust-bar"><div class="trust-fill" style="width:'+trustPct+'%;background:'+a.color+'"></div></div><div class="trust-label">Trust: '+trustPct+'% in '+bestDomain[0]+'</div>':'')
        +(action?'<div class="action" style="color:'+a.color+';border-color:'+a.color+'">'+esc(action.slice(-100))+(busy?'<span class="stream-indicator"><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span></span>':'')+'</div>':'')
        +'</div>';
    }).join('')
    +'</div>'
    // Content - Canvas
    +'<div class="content">'
    +'<div class="input-area"><div class="input-row">'
    +'<input id="ti" placeholder="Describe a task — SESI agents will decompose, route by trust, and collaborate..." '+(state.running?'disabled':'')+' onkeydown="if(event.key===\'Enter\')submit(this.value)">'
    +'<button class="btn-deploy" onclick="submit(document.getElementById(\'ti\').value)" '+(state.running?'disabled':'')+'>Deploy SESI</button>'
    +'</div>'
    +'<div class="presets">'+["Build a SaaS MVP with auth and billing","Architect a scalable microservices system","Write a technical deep-dive on event sourcing","Create a real-time chat architecture","Design a CI/CD pipeline for Kubernetes"].map(function(p){return '<button onclick="document.getElementById(\'ti\').value=\''+p+'\'">'+p+'</button>';}).join('')+'</div>'
    +'</div>'
    // Canvas
    +'<div class="canvas-area">'
    +'<div class="canvas-stars">'+generateStars()+'</div>'
    +'<div class="canvas-floor"></div>'
    +(!hasActivity
      ?'<div class="canvas-empty"><div class="icon">🧬</div><div class="title">SESI Protocol standing by</div><div class="sub">Enter any task — cute agents will appear here and start building your solution block by block!</div></div>'
      :canvasAgents.map(function(a,i){
        var busy=state.busyAgents.has(a.id);
        var done=!busy&&state.log.some(function(e){return e.agentId===a.id;});
        var action=state.agentActions[a.id];
        var msgCount=state.messageCounts[a.id]||0;
        return buildKawaii(a,i,canvasAgents.length,busy,done,action,msgCount);
      }).join(''))
    +'</div>'
    // Status bar
    +(state.phase||state.metrics
      ?'<div class="status-bar">'
       +(state.phase?'<div class="phase-info" style="color:'+(PC[state.phase.phase]||'#8B5CF6')+'">'+state.phase.label+'</div>':'')
       +(state.decomposition?'<span style="font-size:9px;color:#555">'+state.decomposition.activeDomains.length+' domains · '+state.decomposition.phases.length+' phases</span>':'')
       +'<div class="stats">'
       +(state.metrics?'<span>'+state.metrics.agentCalls+' calls</span> · <span>'+(state.metrics.pheromoneTrail?.total||0)+' artifacts</span> · <span>'+(state.metrics.duration/1000).toFixed(1)+'s</span>':'')
       +'</div></div>'
      :'')
    // Output panel
    +(state.finalOutput||(!state.running&&state.metrics)
      ?'<div class="output-panel">'
       +(!state.running&&state.metrics
         ?'<div class="complete-banner"><div class="title">SESI task complete</div><div class="sub">'+state.metrics.agentCalls+' agent calls · '+(state.metrics.pheromoneTrail?.total||0)+' artifacts · trust updated</div>'
          +'<div class="metrics"><div class="metric">Duration: <span>'+(state.metrics.duration/1000).toFixed(1)+'s</span></div><div class="metric">Domains: <span>'+(state.metrics.decomposition?.activeDomains||0)+'</span></div><div class="metric">Phases: <span>'+(state.metrics.decomposition?.phases||0)+'</span></div><div class="metric">Tokens: <span>~'+state.metrics.tokensEstimate+'</span></div></div></div>'
         :'')
       +(state.finalOutput
         ?'<div class="final-output"><div class="final-output-header"><span style="font-size:16px">📋</span><span class="label">Final Deliverable</span></div><div class="final-output-body">'+md(state.finalOutput)+'</div></div>'
         :'')
       +'</div>'
      :'')
    +'</div>'
    +'</div>';
}
render();init();
</script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  const model = process.env.SESI_MODEL || "claude-sonnet-4-20250514";
  log.info(`SESI Protocol v2.1 started on port ${PORT}`, {
    agents: Object.keys(AGENT_DEFS).length,
    model,
    trustRestored: !!savedTrust,
  });
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   🧬 SESI PROTOCOL — Agent Swarm Server v2.1        ║
  ║   Stigmergic Epistemic Swarm Intelligence            ║
  ║                                                      ║
  ║   Local:   http://localhost:${PORT}                    ║
  ║   Status:  Ready                                     ║
  ║   Agents:  ${Object.keys(AGENT_DEFS).length} active                                ║
  ║   Model:   ${model.padEnd(38)}║
  ║   Algorithm: SESI (Pheromone + Trust + Entropy)      ║
  ║                                                      ║
  ║   Features:                                          ║
  ║     + Trust persistence (survives restarts)          ║
  ║     + Cost tracking per session                      ║
  ║     + API retry with exponential backoff             ║
  ║     + Input validation & rate limiting               ║
  ║     + Structured logging                             ║
  ╚══════════════════════════════════════════════════════╝
  `);
});
