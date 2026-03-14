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
    this.lastDecayTime = Date.now();
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
    const now = Date.now();
    const elapsedMs = now - this.lastDecayTime;
    // Scale decay by wall-clock time: 60s = 1 "phase equivalent"
    const phaseEquivalents = Math.max(1, elapsedMs / (60 * 1000));
    const effectiveRate = Math.min(0.5, DECAY_RATE * phaseEquivalents);
    this.lastDecayTime = now;
    this.artifacts.forEach(a => {
      a.pheromone = Math.max(MIN_PHEROMONE, a.pheromone * (1 - effectiveRate));
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
      a.pheromone >= minPh || (now - a.timestamp) <= maxAge
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
    this.lastDecayTime = Date.now();
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
    keywords: ["need", "want", "should", "must", "feature", "user", "story", "requirement", "goal", "objective", "specification", "scope", "criteria", "build", "create", "develop", "make"],
    phase: "discovery",
    order: 1,
  },
  architecture: {
    label: "Architecture",
    keywords: ["architecture", "design", "system", "pattern", "structure", "service", "microservice", "monolith", "serverless", "distributed", "scale", "event", "domain", "cqrs", "saga", "gateway", "mesh", "cloud", "container", "docker", "kubernetes", "saas", "platform", "mvp", "full stack", "fullstack", "migrate", "modernize", "legacy", "build", "create", "develop", "implement", "app", "application", "project", "startup", "tool", "solution", "software"],
    phase: "architecture",
    order: 2,
  },
  frontend: {
    label: "Frontend",
    keywords: ["ui", "frontend", "component", "page", "react", "vue", "html", "css", "responsive", "animation", "dashboard", "widget", "layout", "button", "form", "modal", "chart", "landing", "website", "web", "interface", "display", "visual", "interactive", "next.js", "nextjs", "tailwind", "svelte", "angular"],
    phase: "execution",
    order: 3,
  },
  backend: {
    label: "Backend",
    keywords: ["api", "backend", "server", "database", "endpoint", "rest", "graphql", "auth", "middleware", "route", "schema", "migration", "query", "sql", "cache", "queue", "webhook", "lambda", "function", "pipeline", "socket", "grpc", "build", "create", "develop", "app", "application", "crud", "login", "signup", "payment", "user", "management", "mongo", "postgres", "mysql", "redis", "express", "fastapi", "django", "flask", "node"],
    phase: "execution",
    order: 3,
  },
  aiml: {
    label: "AI/ML",
    keywords: ["ai", "ml", "machine learning", "deep learning", "neural", "model", "training", "inference", "nlp", "computer vision", "transformer", "embedding", "vector", "rag", "fine-tune", "dataset", "classification", "regression", "clustering", "llm", "gpt", "bert", "pytorch", "tensorflow", "scikit", "pandas", "numpy", "langchain", "openai", "anthropic", "huggingface", "diffusion", "gan", "cnn", "rnn", "lstm", "attention", "tokenizer", "prompt", "chatbot", "recommendation", "sentiment", "prediction", "autonomous"],
    phase: "execution",
    order: 3,
  },
  infrastructure: {
    label: "Infrastructure",
    keywords: ["deploy", "devops", "docker", "ci/cd", "terraform", "aws", "gcp", "azure", "monitoring", "logging", "infrastructure", "config", "environment", "kubernetes", "container", "build", "create", "app", "application"],
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
    keywords: ["review", "test", "quality", "security", "audit", "verify", "validate", "bug", "lint", "fix", "optimize", "performance", "benchmark", "build", "create", "develop", "api", "app", "code"],
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

Your PRIMARY job is to SYNTHESIZE all agent artifacts into a COMPLETE, RUNNABLE project that the user can download and use immediately.

When synthesizing:
1. Combine all IMPLEMENTATION artifacts into a structured file-by-file project
2. Mark each file with: // FILE: path/filename.ext
3. Every file must be COMPLETE — no placeholders, no "// TODO", no "..." truncation
4. Include package.json / requirements.txt with exact dependency versions
5. Include a README.md with setup instructions (npm install, how to run, API endpoints)
6. Ensure all imports reference correct relative paths between files
7. Ensure consistency across all files (shared types, matching API routes, etc.)

OUTPUT FORMAT — you MUST follow this exactly:
// FILE: package.json
{ complete JSON }

// FILE: src/index.js
complete code...

// FILE: README.md
complete markdown...

NEVER output prose summaries. NEVER describe what code does. Output the ACTUAL CODE FILES only.
The user must be able to take your output, save each file, and run the project with zero modifications.

CONFIDENCE: [0.0-1.0]`,
  },

  researcher: {
    id: "researcher", name: "Scout", emoji: "🔍", role: "Research Agent", color: "#3B82F6",
    capabilities: ["requirements", "architecture", "content", "quality"],
    systemPrompt: `You are Scout, the research agent in the SESI swarm.

Your job: Research and specify CONCRETE technical requirements that other agents will implement as real code.

Output as a structured specification:
1. TECH STACK: Exact libraries/frameworks with versions (e.g., express@4.18.2, not just "Express")
2. API SPEC: List every endpoint with method, path, request/response types
3. DATA MODEL: Exact field names, types, relationships for every entity
4. DEPENDENCIES: Full list of npm/pip packages needed
5. FILE STRUCTURE: Proposed directory tree with every file listed

Be SPECIFIC. Other agents will write code based on your spec. Vague specs = broken code.

CONFIDENCE: [0.0-1.0]`,
  },

  planner: {
    id: "planner", name: "Architect", emoji: "📐", role: "Planning Agent", color: "#F59E0B",
    capabilities: ["requirements", "architecture", "frontend", "backend", "aiml"],
    systemPrompt: `You are Architect, the planning agent in the SESI swarm.

Your job: Create a CONCRETE implementation plan that coding agents will follow to produce real, runnable code.

Output format:
1. FILE TREE: Every file that needs to be created, with its purpose
2. INTERFACES: Exact function signatures, API contracts, type definitions
3. DATA FLOW: How data moves between components (with actual variable/field names)
4. DEPENDENCIES: package.json / requirements.txt contents with exact versions
5. EXECUTION ORDER: Which files to implement first (dependency order)

Read existing EVIDENCE artifacts from the trail. Your plan must be specific enough that a coder can implement each file without guessing.

CONFIDENCE: [0.0-1.0]`,
  },

  senior_architect: {
    id: "senior_architect", name: "Sage", emoji: "🏛️", role: "Senior Architect", color: "#D97706",
    capabilities: ["architecture", "infrastructure", "backend", "aiml"],
    systemPrompt: `You are Sage, the senior architect in the SESI swarm.

Your job: Make architecture DECISIONS that result in working code. Not theory — practical choices.

For every decision, output:
1. CHOSEN APPROACH with specific library/framework versions
2. FILE STRUCTURE showing exact filenames and directory layout
3. KEY INTERFACES — actual TypeScript/JSDoc type definitions or Python type hints
4. DATABASE SCHEMA — actual CREATE TABLE / schema definition code
5. CONFIG FILES — actual .env.example, docker-compose.yml, etc.

Write these as actual code snippets that coding agents will use directly. Use // FILE: markers.

You may CHALLENGE other agents' artifacts if you spot issues that would cause runtime errors.

CONFIDENCE: [0.0-1.0]`,
  },

  coder_frontend: {
    id: "coder_frontend", name: "Bolt", emoji: "⚡", role: "Frontend Coder", color: "#10B981",
    capabilities: ["frontend"],
    systemPrompt: `You are Bolt, the frontend coding agent in the SESI swarm.

Your job: Write COMPLETE, PRODUCTION-READY frontend code files. Every file must be fully functional.

RULES:
1. Mark each file with: // FILE: path/filename.ext
2. Every file must be COMPLETE — no "..." or "// add more here" or placeholders
3. Include ALL imports, ALL components, ALL styling
4. Handle loading states, error states, and edge cases
5. Include proper form validation
6. Use responsive design
7. Follow DECISION artifacts from the trail for architecture choices

Output ONLY code files. No explanations, no prose. Just:
// FILE: src/App.jsx
import React from 'react';
// ... complete component code

// FILE: src/components/Header.jsx
// ... complete component code

The user will save these files and run the project. If ANY file is incomplete, the project breaks.

CONFIDENCE: [0.0-1.0]`,
  },

  coder_backend: {
    id: "coder_backend", name: "Forge", emoji: "🔧", role: "Backend Coder", color: "#06B6D4",
    capabilities: ["backend", "infrastructure"],
    systemPrompt: `You are Forge, the backend coding agent in the SESI swarm.

Your job: Write COMPLETE, PRODUCTION-READY backend code. Every file must be fully functional with zero errors.

RULES:
1. Mark each file with: // FILE: path/filename.ext
2. Every file must be COMPLETE — no truncation, no placeholders, no "..."
3. Include ALL route handlers with full request validation and error handling
4. Include database models/schemas with migrations
5. Include authentication middleware if auth is needed
6. Include proper error responses (not just 500)
7. Include input sanitization and security headers
8. Follow DECISION artifacts from the trail for architecture choices

Output ONLY code files:
// FILE: src/server.js
const express = require('express');
// ... complete server code with all routes

// FILE: src/models/User.js
// ... complete model code

The user will install dependencies, run the server, and it MUST work on first try.

CONFIDENCE: [0.0-1.0]`,
  },

  coder_systems: {
    id: "coder_systems", name: "Core", emoji: "🔩", role: "Systems Coder", color: "#A855F7",
    capabilities: ["infrastructure", "backend", "quality"],
    systemPrompt: `You are Core, the systems/infrastructure coding agent in the SESI swarm.

Your job: Write COMPLETE infrastructure, DevOps, and utility code files.

RULES:
1. Mark each file with: // FILE: path/filename.ext
2. Write complete Dockerfiles, docker-compose.yml, CI/CD configs
3. Write complete utility modules (validation, auth helpers, middleware)
4. Write complete test files with actual test cases
5. Write .env.example with all required environment variables documented
6. No placeholders. Every config must be valid and runnable.

Output ONLY code files with // FILE: markers.

CONFIDENCE: [0.0-1.0]`,
  },

  coder_aiml: {
    id: "coder_aiml", name: "Neuron", emoji: "🧪", role: "AI/ML Engineer", color: "#FF6B6B",
    capabilities: ["aiml", "backend"],
    systemPrompt: `You are Neuron, the senior AI/ML engineering agent in the SESI swarm.

Your job: Write COMPLETE, PRODUCTION-READY AI/ML code. Every file must work out of the box.

RULES:
1. Mark each file with: // FILE: path/filename.ext (or # FILE: for Python)
2. Write complete model training scripts, inference APIs, data pipelines
3. Include proper data preprocessing with error handling
4. Include model evaluation metrics and logging
5. Include requirements.txt with pinned versions (torch==2.1.0, not just torch)
6. If using APIs (OpenAI, Anthropic, HuggingFace), include complete client setup
7. Include proper error handling for API rate limits, timeouts, model failures
8. Write complete integration code to connect ML components with the backend

For LLM/RAG applications:
- Include complete prompt engineering with system prompts
- Include embedding generation and vector store setup
- Include retrieval and generation pipelines

For traditional ML:
- Include complete training loops with checkpointing
- Include inference endpoints with input validation
- Include model serialization (pickle/ONNX/safetensors)

Output ONLY code files. No explanations.

CONFIDENCE: [0.0-1.0]`,
  },

  writer: {
    id: "writer", name: "Quill", emoji: "✍️", role: "Writing Agent", color: "#EC4899",
    capabilities: ["content", "requirements"],
    systemPrompt: `You are Quill, the writing agent in the SESI swarm.

Your job: Write COMPLETE documentation files that are part of the project deliverable.

RULES:
1. Mark each file with: // FILE: path/filename.ext
2. README.md must include: project description, prerequisites, installation steps, usage examples, API documentation, environment variables
3. API docs must list every endpoint with request/response examples
4. Include CONTRIBUTING.md if applicable
5. Write actual .env.example files with documented variables
6. For content tasks (blog posts, copy): output the complete final content, not a draft or outline

Output ONLY files with // FILE: markers. No meta-commentary.

CONFIDENCE: [0.0-1.0]`,
  },

  reviewer: {
    id: "reviewer", name: "Sentinel", emoji: "🛡️", role: "Review Agent", color: "#EF4444",
    capabilities: ["quality"],
    systemPrompt: `You are Sentinel, the code review agent and EPISTEMIC TRUST GATE in the SESI swarm.

Your job is CRITICAL — you review code artifacts for correctness and completeness. Your verdicts update the Bayesian trust model.

Review checklist:
1. SYNTAX: Will the code parse without errors?
2. IMPORTS: Are all imports valid and do referenced modules exist?
3. LOGIC: Are there runtime errors, null pointer issues, or infinite loops?
4. COMPLETENESS: Are there any "..." placeholders, TODOs, or truncated code?
5. SECURITY: SQL injection, XSS, hardcoded secrets, missing auth?
6. CONSISTENCY: Do API routes match what the frontend calls? Do types match?
7. DEPS: Are all npm/pip packages in package.json/requirements.txt?
8. CONFIG: Is .env.example complete? Are all env vars documented?

If you find ANY issue that would prevent the code from running:
- REJECT the artifact
- List every specific error with line references
- Provide the FIXED code for each issue

Output format:
VERDICT: [APPROVE/REJECT]
QUALITY_SCORE: [0-100]
ISSUES: [specific code errors with fixes]
FIXED_CODE: [corrected code if rejecting]

CONFIDENCE: [0.0-1.0]`,
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
        throw new Error("Server at capacity — too many concurrent sessions");
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
      const contentSlice = a.content.slice(0, 2000); // Show more code context to agents
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
            max_tokens: 8192,
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

    // Extract confidence from response and clamp to valid range
    const confMatch = fullResponse.match(/CONFIDENCE:\s*([\d.]+)/i);
    const rawConf = confMatch ? parseFloat(confMatch[1]) : NaN;
    const confidence = (isFinite(rawConf) && rawConf >= 0 && rawConf <= 1) ? rawConf : 0.7;

    // Deposit artifact to pheromone trail
    const artifact = session.trail.deposit({
      content: fullResponse.slice(0, 8000),
      authorAgent: agentId,
      artifactType: artifactType || ARTIFACT_TYPES.IMPLEMENTATION,
      domain,
      confidence,
    });

    // Reinforce referenced artifacts — skip if this agent is writing a critique
    // to prevent boosting artifacts that are being contradicted
    if (artifactType !== ARTIFACT_TYPES.CRITIQUE) {
      for (const strong of trailArtifacts.slice(0, 3)) {
        session.trail.reinforce(strong.id);
      }
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

    const approved = result?.output?.includes("APPROVE") ?? false;

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
    if (session.status === "running") {
      const err = new Error("Session already running");
      err.status = 409;
      throw err;
    }

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
      `[${a.artifactType.toUpperCase()} | pheromone: ${a.pheromone.toFixed(2)} | by ${a.authorAgent}]\n${a.content.slice(0, 3000)}`
    ).join("\n\n---\n\n");

    const synthesis = await this.callAgent(
      sessionId, "orchestrator",
      `SYNTHESIZE all agent artifacts into a COMPLETE, RUNNABLE project for: "${taskText}"

INSTRUCTIONS:
1. Combine all IMPLEMENTATION artifacts into one structured output
2. Use // FILE: path/filename.ext markers to separate each file
3. Every file must be COMPLETE - no placeholders, no TODO, no truncation
4. Include package.json/requirements.txt with pinned dependency versions
5. Include README.md with exact setup and run instructions
6. Fix any inconsistencies between files (imports, routes, types)
7. The user must be able to save these files and run the project immediately

Output ONLY the code files. NO prose, NO summaries, NO explanations.`,
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
  try {
    const sessionId = sesi.createSession();
    log.info("Session created", { sessionId });
    res.json({ sessionId, wsUrl: `/ws/${sessionId}`, algorithm: "SESI" });
  } catch (err) {
    if (err.message.startsWith("Server at capacity")) {
      return res.status(503).json({ error: "Server at capacity — try again later" });
    }
    throw err;
  }
});

app.post("/api/sessions/:id/run", requireApiKey(), async (req, res) => {
  const { id } = req.params;

  const idCheck = validateSessionId(id);
  if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

  const taskCheck = validateTaskInput(req.body?.task);
  if (!taskCheck.valid) return res.status(400).json({ error: taskCheck.error });

  const session = sesi.sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status === "running") return res.status(409).json({ error: "Session is already running" });

  try {
    const result = await sesi.executeTask(id, taskCheck.sanitized);
    res.json({ success: true, ...result });
  } catch (err) {
    log.error("Task execution failed", { sessionId: id, error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
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
  // Extract session ID safely via regex — avoids Host header injection via URL parsing
  const wsMatch = req.url.match(/^\/ws\/([a-f0-9]{8})$/);
  const sessionId = wsMatch?.[1];

  if (!sessionId || !sesi.sessions.has(sessionId)) {
    ws.close(1008, "Invalid or unknown session");
    return;
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
    } catch (_) { /* ignore malformed WebSocket messages */ }
  });

  ws.on("close", () => sesi.removeSpectator(sessionId, ws));
});

// ═══════════════════════════════════════════════════════════════════════════
//  FILE UPLOAD — attach files to session context
// ═══════════════════════════════════════════════════════════════════════════

const MAX_FILES_PER_SESSION = 5;

app.post("/api/upload/:sessionId", express.text({ type: "*/*", limit: "51kb" }), (req, res) => {
  const { sessionId } = req.params;
  const idCheck = validateSessionId(sessionId);
  if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });
  const session = sesi.sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.uploadedFiles) session.uploadedFiles = [];
  if (session.uploadedFiles.length >= MAX_FILES_PER_SESSION) {
    return res.status(429).json({ error: `Too many files — maximum ${MAX_FILES_PER_SESSION} per session` });
  }
  // Sanitize filename: allow only safe characters, cap length
  const rawFilename = req.headers["x-filename"] || "";
  const filename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "uploaded-file.txt";
  session.uploadedFiles.push({ name: filename, content: req.body.slice(0, 50000) });
  res.json({ ok: true, filename, files: session.uploadedFiles.length });
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
<title>Hivemind — Agentic AI Protocol</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f9fafb;color:#111827;font-family:'Inter',system-ui,sans-serif;height:100vh;overflow:hidden;display:flex;flex-direction:column}
::selection{background:rgba(99,102,241,.2)}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#e5e7eb;border-radius:3px}

/* Animations */
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulseGlow{0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.4)}50%{box-shadow:0 0 0 4px rgba(99,102,241,0)}}
@keyframes slideRight{from{stroke-dashoffset:24}to{stroke-dashoffset:0}}

/* Layout */
.app{display:flex;height:100vh;flex-direction:column}
.header{padding:12px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;background:#fff;z-index:10;height:60px}
.logo{font-family:'DM Serif Display',serif;font-size:22px;color:#111827;display:flex;align-items:center;gap:8px}
.logo-icon{width:24px;height:24px;background:#6366f1;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px}
.conn-info{font-size:12px;color:#6b7280;margin-left:auto;display:flex;align-items:center;gap:6px}
.status-dot{width:8px;height:8px;border-radius:50%;background:#10b981}

.main-view{display:flex;flex:1;overflow:hidden}

/* Sidebar */
.sidebar{width:280px;flex-shrink:0;border-right:1px solid #e5e7eb;background:#f3f4f6;padding:16px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.sb-title{font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;padding:0 4px 8px}

.right-panel{width:420px;flex-shrink:0;border-left:1px solid #e5e7eb;background:#fff;display:flex;flex-direction:column;overflow:hidden}
.rp-header{padding:16px;border-bottom:1px solid #e5e7eb;background:#f9fafb;font-weight:600;font-size:14px;color:#111827;display:flex;align-items:center;gap:8px;}
.rp-body{flex:1;overflow-y:auto;padding:16px;background:#fafafa;}

.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
.metric-box{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px}
.metric-box-title{font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600}
.metric-box-val{font-size:16px;font-weight:700;color:#111827;margin-top:4px}
.agent-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;transition:all .2s;min-height:76px}
.agent-card.active{border-color:#6366f1;box-shadow:0 4px 12px rgba(99,102,241,.08)}
.ac-head{display:flex;align-items:center;gap:10px}
.ac-icon{font-size:20px}
.ac-info{flex:1}
.ac-name{font-size:13px;font-weight:600;color:#111827}
.ac-role{font-size:10px;font-weight:500;color:#6b7280;text-transform:uppercase}
.ac-trust{height:4px;background:#f3f4f6;border-radius:2px;overflow:hidden;margin-top:4px}
.ac-trust-fill{height:100%;border-radius:2px;transition:width .5s}
.ac-action{font-family:'JetBrains Mono',monospace;font-size:10px;color:#4b5563;background:#f9fafb;padding:6px 8px;border-radius:6px;border-left:2px solid;max-height:60px;overflow:hidden;word-break:break-word}

/* Workspace Canvas */
.workspace{flex:1;display:flex;flex-direction:column;background:#fff;position:relative}

/* Landing / Initial State */
.landing{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fafafa;z-index:5}
.landing-title{font-family:'DM Serif Display',serif;font-size:42px;color:#111827;margin-bottom:32px;text-align:center}

/* Input Area */
.input-container{width:100%;max-width:760px;padding:0 24px}
.prompt-box{background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.04);padding:16px;display:flex;flex-direction:column;gap:12px;transition:border-color .2s,box-shadow .2s}
.prompt-box:focus-within{border-color:#d1d5db;box-shadow:0 12px 40px rgba(0,0,0,.08)}
.prompt-input{width:100%;border:none;outline:none;font-family:'Inter',sans-serif;font-size:16px;color:#111827;resize:none;height:60px;background:transparent}
.prompt-input::placeholder{color:#9ca3af}
.prompt-actions{display:flex;align-items:center;justify-content:space-between}

.btn-icon{width:36px;height:36px;border-radius:10px;border:1px solid #e5e7eb;background:#f9fafb;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#4b5563;font-size:16px;transition:all .2s;position:relative}
.btn-icon:hover{background:#f3f4f6;color:#111827}
.btn-icon.has-file{background:#eef2ff;border-color:#c7d2fe;color:#4f46e5}
.btn-submit{background:#111827;color:#fff;border:none;border-radius:10px;padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .2s}
.btn-submit:hover:not(:disabled){background:#374151;transform:translateY(-1px)}
.btn-submit:disabled{opacity:.5;cursor:not-allowed}

.presets-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;max-width:760px;margin:32px auto 0;padding:0 24px}
.preset-card{padding:16px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;cursor:pointer;transition:all .2s}
.preset-card:hover{border-color:#d1d5db;box-shadow:0 4px 12px rgba(0,0,0,.03);transform:translateY(-2px)}
.preset-title{font-size:13px;font-weight:600;color:#111827;margin-bottom:4px}
.preset-desc{font-size:12px;color:#6b7280}

/* Active Workflow View */
.workflow-view{position:relative;flex:1;background:#fafafa;padding:24px;overflow-x:auto;overflow-y:hidden;display:none;align-items:flex-start;gap:32px}
.workflow-view.active{display:flex}

.wf-page{width:340px;height:calc(100vh - 160px);background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.02);display:flex;flex-direction:column;flex-shrink:0;animation:fadeIn .4s ease}
.wf-head{padding:12px 16px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:10px;background:#f9fafb;border-radius:12px 12px 0 0}
.wf-agent{font-size:13px;font-weight:600;color:#111827;flex:1}
.wf-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:12px;background:#eef2ff;color:#4f46e5}
.wf-body{flex:1;padding:16px;overflow-y:auto;font-size:12px;color:#374151;line-height:1.6}

/* Connection Lines */
.wf-connector{display:flex;align-items:center;justify-content:center;height:calc(100vh - 160px);width:32px;flex-shrink:0}
.wf-arrow{width:100%;height:2px;background:#e5e7eb;position:relative}
.wf-arrow::after{content:'';position:absolute;right:-2px;top:-4px;border-left:5px solid #e5e7eb;border-top:5px solid transparent;border-bottom:5px solid transparent}
.wf-arrow.active{background:#6366f1;animation:pulseGlow 2s infinite}
.wf-arrow.active::after{border-left-color:#6366f1}

/* Top active task bar */
.top-task-bar{padding:12px 24px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:16px;z-index:9}
.tt-input{flex:1;font-size:14px;color:#111827;border:none;outline:none;background:transparent}
.tt-btn{background:#f3f4f6;border:1px solid #e5e7eb;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;color:#4b5563;cursor:pointer}
.tt-btn:hover{background:#e5e7eb}

/* Output Panel Styles */
.md-h1{font-size:15px;font-weight:700;color:#111827;margin:16px 0 8px}
.md-h2{font-size:14px;font-weight:700;color:#374151;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin:12px 0 6px}
.md-h3{font-size:13px;font-weight:600;color:#4b5563;margin:8px 0 4px}
.md-strong{color:#111827;font-weight:600}
.md-li{padding-left:16px;position:relative;margin:4px 0}
.md-li::before{content:'\\2022';position:absolute;left:4px;color:#9ca3af}

.file-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.02)}
.file-card-head{padding:10px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px}
.fc-name{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;color:#4f46e5;flex:1}
.fc-btn{padding:4px 12px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;color:#4b5563;font-size:11px;font-weight:500;cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:4px}
.fc-btn:hover{background:#f3f4f6;color:#111827}
.file-card-code{padding:16px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;color:#374151;background:#fff;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;tab-size:2}
.dl-bar{padding:16px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:16px}
.btn-dl{background:#6366f1;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-weight:600;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px}
.btn-dl:hover{background:#4f46e5}
.dl-info{font-size:12px;color:#6b7280;margin-left:auto}
</style>
</head>
<body>
<div class="app" id="app"></div>
<script>
window.onerror = function(msg, url, lineNo, columnNo, error) {
  document.body.innerHTML += '<div style="color:red;padding:20px;font-family:monospace">Error: ' + msg + '<br>Line: ' + lineNo + '</div>';
  return false;
};
const WS_URL = window.location.protocol === 'https:' ? 'wss://' + window.location.host : 'ws://' + window.location.host;
let ws;
let state = {
  connected: false,
  sessionId: null,
  agents: {},
  activeAgents: new Set(),
  busyAgents: new Set(),
  agentActions: {},
  messageCounts: {},
  trustProfile: {},
  phase: null,
  taskCount: 0,
  running: false,
  finalOutput: null,
  metrics: null,
  decomposition: null,
  workflowPhases: [], // Array of { phase: 'phaseId', label: 'Label', agents: [], output: '' }
  uploadedFile: null,
  currentTaskText: '',
  lastError: null
};

// Phase colors mapping
const PC = {
  'decomposition': '#6366f1',
  'requirements' : '#8b5cf6',
  'architecture' : '#ec4899',
  'backend'      : '#f59e0b',
  'frontend'     : '#10b981',
  'aiml'         : '#06b6d4',
  'synthesis'    : '#3b82f6',
  'quality'      : '#14b8a6'
};

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseFiles(text) {
  if(!text) return [];
  const files = [];
  const lines = text.split("\\n");
  let currentFile = null;
  let currentCode = [];
  
  for(let i=0; i<lines.length; i++){
    const line = lines[i];
    if(line.startsWith("// FILE:")){
      if(currentFile) {
        files.push({ name: currentFile, code: currentCode.join("\\n").trim() });
      }
      currentFile = line.substring(8).trim();
      currentCode = [];
      // Skip the optional javascript/python block start
      if(i+1 < lines.length && lines[i+1].startsWith("\`\`\`")) i++;
    } else if (currentFile) {
      if(line.startsWith("\`\`\`")) {
        files.push({ name: currentFile, code: currentCode.join("\\n").trim() });
        currentFile = null;
        currentCode = [];
      } else {
        currentCode.push(line);
      }
    }
  }
  if(currentFile && currentCode.length > 0) {
    files.push({ name: currentFile, code: currentCode.join("\\n").trim() });
  }
  return files;
}

function renderMD(text) {
  if (!text) return "";
  return esc(text)
    .replace(/^### (.*$)/gm, '<div class="md-h3">$1</div>')
    .replace(/^## (.*$)/gm, '<div class="md-h2">$1</div>')
    .replace(/^# (.*$)/gm, '<div class="md-h1">$1</div>')
    .replace(/\\*\\*(.*?)\\*\\*/g, '<span class="md-strong">$1</span>')
    .replace(/^\\- (.*$)/gm, '<div class="md-li">$1</div>')
    .replace(/\\n/g, '<br>');
}

function renderCode(text) {
  const files = parseFiles(text);
  if (files.length === 0) return '<div class="fo-body">' + renderMD(text) + '</div>';
  
  let h = '<div class="dl-bar">';
  h += '<button class="btn-dl" onclick="downloadAll()">📦 Download All Files</button>';
  h += '<span class="dl-info">' + files.length + ' files generated</span>';
  h += '</div><div class="fo-body">';
  
  files.forEach((f, i) => {
    h += '<div class="file-card">';
    h += '<div class="file-card-head">';
    h += '<div class="fc-name">' + esc(f.name) + '</div>';
    h += '<button class="fc-btn" onclick="copyCode(' + i + ')">📋 Copy</button>';
    h += '</div>';
    h += '<div class="file-card-code" id="code-' + i + '">' + esc(f.code) + '</div>';
    h += '</div>';
  });
  h += '</div>';
  window.__LAST_FILES = files;
  return h;
}

window.copyCode = function(idx) {
  if(!window.__LAST_FILES || !window.__LAST_FILES[idx]) return;
  navigator.clipboard.writeText(window.__LAST_FILES[idx].code);
  alert("Copied " + window.__LAST_FILES[idx].name + " to clipboard");
}

window.downloadAll = function() {
  alert("In a full build, this would trigger a .zip download of all files.");
};

window.closeModal = function() {
  document.getElementById('resultModal').classList.remove('active');
};

async function init() {
  try {
    const r = await fetch('/api/sessions', { method: 'POST' });
    const d = await r.json();
    state.sessionId = d.sessionId;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = proto + '://' + location.host + '/ws/' + d.sessionId;
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => { state.connected = true; render(); };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (_err) {
        return;
      }
      switch (msg.type) {
        case 'connected':
          msg.data.agents.forEach(a => { state.agents[a.id] = a; });
          state.trustProfile = msg.data.trustProfile || {};
          render();
          break;
        case 'swarm_start':
          state.running = true;
          state.lastError = null;
          state.decomposition = null;
          state.metrics = null;
          state.finalOutput = null;
          state.activeAgents.clear();
          state.busyAgents.clear();
          state.agentActions = {};
          state.messageCounts = {};
          render();
          break;
        case 'phase_change':
          state.phase = msg.data;
          if (state.running && state.phase) {
            const lastPhase = state.workflowPhases[state.workflowPhases.length - 1];
            if (!lastPhase || lastPhase.phase !== state.phase.phase) {
              state.workflowPhases.push({
                phase: state.phase.phase,
                label: state.phase.label,
                agents: Array.from(state.activeAgents),
                actions: []
              });
            }
          }
          render();
          break;
        case 'decomposition_complete':
          state.decomposition = msg.data;
          render();
          break;
        case 'trust_update':
          if (state.trustProfile[msg.data.agentId]) {
            state.trustProfile[msg.data.agentId][msg.data.domain] = msg.data.newTrust;
          }
          render();
          break;
        case 'agent_start':
          state.activeAgents.add(msg.data.agentId);
          state.busyAgents.add(msg.data.agentId);
          state.agentActions[msg.data.agentId] = (msg.data.task || '').slice(0, 80) + '...';
          state.messageCounts[msg.data.agentId] = (state.messageCounts[msg.data.agentId] || 0) + 1;
          render();
          break;
        case 'agent_token':
          state.agentActions[msg.data.agentId] = (state.agentActions[msg.data.agentId] + msg.data.token).slice(-120);
          scheduleRender();
          break;
        case 'agent_error':
          state.busyAgents.delete(msg.data.agentId);
          state.lastError = (msg.data && msg.data.error) ? msg.data.error : 'Agent failed';
          render();
          break;
        case 'agent_complete':
          state.busyAgents.delete(msg.data.agentId);
          state.agentActions[msg.data.agentId] = null;
          
          if (state.workflowPhases.length > 0 && msg.data.output) {
            const currentPhase = state.workflowPhases[state.workflowPhases.length - 1];
            currentPhase.actions = currentPhase.actions || [];
            const agent = state.agents[msg.data.agentId];
            currentPhase.actions.push({
              agent: agent ? agent.name : msg.data.agentId,
              action: msg.data.output.slice(0, 200) + '...',
              time: new Date().toLocaleTimeString()
            });
            if (currentPhase.actions.length > 50) currentPhase.actions.shift();
          }
          render();
          break;
        case 'swarm_complete':
          state.running = false;
          state.phase = null;
          state.metrics = msg.data.metrics;
          state.finalOutput = msg.data.finalOutput || null;
          state.taskCount++;
          render();
          break;
      }
    };
    ws.onclose = () => {
      state.connected = false;
      setTimeout(init, 3000);
      render();
    };
  } catch (err) {
    console.error("Failed to init session", err);
    setTimeout(init, 3000);
  }
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if(!file) return;
  if(!state.sessionId) {
    alert("Not connected to server yet.");
    return;
  }
  if(file.size > 50 * 1024) {
    alert("File too large (max 50KB)");
    return;
  }
  
  try {
    const text = await file.text();
    const res = await fetch('/api/upload/' + state.sessionId, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-filename': file.name },
      body: text
    });
    if(res.ok) {
      state.uploadedFile = file.name;
      render();
    } else {
      const payload = await res.json().catch(() => ({}));
      alert("Upload failed: " + (payload.error || ('HTTP ' + res.status)));
    }
  } catch(err) {
    alert("Error reading file: " + err);
  }
}

function submit(taskStr) {
  if (!taskStr.trim() || !state.connected || state.running) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    state.lastError = 'Connection not ready. Please wait and retry.';
    render();
    return;
  }
  state.currentTaskText = taskStr;
  state.running = true;
  state.lastError = null;
  state.finalOutput = null;
  state.metrics = null;
  state.decomposition = null;
  state.workflowPhases = [];
  ws.send(JSON.stringify({ type: "run_task", task: taskStr }));
  render();
}

let renderPending = false;
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(function(){renderPending=false;render()})}

function render(){
  const app = document.getElementById('app');
  const al = Object.values(state.agents);
  
  let h = '<div class="header">';
  h += '<div class="logo"><div class="logo-icon">&#x1f9ec;</div> Hivemind</div>';
  h += '<div class="conn-info"><div class="status-dot" style="background:' + (state.connected ? '#10b981' : '#f43f5e') + '"></div>' + (state.connected ? 'Connected' : 'Reconnecting...') + '</div>';
  h += '</div>';
  
  h += '<div class="main-view">';
  
  // Conditionally render Sidebar only when task is running or completed
  if (state.running || state.metrics) {
    h += '<div class="sidebar">';
    h += '<div class="sb-title">Active Fleet</div>';
    
    al.forEach(a => {
      const active = state.activeAgents.has(a.id);
      const action = state.agentActions[a.id];
      const count = state.messageCounts[a.id] || 0;
      
      let tp = state.trustProfile[a.id] || {};
      let entries = Object.entries(tp).sort((x,y) => (y[1].expected||0)-(x[1].expected||0));
      let best = entries[0];
      let trustPct = best ? Math.round((best[1].expected||0)*100) : 0;
      
      h += '<div class="agent-card ' + (active ? 'active' : '') + '">';
      h += '<div class="ac-head">';
      h += '<div class="ac-icon">' + a.emoji + '</div>';
      h += '<div class="ac-info"><div class="ac-name">' + a.name + '</div><div class="ac-role">' + a.role + '</div></div>';
      if (count > 0) h += '<div style="font-size:10px;color:#9ca3af">' + count + ' msgs</div>';
      h += '</div>';
      
      if (best) {
        h += '<div class="ac-trust"><div class="ac-trust-fill" style="width:' + trustPct + '%;background:' + a.color + '"></div></div>';
      }
      
      if (action) {
        h += '<div class="ac-action" style="border-left-color:' + a.color + '">' + esc(action.slice(-80)) + '</div>';
      }
      h += '</div>';
    });
    h += '</div>';
  }
  
  h += '<div class="workspace">';
  
  if (!state.running && !state.metrics) {
    // ---------------------------------------------------------
    // LANDING PAGE (IDLE STATE)
    // ---------------------------------------------------------
    h += '<div class="landing">';
    h += '<h2 class="landing-title">What can Hivemind build for you?</h2>';
    h += '<div class="input-container">';
    h += '<div class="prompt-box">';
    h += '<textarea id="ti" class="prompt-input" placeholder="Describe an application, architecture, or workflow..."></textarea>';
    h += '<div class="prompt-actions">';
    h += '<label class="btn-icon ' + (state.uploadedFile ? 'has-file' : '') + '" title="Upload Context File">';
    h += '<input type="file" style="display:none" onchange="handleFileUpload(event)">';
    h += '📎</label>';
    if (state.uploadedFile) {
      h += '<span style="font-size:12px;color:#4f46e5;margin-left:12px;font-weight:500">' + esc(state.uploadedFile) + ' attached</span>';
    }
    h += '<button class="btn-submit" onclick="submit(document.getElementById(\\'ti\\').value)">Run Swarm 🚀</button>';
    h += '</div></div></div>'; // end input-container
    
    h += '<div class="presets-grid">';
    const presets = [
      { t: "Build a SaaS API", d: "Node.js REST API with auth, rate limiting, and Postgres schemas." },
      { t: "React Dashboard", d: "Frontend admin dashboard using Tailwind and Recharts." },
      { t: "Microservices Plan", d: "Architecture document for migrating a monolith to Kubernetes." },
      { t: "Data Pipeline", d: "Python scripts for ETL processing and analytics." }
    ];
    presets.forEach(p => {
      h += '<div class="preset-card" onclick="document.getElementById(\\'ti\\').value=\\'' + p.t + ': ' + p.d + '\\'"><div class="preset-title">' + p.t + '</div><div class="preset-desc">' + p.d + '</div></div>';
    });
    h += '</div>';
    
    h += '</div>'; // end landing
  } else {
    // ---------------------------------------------------------
    // ACTIVE WORKFLOW VIEW
    // ---------------------------------------------------------
    h += '<div class="top-task-bar">';
    h += '<div style="width:8px;height:8px;border-radius:50%;background:' + (state.running ? '#f59e0b' : '#10b981') + '"></div>';
    h += '<input class="tt-input" value="' + esc(state.currentTaskText || 'Swarm Task Running...') + '" readonly>';
    h += '</div>';
    if (state.lastError) {
      h += '<div style="margin:12px 24px 0;padding:10px 12px;border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:8px;font-size:12px">' + esc(state.lastError) + '</div>';
    }
    
    h += '<div class="workflow-view active">';
    
    if (state.workflowPhases.length === 0 && state.running) {
      h += '<div style="margin:auto;color:#6b7280;font-size:14px;display:flex;align-items:center;gap:12px">Initializing Swarm Intelligence... <div class="status-dot" style="animation:pulseGlow 1.5s infinite;background:#6366f1"></div></div>';
    }
    
    state.workflowPhases.forEach((phase, idx) => {
      const pc = PC[phase.phase] || '#6366f1';
      h += '<div class="wf-page">';
      h += '<div class="wf-head"><span style="font-size:16px">📄</span><div class="wf-agent">' + phase.label + ' Phase</div><div class="wf-badge">' + (phase.agents ? phase.agents.length : 0) + ' Agents</div></div>';
      h += '<div class="wf-body">';
      
      // Render stored actions
      const actions = phase.actions || [];
      [...actions].reverse().forEach(act => {
        h += '<div style="margin-bottom:12px;border-left:2px solid ' + pc + ';padding-left:12px">';
        h += '<div style="font-size:10px;font-weight:600;color:#9ca3af;margin-bottom:4px">' + esc(act.agent) + ' · ' + esc(act.time) + '</div>';
        h += '<div style="font-family:\\'JetBrains Mono\\',monospace">' + esc(act.action) + '</div>';
        h += '</div>';
      });
      
      h += '</div></div>';
      
      // Add arrow if not the last phase
      if (idx < state.workflowPhases.length - 1) {
        h += '<div class="wf-connector"><div class="wf-arrow"></div></div>';
      } else if (state.running) {
        // Active arrow at the end
        h += '<div class="wf-connector"><div class="wf-arrow active"></div></div>';
      }
    });
    
    h += '</div>'; // end workflow-view
  }
  
  h += '</div>'; // end workspace
  
  // Right Information Panel (Metrics & Final Output)
  if (state.finalOutput || (!state.running && state.metrics)) {
    h += '<div class="right-panel">';
    h += '<div class="rp-header">✨ Final Deliverable</div>';
    h += '<div class="rp-body">';
    
    if (!state.running && state.metrics) {
      h += '<div class="metric-grid">';
      h += '<div class="metric-box"><div class="metric-box-title">Duration</div><div class="metric-box-val">' + (state.metrics.duration/1000).toFixed(1) + 's</div></div>';
      h += '<div class="metric-box"><div class="metric-box-title">Agent Calls</div><div class="metric-box-val">' + state.metrics.agentCalls + '</div></div>';
      h += '<div class="metric-box"><div class="metric-box-title">Tokens</div><div class="metric-box-val">~' + state.metrics.tokensEstimate + '</div></div>';
      h += '<div class="metric-box"><div class="metric-box-title">Artifacts</div><div class="metric-box-val">' + (state.metrics.pheromoneTrail && state.metrics.pheromoneTrail.total || 0) + '</div></div>';
      h += '</div>';
    }
    
    if (state.finalOutput) {
      h += renderCode(state.finalOutput);
    }
    
    h += '</div></div>';
  }
  
  h += '</div>'; // end main-view
  
  app.innerHTML = h;
  
  // Auto-scroll workflow view to the right
  const wfView = document.querySelector('.workflow-view');
  if (wfView) wfView.scrollLeft = wfView.scrollWidth;
}

render();
init();
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
