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
    } catch { }
  });

  ws.on("close", () => sesi.removeSpectator(sessionId, ws));
});

// ═══════════════════════════════════════════════════════════════════════════
//  EMBEDDED FRONTEND — served at root
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("ETag", `"${Date.now()}"`);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SESI — Stigmergic Epistemic Swarm Intelligence</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080818;color:#e0e0e0;font-family:'Inter',system-ui,sans-serif;overflow:hidden}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#2a2a4a;border-radius:3px}

@keyframes idleBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes workBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(0.05)}}
@keyframes typingL{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg) translateY(-2px)}}
@keyframes typingR{0%,100%{transform:rotate(4deg)}50%{transform:rotate(-4deg) translateY(-2px)}}
@keyframes screenGlow{0%,100%{opacity:.4}50%{opacity:1}}
@keyframes celebrate{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-18px) rotate(-6deg)}75%{transform:translateY(-12px) rotate(6deg)}}
@keyframes sparkle{0%{opacity:0;transform:scale(0) rotate(0)}50%{opacity:1;transform:scale(1.2) rotate(180deg)}100%{opacity:0;transform:scale(0) rotate(360deg)}}
@keyframes floatBubble{0%{opacity:0;transform:translateX(-50%) translateY(6px)}12%{opacity:1;transform:translateX(-50%) translateY(0)}88%{opacity:1}100%{opacity:0;transform:translateX(-50%) translateY(-4px)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes sweep{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes twinkle{0%,100%{opacity:.08}50%{opacity:.5}}
@keyframes breathe{0%,100%{transform:scaleX(1)}50%{transform:scaleX(1.02)}}
@keyframes blushPulse{0%,100%{opacity:.25}50%{opacity:.55}}
@keyframes codeFloat{0%{opacity:0;transform:translateY(10px)}15%{opacity:.5}85%{opacity:.5}100%{opacity:0;transform:translateY(-20px)}}

.app{display:flex;height:100vh;flex-direction:column}
.header{padding:14px 24px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:14px;background:rgba(10,10,26,.85);backdrop-filter:blur(20px);z-index:10}
.logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#8B5CF6,#D97706,#10B981);background-size:200% 200%;animation:gradientShift 4s ease infinite;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 4px 15px rgba(139,92,246,.25)}
.header h1{font-size:18px;font-weight:900;color:#fff;letter-spacing:-.5px}
.header .sub{font-size:10px;color:rgba(255,255,255,.3);margin-top:2px;font-weight:500}
.phase-badge{display:flex;align-items:center;gap:6px}
.phase-dot{width:8px;height:8px;border-radius:99px;animation:pulse 1.2s infinite}
.phase-label{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
.conn-info{font-size:10px;color:rgba(255,255,255,.25);margin-left:auto}

.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:260px;border-right:1px solid rgba(255,255,255,.04);overflow-y:auto;padding:16px 12px;flex-shrink:0;background:rgba(8,8,24,.4)}
.sidebar-title{font-size:9px;font-weight:700;color:rgba(255,255,255,.2);text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;padding-left:4px}

.agent-card{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:11px 13px;margin-bottom:6px;transition:all .4s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden}
.agent-card.active{box-shadow:0 0 20px rgba(139,92,246,.12)}
.agent-card .sweep-bar{position:absolute;top:0;left:0;height:2px;width:100%;animation:sweep 1.8s infinite}
.agent-card .ac-head{display:flex;align-items:center;gap:10px;margin-bottom:3px}
.agent-card .emoji{font-size:22px}
.agent-card .name{font-weight:700;color:#fff;font-size:12px}
.agent-card .role{font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px}
.agent-card .trust-bar{height:3px;background:rgba(255,255,255,.05);border-radius:2px;margin-top:5px;overflow:hidden}
.agent-card .trust-fill{height:100%;border-radius:2px;transition:width .6s cubic-bezier(.4,0,.2,1)}
.agent-card .trust-label{font-size:8px;color:rgba(255,255,255,.2);margin-top:3px}
.agent-card .action{margin-top:6px;padding:6px 8px;background:rgba(0,0,0,.25);border-radius:8px;font-size:9px;font-family:'JetBrains Mono',monospace;line-height:1.5;border-left:3px solid;max-height:70px;overflow:hidden;word-break:break-word}
.agent-card .badge{margin-left:auto;border-radius:99px;font-size:8px;font-weight:700;padding:3px 8px;color:#fff}

.content{flex:1;display:flex;flex-direction:column;min-width:0}
.input-area{padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.04);background:rgba(8,8,24,.5)}
.input-row{display:flex;gap:10px}
.input-row input{flex:1;padding:12px 16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;color:#fff;font-size:14px;outline:none;font-family:inherit;transition:border-color .3s,box-shadow .3s}
.input-row input:focus{border-color:rgba(139,92,246,.5);box-shadow:0 0 20px rgba(139,92,246,.08)}
.input-row input::placeholder{color:rgba(255,255,255,.2)}
.input-row button{padding:12px 22px;border:none;border-radius:12px;font-weight:700;cursor:pointer;font-size:14px;font-family:inherit;white-space:nowrap;transition:transform .15s,box-shadow .15s}
.input-row button:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px rgba(139,92,246,.25)}
.btn-deploy{background:linear-gradient(135deg,#8B5CF6,#D97706);color:#fff}
.btn-deploy:disabled{background:rgba(255,255,255,.06);color:rgba(255,255,255,.2);cursor:default}
.presets{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.presets button{padding:4px 10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;color:rgba(255,255,255,.35);font-size:9px;cursor:pointer;font-family:inherit;transition:all .2s}
.presets button:hover{background:rgba(139,92,246,.08);border-color:rgba(139,92,246,.25);color:rgba(255,255,255,.6)}

.si{display:inline-flex;gap:3px;margin-left:5px;vertical-align:middle}
.si span{width:4px;height:4px;border-radius:50%;animation:pulse .8s infinite}
.si span:nth-child(2){animation-delay:.15s}
.si span:nth-child(3){animation-delay:.3s}

.canvas-area{flex:1;position:relative;overflow:hidden;background:radial-gradient(ellipse at 50% 130%,#12122e 0%,#080818 65%)}
.canvas-floor{position:absolute;bottom:0;left:0;right:0;height:90px;background:linear-gradient(180deg,transparent,rgba(15,15,40,.9));pointer-events:none}
.canvas-stars{position:absolute;inset:0;pointer-events:none}
.canvas-star{position:absolute;width:2px;height:2px;background:#fff;border-radius:50%;animation:twinkle 4s ease-in-out infinite}

.chars-wrap{position:absolute;bottom:80px;left:0;right:0;display:flex;justify-content:center;gap:140px;pointer-events:none}
.char{display:flex;flex-direction:column;align-items:center;position:relative}
.char.idle .cw{animation:idleBob 3s ease-in-out infinite}
.char.working .cw{animation:workBob 1.5s ease-in-out infinite}
.char.done .cw{animation:celebrate .8s ease-in-out infinite}

.char-bubble{position:absolute;bottom:calc(100% + 12px);left:50%;transform:translateX(-50%);background:rgba(15,15,40,.88);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:6px 14px;font-size:9px;font-weight:600;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:opacity .4s;z-index:5;box-shadow:0 4px 20px rgba(0,0,0,.4)}
.char-bubble.on{opacity:1;animation:floatBubble 5s ease-in-out infinite}
.char-bubble::after{content:'';position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid rgba(15,15,40,.88)}

.cn{font-size:11px;font-weight:700;letter-spacing:.8px;margin-bottom:6px;text-shadow:0 2px 8px rgba(0,0,0,.6)}
.cw{position:relative;width:90px;height:130px}

.c-head{position:absolute;top:0;left:50%;transform:translateX(-50%);width:56px;height:52px;border-radius:50%;z-index:3;box-shadow:inset 0 -3px 6px rgba(0,0,0,.08)}
.c-eyes{position:absolute;top:19px;left:50%;transform:translateX(-50%);display:flex;gap:15px}
.c-eye{width:7px;height:9px;background:#1a1a2a;border-radius:50%;position:relative;animation:blink 4s infinite}
.c-eye::after{content:'';position:absolute;top:1px;right:1px;width:3px;height:3px;background:#fff;border-radius:50%}
.c-mouth{position:absolute;top:34px;left:50%;transform:translateX(-50%);width:8px;height:4px;border-radius:0 0 8px 8px;background:rgba(0,0,0,.15)}
.working .c-mouth{width:6px;height:6px;border-radius:50%}
.c-blush{position:absolute;top:29px;width:9px;height:5px;border-radius:50%;opacity:.3;animation:blushPulse 2.5s infinite}
.c-blush.bl{left:6px}.c-blush.br{right:6px}

.h-boy{position:absolute;top:-8px;left:50%;transform:translateX(-50%);z-index:4;width:54px;height:22px}
.h-spike{position:absolute;width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent}
.h-spike:nth-child(1){left:3px;top:2px}.h-spike:nth-child(2){left:15px;top:-5px}.h-spike:nth-child(3){left:27px;top:-2px}.h-spike:nth-child(4){right:3px;top:3px}

.h-girl{position:absolute;top:-7px;left:50%;transform:translateX(-50%);z-index:4;width:60px;height:26px;border-radius:30px 30px 0 0}
.h-side{position:absolute;bottom:-20px;width:8px;height:26px;border-radius:0 0 6px 6px}
.h-side.hl{left:4px}.h-side.hr{right:4px}
.h-bow{position:absolute;top:-4px;right:5px;z-index:5}
.h-bow::before,.h-bow::after{content:'';position:absolute;width:8px;height:7px;border-radius:50%;top:0}
.h-bow::before{left:-4px}.h-bow::after{right:-4px}
.h-bow-dot{position:absolute;top:2px;left:50%;transform:translateX(-50%);width:4px;height:4px;border-radius:50%;z-index:1}

.c-torso{position:absolute;top:48px;left:50%;transform:translateX(-50%);width:30px;height:24px;border-radius:8px 8px 4px 4px;z-index:2;animation:breathe 3s ease-in-out infinite}
.c-arm{position:absolute;top:52px;width:9px;height:20px;border-radius:5px;z-index:2;transform-origin:top center}
.c-arm.al{left:17px}.c-arm.ar{right:17px}
.working .c-arm.al{animation:typingL .35s ease-in-out infinite}
.working .c-arm.ar{animation:typingR .35s ease-in-out infinite .15s}
.c-leg{position:absolute;top:70px;width:9px;height:18px;border-radius:5px;z-index:1}
.c-leg.ll{left:28px}.c-leg.lr{right:28px}
.c-foot{position:absolute;top:86px;width:11px;height:5px;border-radius:3px}
.c-foot.fl{left:26px}.c-foot.fr{right:26px}

.c-desk{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:76px;height:8px;border-radius:3px;z-index:0;box-shadow:0 4px 15px rgba(0,0,0,.3)}
.c-laptop{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);z-index:1}
.lp-screen{width:36px;height:26px;border-radius:3px 3px 0 0;margin:0 auto;position:relative;overflow:hidden;border:1px solid}
.lp-base{width:40px;height:4px;border-radius:1px;margin:0 auto}
.sc-lines{position:absolute;inset:3px;display:flex;flex-direction:column;gap:3px;overflow:hidden}
.sc-line{height:2px;border-radius:1px;opacity:.5}
.working .sc-line{animation:screenGlow 2s ease-in-out infinite}
.working .sc-line:nth-child(2){animation-delay:.4s}
.working .sc-line:nth-child(3){animation-delay:.8s}

.c-sparkle{position:absolute;animation:sparkle 1.2s ease-out infinite;pointer-events:none}
.c-sparkle::before,.c-sparkle::after{content:'';position:absolute;background:currentColor}
.c-sparkle::before{width:8px;height:2px;top:3px;left:0;border-radius:1px}
.c-sparkle::after{width:2px;height:8px;top:0;left:3px;border-radius:1px}
.c-shadow{position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);width:50px;height:8px;border-radius:50%;opacity:.12}

.canvas-msg{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);text-align:center;color:rgba(255,255,255,.15);font-size:11px;font-weight:500;pointer-events:none;transition:opacity .5s}

.status-bar{padding:8px 20px;border-top:1px solid rgba(255,255,255,.04);display:flex;align-items:center;gap:14px;background:rgba(8,8,24,.7);flex-shrink:0}
.status-bar .pi{font-size:10px;font-weight:700;letter-spacing:.5px}
.status-bar .sts{font-size:9px;color:rgba(255,255,255,.25);margin-left:auto;display:flex;gap:12px}
.status-bar .sts span{font-weight:700}

.output-panel{max-height:45vh;overflow-y:auto;border-top:1px solid rgba(255,255,255,.04);padding:14px 20px;flex-shrink:0;background:rgba(8,8,24,.5)}
.complete-banner{text-align:center;padding:14px;margin-bottom:12px;background:linear-gradient(135deg,rgba(16,185,129,.05),rgba(217,119,6,.05));border-radius:14px;border:1px solid rgba(16,185,129,.12);animation:fadeIn .5s ease}
.complete-banner .cb-title{font-weight:800;color:#10B981;font-size:14px}
.complete-banner .cb-sub{font-size:10px;color:rgba(255,255,255,.3);margin-top:4px}
.cb-metrics{display:flex;gap:14px;justify-content:center;margin-top:8px;flex-wrap:wrap}
.cb-metric{font-size:9px;color:rgba(255,255,255,.35)}.cb-metric span{color:#10B981;font-weight:700}

.final-output{text-align:left;background:rgba(16,185,129,.02);border:1px solid rgba(16,185,129,.1);border-radius:14px;overflow:hidden;animation:fadeIn .5s ease}
.fo-header{padding:12px 16px;background:rgba(16,185,129,.05);border-bottom:1px solid rgba(16,185,129,.08);display:flex;align-items:center;gap:10px}
.fo-header .fo-label{font-size:11px;font-weight:700;color:#10B981;text-transform:uppercase;letter-spacing:1.5px}
.fo-body{padding:16px 18px;font-size:12px;color:#c8d6e5;line-height:1.7;max-height:400px;overflow-y:auto}
</style>
</head>
<body>
<div class="app" id="app"></div>
<script>
var state={sessionId:null,ws:null,connected:false,running:false,agents:{},activeAgents:new Set(),busyAgents:new Set(),agentActions:{},agentStreams:{},messageCounts:{},log:[],phase:null,decomposition:null,trustProfile:{},trailStats:null,metrics:null,finalOutput:null,completedSteps:0,totalSteps:0,taskCount:0};
var PC={decomposing:'#8B5CF6',discovery:'#3B82F6',architecture:'#D97706',execution:'#10B981',verification:'#EF4444',verifying:'#EF4444',synthesis:'#8B5CF6'};
var BOY='#7C6EF6',GIRL='#F472B6';

async function init(){
  var r=await fetch('/api/sessions',{method:'POST'});var d=await r.json();state.sessionId=d.sessionId;
  var proto=location.protocol==='https:'?'wss':'ws';
  var ws=new WebSocket(proto+'://'+location.host+'/ws/'+d.sessionId);state.ws=ws;
  ws.onopen=function(){state.connected=true;scheduleRender()};
  ws.onclose=function(){state.connected=false;scheduleRender()};
  ws.onmessage=function(e){handle(JSON.parse(e.data))};
}

function handle(m){
  switch(m.type){
    case 'connected':m.data.agents.forEach(function(a){state.agents[a.id]=a});state.trustProfile=m.data.trustProfile||{};scheduleRender();break;
    case 'swarm_start':state.running=true;state.log=[];state.decomposition=null;state.trailStats=null;state.metrics=null;state.finalOutput=null;state.activeAgents.clear();state.busyAgents.clear();state.agentActions={};state.agentStreams={};state.messageCounts={};state.completedSteps=0;scheduleRender();break;
    case 'phase_change':state.phase=m.data;scheduleRender();break;
    case 'decomposition_complete':state.decomposition=m.data;state.totalSteps=m.data.activeDomains.length+2;scheduleRender();break;
    case 'trust_routing':break;
    case 'trust_update':if(state.trustProfile[m.data.agentId])state.trustProfile[m.data.agentId][m.data.domain]=m.data.newTrust;scheduleRender();break;
    case 'agent_start':state.activeAgents.add(m.data.agentId);state.busyAgents.add(m.data.agentId);state.agentActions[m.data.agentId]=(m.data.task||'').slice(0,80)+'...';state.agentStreams[m.data.agentId]='';state.messageCounts[m.data.agentId]=(state.messageCounts[m.data.agentId]||0)+1;scheduleRender();break;
    case 'agent_token':state.agentStreams[m.data.agentId]=(state.agentStreams[m.data.agentId]||'')+m.data.token;state.agentActions[m.data.agentId]=state.agentStreams[m.data.agentId].slice(-120);updateToken(m.data.agentId);break;
    case 'agent_complete':state.busyAgents.delete(m.data.agentId);state.agentActions[m.data.agentId]=null;state.agentStreams[m.data.agentId]='';state.completedSteps++;state.log.push({agentId:m.data.agentId,name:m.data.name,output:m.data.output,artifactType:m.data.artifactType,domain:m.data.domain,confidence:m.data.confidence,pheromone:m.data.pheromone,agent:state.agents[m.data.agentId]});scheduleRender();break;
    case 'swarm_complete':state.running=false;state.phase=null;state.metrics=m.data.metrics;state.finalOutput=m.data.finalOutput||null;state.taskCount++;scheduleRender();break;
  }
}

function submit(t){if(!t||!t.trim()||state.running||!state.ws)return;state.ws.send(JSON.stringify({type:'run_task',task:t}))}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function md(s){
  return esc(s)
    .replace(/^### (.+)$/gm,'<div style="font-size:12px;font-weight:700;color:#c4b5fd;margin:8px 0 4px">$1</div>')
    .replace(/^## (.+)$/gm,'<div style="font-size:13px;font-weight:700;color:#e0e0e0;margin:10px 0 5px;border-bottom:1px solid rgba(255,255,255,.06);padding-bottom:4px">$1</div>')
    .replace(/^# (.+)$/gm,'<div style="font-size:14px;font-weight:800;color:#fff;margin:12px 0 6px">$1</div>')
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong style="color:#f0f0f0">$1</strong>')
    .replace(/^- (.+)$/gm,'<div style="padding-left:12px;margin:2px 0"><span style="color:#8B5CF6;margin-right:5px">&#8226;</span>$1</div>')
    .replace(/\\n/g,'<br>');
}

var renderPending=false;
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(function(){renderPending=false;render()})}

function updateToken(agentId){
  var el=document.getElementById('ac-'+agentId);
  if(!el)return;
  var a=state.agents[agentId];if(!a)return;
  var action=state.agentActions[agentId];
  var busy=state.busyAgents.has(agentId);
  var actEl=el.querySelector('.action');
  if(action){
    var html=esc(action.slice(-100))+(busy?'<span class="si"><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span></span>':'');
    if(actEl){actEl.innerHTML=html}
    else{actEl=document.createElement('div');actEl.className='action';actEl.style.cssText='color:'+a.color+';border-color:'+a.color;actEl.innerHTML=html;el.appendChild(actEl)}
  }else if(actEl){actEl.remove()}
  var boyBub=document.getElementById('bub-boy');
  var girlBub=document.getElementById('bub-girl');
  if(boyBub&&action){
    var busyList=Array.from(state.busyAgents);
    var idx=busyList.indexOf(agentId);
    if(idx%2===0&&boyBub){boyBub.className='char-bubble on';boyBub.style.borderColor=a.color+'40';boyBub.style.color=a.color;boyBub.textContent=a.emoji+' '+action.slice(-30)}
    if(idx%2===1&&girlBub){girlBub.className='char-bubble on';girlBub.style.borderColor=a.color+'40';girlBub.style.color=a.color;girlBub.textContent=a.emoji+' '+action.slice(-30)}
  }
}

function charState(){
  if(!state.running&&state.metrics)return 'done';
  if(state.running&&state.busyAgents.size>0)return 'working';
  if(state.running)return 'working';
  return 'idle';
}

function buildChar(gender,color){
  var cs=charState();
  var s='<div class="char '+cs+'">';
  s+='<div class="char-bubble" id="bub-'+gender+'"></div>';
  s+='<div class="cn" style="color:'+color+'">'+(gender==='boy'?'He builds':'She creates')+'</div>';
  s+='<div class="cw">';
  s+='<div class="c-head" style="background:#fdd8c4;border:2px solid '+color+'40">';
  s+='<div class="c-eyes"><div class="c-eye"></div><div class="c-eye"></div></div>';
  s+='<div class="c-mouth"></div>';
  s+='<div class="c-blush bl" style="background:'+color+'"></div>';
  s+='<div class="c-blush br" style="background:'+color+'"></div>';
  s+='</div>';
  if(gender==='boy'){
    s+='<div class="h-boy">';
    s+='<div class="h-spike" style="border-bottom:10px solid '+color+'"></div>';
    s+='<div class="h-spike" style="border-bottom:13px solid '+color+'"></div>';
    s+='<div class="h-spike" style="border-bottom:11px solid '+color+'"></div>';
    s+='<div class="h-spike" style="border-bottom:9px solid '+color+'"></div>';
    s+='</div>';
  }else{
    s+='<div class="h-girl" style="background:'+color+'80">';
    s+='<div class="h-side hl" style="background:'+color+'80"></div>';
    s+='<div class="h-side hr" style="background:'+color+'80"></div>';
    s+='<div class="h-bow" style="color:'+color+'">';
    s+='<div class="h-bow-dot" style="background:'+color+'"></div>';
    s+='</div></div>';
  }
  s+='<div class="c-torso" style="background:'+color+'25;border:2px solid '+color+'40"></div>';
  s+='<div class="c-arm al" style="background:'+color+'50"></div>';
  s+='<div class="c-arm ar" style="background:'+color+'50"></div>';
  s+='<div class="c-leg ll" style="background:'+color+'30"></div>';
  s+='<div class="c-leg lr" style="background:'+color+'30"></div>';
  s+='<div class="c-foot fl" style="background:'+color+'"></div>';
  s+='<div class="c-foot fr" style="background:'+color+'"></div>';
  s+='<div class="c-laptop">';
  s+='<div class="lp-screen" style="background:'+color+'20;border-color:'+color+'40">';
  s+='<div class="sc-lines">';
  s+='<div class="sc-line" style="background:'+color+';width:70%"></div>';
  s+='<div class="sc-line" style="background:'+color+';width:50%"></div>';
  s+='<div class="sc-line" style="background:'+color+';width:85%"></div>';
  s+='</div></div>';
  s+='<div class="lp-base" style="background:'+color+'50"></div>';
  s+='</div>';
  s+='<div class="c-desk" style="background:'+color+'12;border:1px solid '+color+'20"></div>';
  s+='<div class="c-shadow" style="background:'+color+'"></div>';
  s+='</div>';
  if(cs==='done'){
    s+='<div class="c-sparkle" style="color:'+color+';top:-8px;left:5px;animation-delay:0s"></div>';
    s+='<div class="c-sparkle" style="color:'+color+';top:-14px;right:5px;animation-delay:.3s"></div>';
    s+='<div class="c-sparkle" style="color:'+color+';top:0;right:-10px;animation-delay:.6s"></div>';
  }
  s+='</div>';
  return s;
}

function stars(){
  var s='';
  for(var i=0;i<50;i++){
    var x=Math.random()*100,y=Math.random()*100,d=Math.random()*4,sz=1+Math.random()*2;
    s+='<div class="canvas-star" style="left:'+x+'%;top:'+y+'%;width:'+sz+'px;height:'+sz+'px;animation-delay:'+d+'s"></div>';
  }
  return s;
}

function render(){
  var app=document.getElementById('app');
  var al=Object.values(state.agents);
  var cs=charState();
  var h='';
  h+='<div class="header">';
  h+='<div class="logo">&#x1f9ec;</div>';
  h+='<div><h1>SESI Protocol</h1><p class="sub">Stigmergic Epistemic Swarm Intelligence &middot; '+al.length+' agents &middot; '+state.taskCount+' task'+(state.taskCount===1?'':'s')+'</p></div>';
  if(state.phase){var pc=PC[state.phase.phase]||'#8B5CF6';h+='<div class="phase-badge"><div class="phase-dot" style="background:'+pc+'"></div><span class="phase-label" style="color:'+pc+'">'+state.phase.label+'</span></div>'}
  h+='<div class="conn-info">'+(state.connected?'<span style="color:#10B981">&#9679; Live</span>':'Connecting...')+' &middot; '+(state.sessionId||'...')+'</div>';
  h+='</div>';
  h+='<div class="main">';
  h+='<div class="sidebar"><div class="sidebar-title">Agent Fleet + Trust</div>';
  al.forEach(function(a){
    var active=state.activeAgents.has(a.id),busy=state.busyAgents.has(a.id);
    var action=state.agentActions[a.id],count=state.messageCounts[a.id]||0;
    var tp=state.trustProfile[a.id]||{};
    var entries=Object.entries(tp).sort(function(x,y){return(y[1].expected||0)-(x[1].expected||0)});
    var best=entries[0];var trustPct=best?Math.round((best[1].expected||0)*100):0;
    h+='<div class="agent-card'+(active?' active':'')+'" id="ac-'+a.id+'" style="border-color:'+(active?a.color:'rgba(255,255,255,.06)')+';'+(active?'box-shadow:0 0 20px '+a.color+'18;background:'+a.color+'08':'')+'">';
    if(busy)h+='<div class="sweep-bar" style="background:linear-gradient(90deg,transparent,'+a.color+',transparent)"></div>';
    h+='<div class="ac-head"><span class="emoji">'+a.emoji+'</span><div style="flex:1"><div class="name">'+a.name+'</div><div class="role" style="color:'+a.color+'">'+a.role+'</div></div>';
    if(count)h+='<span class="badge" style="background:'+a.color+'">'+count+'</span>';
    h+='</div>';
    if(best)h+='<div class="trust-bar"><div class="trust-fill" style="width:'+trustPct+'%;background:'+a.color+'"></div></div><div class="trust-label">Trust: '+trustPct+'% in '+best[0]+'</div>';
    if(action)h+='<div class="action" style="color:'+a.color+';border-color:'+a.color+'">'+esc(action.slice(-100))+(busy?'<span class="si"><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span><span style="background:'+a.color+'"></span></span>':'')+'</div>';
    h+='</div>';
  });
  h+='</div>';
  h+='<div class="content">';
  h+='<div class="input-area"><div class="input-row">';
  h+='<input id="ti" placeholder="Describe a task \\u2014 SESI agents will decompose, route by trust, and collaborate..." '+(state.running?'disabled':'')+' onkeydown="if(event.key===\\'Enter\\')submit(this.value)">';
  h+='<button class="btn-deploy" onclick="submit(document.getElementById(\\'ti\\').value)" '+(state.running?'disabled':'')+'>Deploy SESI</button>';
  h+='</div>';
  h+='<div class="presets">';
  var ps=["Build a SaaS MVP with auth and billing","Architect a scalable microservices system","Write a technical deep-dive on event sourcing","Create a real-time chat architecture","Design a CI/CD pipeline for Kubernetes"];
  ps.forEach(function(p){h+='<button onclick="document.getElementById(\\'ti\\').value=\\''+p+'\\'">'+p+'</button>'});
  h+='</div></div>';
  h+='<div class="canvas-area">';
  h+='<div class="canvas-stars">'+stars()+'</div>';
  h+='<div class="canvas-floor"></div>';
  h+='<div class="chars-wrap">'+buildChar('boy',BOY)+buildChar('girl',GIRL)+'</div>';
  if(cs==='idle')h+='<div class="canvas-msg">Enter a task above \\u2014 the agents will start building!</div>';
  h+='</div>';
  if(state.phase||state.metrics){
    h+='<div class="status-bar">';
    if(state.phase){var pc2=PC[state.phase.phase]||'#8B5CF6';h+='<div class="pi" style="color:'+pc2+'">'+state.phase.label+'</div>'}
    if(state.decomposition)h+='<span style="font-size:9px;color:rgba(255,255,255,.2)">'+state.decomposition.activeDomains.length+' domains &middot; '+state.decomposition.phases.length+' phases</span>';
    h+='<div class="sts">';
    if(state.metrics)h+='<span style="color:#F59E0B">'+state.metrics.agentCalls+' calls</span> &middot; <span style="color:#10B981">'+(state.metrics.pheromoneTrail&&state.metrics.pheromoneTrail.total||0)+' artifacts</span> &middot; <span style="color:#8B5CF6">'+(state.metrics.duration/1000).toFixed(1)+'s</span>';
    h+='</div></div>';
  }
  if(state.finalOutput||(!state.running&&state.metrics)){
    h+='<div class="output-panel">';
    if(!state.running&&state.metrics){
      h+='<div class="complete-banner"><div class="cb-title">&#10024; SESI Task Complete</div><div class="cb-sub">'+state.metrics.agentCalls+' agent calls &middot; '+(state.metrics.pheromoneTrail&&state.metrics.pheromoneTrail.total||0)+' artifacts &middot; trust updated</div>';
      h+='<div class="cb-metrics"><div class="cb-metric">Duration: <span>'+(state.metrics.duration/1000).toFixed(1)+'s</span></div><div class="cb-metric">Domains: <span>'+(state.metrics.decomposition&&state.metrics.decomposition.activeDomains||0)+'</span></div><div class="cb-metric">Phases: <span>'+(state.metrics.decomposition&&state.metrics.decomposition.phases||0)+'</span></div><div class="cb-metric">Tokens: <span>~'+state.metrics.tokensEstimate+'</span></div></div></div>'
    }
    if(state.finalOutput){
      h+='<div class="final-output"><div class="fo-header"><span style="font-size:16px">&#128203;</span><span class="fo-label">Final Deliverable</span></div><div class="fo-body">'+md(state.finalOutput)+'</div></div>'
    }
    h+='</div>';
  }
  h+='</div></div>';
  app.innerHTML=h;
}
render();init();
</script>
</body>
</html>
`);
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
