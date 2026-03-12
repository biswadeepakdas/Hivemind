import { useState, useEffect, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════
//  SESI — Stigmergic Epistemic Swarm Intelligence
//  A novel multi-agent orchestration algorithm
// ═══════════════════════════════════════════════════════════════════════

// ─── Agent Definitions ───────────────────────────────────────────────
// Unlike role-based systems, SESI agents have CAPABILITIES and earn trust
// per domain. No fixed roles — trust determines who does what.

const AGENTS = [
  {
    id: "orchestrator",
    name: "Nexus",
    emoji: "🧠",
    role: "Orchestrator",
    color: "#8B5CF6",
    description: "Decomposes tasks by entropy, selects agents by trust, synthesizes the trail",
    capabilities: ["decomposition", "synthesis", "routing"],
    alwaysActive: true,
  },
  {
    id: "researcher",
    name: "Scout",
    emoji: "🔍",
    role: "Research Agent",
    color: "#3B82F6",
    description: "Deposits EVIDENCE artifacts — gathers data, sources, and context",
    capabilities: ["requirements", "architecture", "content", "quality"],
    domainKeywords: {
      requirements: ["research", "find", "analyze", "compare", "benchmark", "study", "explore", "gather", "evaluate", "assess", "survey", "investigate", "discover", "trends", "data", "market"],
      architecture: ["patterns", "options", "technology", "comparison", "stack"],
      content: ["sources", "references", "statistics", "competitive"],
    },
  },
  {
    id: "planner",
    name: "Architect",
    emoji: "📐",
    role: "Planning Agent",
    color: "#F59E0B",
    description: "Deposits DECISION artifacts — structured plans, outlines, breakdowns",
    capabilities: ["requirements", "architecture", "frontend", "backend"],
    domainKeywords: {
      requirements: ["plan", "outline", "organize", "scope", "requirements", "breakdown", "decompose", "prioritize"],
      architecture: ["design", "structure", "framework", "schema", "blueprint", "roadmap", "strategy"],
    },
  },
  {
    id: "senior_architect",
    name: "Sage",
    emoji: "🏛️",
    role: "Senior Architect",
    color: "#D97706",
    description: "Deposits ADR artifacts — deep trade-off reasoning, pattern selection, system decomposition",
    capabilities: ["architecture", "infrastructure", "backend"],
    domainKeywords: {
      architecture: ["architecture", "architect", "microservice", "monolith", "serverless", "event driven", "distributed", "scalable", "cqrs", "ddd", "hexagonal", "saga", "circuit breaker", "api gateway", "cloud native", "migration", "legacy", "modernize", "trade-off", "adr", "kafka", "rabbitmq", "saas", "platform", "mvp", "full stack", "chat", "real-time", "websocket"],
      infrastructure: ["aws", "gcp", "azure", "terraform", "container", "kubernetes", "docker", "observability"],
      backend: ["database", "cache", "redis", "postgres", "mongo", "auth", "oauth", "rbac"],
    },
    reasoningSteps: [
      "Identifying constraints and quality attributes",
      "Enumerating candidate architectures",
      "Evaluating trade-offs for each candidate",
      "Selecting optimal architecture with justification",
      "Defining component boundaries and interfaces",
      "Producing Architecture Decision Record (ADR)",
    ],
  },
  {
    id: "coder_frontend",
    name: "Bolt",
    emoji: "⚡",
    role: "Frontend Coder",
    color: "#10B981",
    description: "Deposits IMPLEMENTATION artifacts — UI components, pages, styling, client logic",
    capabilities: ["frontend"],
    domainKeywords: {
      frontend: ["ui", "frontend", "component", "page", "landing", "website", "web app", "dashboard", "interface", "button", "form", "modal", "css", "style", "responsive", "animation", "react", "vue", "html", "chart", "widget", "navbar", "carousel", "gallery"],
    },
  },
  {
    id: "coder_backend",
    name: "Forge",
    emoji: "🔧",
    role: "Backend Coder",
    color: "#06B6D4",
    description: "Deposits IMPLEMENTATION artifacts — APIs, databases, server logic, auth",
    capabilities: ["backend", "infrastructure"],
    domainKeywords: {
      backend: ["api", "backend", "server", "database", "endpoint", "rest", "graphql", "authentication", "middleware", "controller", "schema", "migration", "query", "sql", "nosql", "cache", "webhook", "microservice", "lambda", "pipeline", "websocket"],
      infrastructure: ["deploy", "docker", "ci/cd"],
    },
  },
  {
    id: "coder_systems",
    name: "Core",
    emoji: "🔩",
    role: "Systems Coder",
    color: "#A855F7",
    description: "Deposits IMPLEMENTATION artifacts — algorithms, CLI, DevOps, infrastructure",
    capabilities: ["infrastructure", "backend", "quality"],
    domainKeywords: {
      infrastructure: ["algorithm", "cli", "script", "automation", "devops", "docker", "kubernetes", "terraform", "ci/cd", "deploy", "config", "monitoring", "logging"],
      quality: ["test", "unit test", "integration test", "benchmark", "performance", "optimize", "profiling"],
    },
  },
  {
    id: "writer",
    name: "Quill",
    emoji: "✍️",
    role: "Writing Agent",
    color: "#EC4899",
    description: "Deposits IMPLEMENTATION artifacts — docs, blog posts, copy, emails, READMEs",
    capabilities: ["content", "requirements"],
    domainKeywords: {
      content: ["write", "draft", "blog", "article", "documentation", "readme", "copy", "content", "email", "report", "proposal", "tutorial", "guide", "announcement", "changelog", "pitch", "presentation", "marketing", "seo"],
      requirements: ["summary", "brief", "description", "narrative", "spec"],
    },
  },
  {
    id: "reviewer",
    name: "Sentinel",
    emoji: "🛡️",
    role: "Review Agent",
    color: "#EF4444",
    description: "Deposits CRITIQUE artifacts — reviews output, challenges low-quality work, updates trust",
    capabilities: ["quality"],
    alwaysReview: true,
    domainKeywords: {
      quality: ["review", "check", "audit", "verify", "validate", "test", "qa", "security", "bug", "fix", "improve", "optimize", "proofread", "refine"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════
//  SESI CORE: Pheromone Trail (Stigmergic Knowledge Environment)
// ═══════════════════════════════════════════════════════════════════════

const ARTIFACT_TYPES = {
  HYPOTHESIS: { label: "Hypothesis", color: "#F59E0B", icon: "💡" },
  EVIDENCE: { label: "Evidence", color: "#3B82F6", icon: "📊" },
  DECISION: { label: "Decision", color: "#D97706", icon: "⚖️" },
  IMPLEMENTATION: { label: "Implementation", color: "#10B981", icon: "🔨" },
  CRITIQUE: { label: "Critique", color: "#EF4444", icon: "🔍" },
  SYNTHESIS: { label: "Synthesis", color: "#8B5CF6", icon: "🧬" },
};

const DECAY_RATE = 0.05; // λ — pheromone evaporation per tick
const MIN_PHEROMONE = 0.1;
const SYNTHESIS_THRESHOLD = 0.5;
const EXPLORE_THRESHOLD = 0.6; // uncertainty above this → exploratory
const CONFIDENCE_THRESHOLD = 0.5;

class PheromoneTrail {
  constructor() { this.artifacts = []; this.nextId = 1; }

  deposit(artifact) {
    const node = {
      id: `art_${this.nextId++}`,
      ...artifact,
      pheromone: artifact.confidence || 0.7,
      timestamp: Date.now(),
      reinforcements: 0,
      challenges: 0,
    };
    this.artifacts.push(node);
    return node;
  }

  reinforce(artifactId) {
    const a = this.artifacts.find(x => x.id === artifactId);
    if (a) { a.pheromone = Math.min(1, a.pheromone + 0.15); a.reinforcements++; }
  }

  challenge(artifactId) {
    const a = this.artifacts.find(x => x.id === artifactId);
    if (a) { a.pheromone = Math.max(0, a.pheromone - 0.2); a.challenges++; }
  }

  decay() {
    this.artifacts.forEach(a => {
      a.pheromone = Math.max(MIN_PHEROMONE, a.pheromone * (1 - DECAY_RATE));
    });
  }

  read(domain, minPheromone = MIN_PHEROMONE) {
    return this.artifacts
      .filter(a => a.domain === domain && a.pheromone >= minPheromone)
      .sort((a, b) => b.pheromone - a.pheromone);
  }

  getStrongArtifacts() {
    return this.artifacts.filter(a => a.pheromone >= SYNTHESIS_THRESHOLD).sort((a, b) => b.pheromone - a.pheromone);
  }

  clear() { this.artifacts = []; this.nextId = 1; }
}

// ═══════════════════════════════════════════════════════════════════════
//  SESI CORE: Epistemic Trust Model (Bayesian Agent Competence)
// ═══════════════════════════════════════════════════════════════════════

class EpistemicTrustModel {
  constructor() {
    // trust[agentId][domain] = { alpha, beta }
    this.trust = {};
    AGENTS.forEach(a => {
      this.trust[a.id] = {};
      (a.capabilities || []).forEach(cap => {
        this.trust[a.id][cap] = { alpha: 2, beta: 1 }; // slight positive prior
      });
    });
  }

  getCompetence(agentId, domain) {
    const t = this.trust[agentId]?.[domain];
    if (!t) return { expected: 0, uncertainty: 1 };
    return {
      expected: t.alpha / (t.alpha + t.beta),
      uncertainty: 1 / (t.alpha + t.beta),
    };
  }

  recordSuccess(agentId, domain) {
    if (this.trust[agentId]?.[domain]) this.trust[agentId][domain].alpha += 1;
  }

  recordFailure(agentId, domain) {
    if (this.trust[agentId]?.[domain]) this.trust[agentId][domain].beta += 1;
  }

  selectBestAgent(domain, candidates) {
    let best = null;
    let bestScore = -1;
    let reasoning = "";
    for (const agent of candidates) {
      const comp = this.getCompetence(agent.id, domain);
      // UCB1-inspired: competence + exploration bonus for uncertain agents
      const explorationBonus = comp.uncertainty > EXPLORE_THRESHOLD ? 0.2 : 0;
      const score = comp.expected + explorationBonus;
      if (score > bestScore) {
        bestScore = score;
        best = agent;
        reasoning = comp.uncertainty > EXPLORE_THRESHOLD
          ? `Exploratory — uncertainty ${(comp.uncertainty * 100).toFixed(0)}%, needs calibration`
          : `Trust ${(comp.expected * 100).toFixed(0)}% in ${domain} (α=${this.trust[agent.id]?.[domain]?.alpha}, β=${this.trust[agent.id]?.[domain]?.beta})`;
      }
    }
    return { agent: best, score: bestScore, reasoning };
  }

  getAgentProfile(agentId) {
    const profile = {};
    for (const [domain, params] of Object.entries(this.trust[agentId] || {})) {
      const comp = this.getCompetence(agentId, domain);
      profile[domain] = { ...comp, alpha: params.alpha, beta: params.beta };
    }
    return profile;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  SESI CORE: Entropic Task Decomposition
// ═══════════════════════════════════════════════════════════════════════

const KNOWLEDGE_DOMAINS = {
  requirements: {
    label: "Requirements",
    keywords: ["need", "want", "should", "must", "feature", "user", "story", "requirement", "goal", "objective", "specification", "scope", "criteria"],
    color: "#F59E0B",
  },
  architecture: {
    label: "Architecture",
    keywords: ["architecture", "design", "system", "pattern", "structure", "service", "microservice", "monolith", "serverless", "distributed", "scale", "event", "domain", "cqrs", "saga", "gateway", "mesh", "cloud", "container", "docker", "kubernetes", "saas", "platform", "mvp", "full stack", "fullstack", "migrate", "modernize", "legacy"],
    color: "#D97706",
  },
  frontend: {
    label: "Frontend",
    keywords: ["ui", "frontend", "component", "page", "react", "vue", "html", "css", "responsive", "animation", "dashboard", "widget", "layout", "button", "form", "modal", "chart", "landing", "website", "web", "interface", "display", "visual", "interactive"],
    color: "#10B981",
  },
  backend: {
    label: "Backend",
    keywords: ["api", "backend", "server", "database", "endpoint", "rest", "graphql", "auth", "middleware", "route", "schema", "migration", "query", "sql", "cache", "queue", "webhook", "lambda", "function", "pipeline", "socket", "grpc"],
    color: "#06B6D4",
  },
  infrastructure: {
    label: "Infrastructure",
    keywords: ["deploy", "devops", "docker", "ci/cd", "terraform", "aws", "gcp", "azure", "monitoring", "logging", "infrastructure", "config", "environment", "kubernetes", "container"],
    color: "#A855F7",
  },
  content: {
    label: "Content",
    keywords: ["write", "blog", "article", "documentation", "readme", "copy", "email", "report", "proposal", "tutorial", "guide", "content", "marketing", "seo", "draft", "story", "pitch", "presentation"],
    color: "#EC4899",
  },
  quality: {
    label: "Quality",
    keywords: ["review", "test", "quality", "security", "audit", "verify", "validate", "bug", "lint", "fix", "optimize", "performance", "benchmark"],
    color: "#EF4444",
  },
};

function computeDomainEntropy(taskText, domainKeywords) {
  const words = taskText.toLowerCase().split(/\s+/);
  const totalWords = words.length;
  if (totalWords === 0) return 0;

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

  // Keyword density
  const density = matchCount / totalWords;

  // Entropy: high density = low entropy (well-specified), low density = high entropy (uncertain)
  // We want INVERSE entropy — domains with SOME signal but not fully specified are most uncertain
  // Peak entropy at density ~0.15 (some keywords but not dominant)
  const p = Math.min(density, 1);
  const entropy = p > 0 && p < 1 ? -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)) : 0;

  return { entropy, density, matchedTerms };
}

function decomposeTask(taskText) {
  const domainAnalysis = {};
  const activeDomains = [];

  for (const [domain, info] of Object.entries(KNOWLEDGE_DOMAINS)) {
    const analysis = computeDomainEntropy(taskText, info.keywords);
    domainAnalysis[domain] = analysis;
    if (analysis.density > 0) {
      activeDomains.push({ domain, ...analysis, label: info.label, color: info.color });
    }
  }

  // Sort by entropy (highest first — tackle uncertainty first)
  activeDomains.sort((a, b) => b.entropy - a.entropy);

  // Always include quality (review) at the end
  const hasQuality = activeDomains.some(d => d.domain === "quality");
  if (!hasQuality) {
    activeDomains.push({
      domain: "quality",
      entropy: 0.1,
      density: 0,
      matchedTerms: [],
      label: "Quality",
      color: "#EF4444",
    });
  }

  // Group into phases based on dependency rules
  const phases = [];
  const phase1 = activeDomains.filter(d => d.domain === "requirements");
  const phase2 = activeDomains.filter(d => d.domain === "architecture");
  const phase3 = activeDomains.filter(d => ["frontend", "backend", "infrastructure", "content"].includes(d.domain));
  const phase4 = activeDomains.filter(d => d.domain === "quality");

  if (phase1.length) phases.push({ name: "Discovery", domains: phase1 });
  if (phase2.length) phases.push({ name: "Architecture", domains: phase2 });
  if (phase3.length) phases.push({ name: "Execution", domains: phase3 });
  if (phase4.length) phases.push({ name: "Verification", domains: phase4 });

  return { domainAnalysis, activeDomains, phases };
}

// ═══════════════════════════════════════════════════════════════════════
//  SESI SIMULATION ENGINE — runs the full algorithm visually
// ═══════════════════════════════════════════════════════════════════════

function generateSESIWorkflow(taskText, trustModel) {
  const decomposition = decomposeTask(taskText);
  const trail = new PheromoneTrail();
  const flow = [];
  const agentSelections = [];

  // Phase 0: Orchestrator decomposes by entropy
  flow.push({
    agent: "orchestrator",
    action: `Entropic decomposition: measuring uncertainty across ${Object.keys(KNOWLEDGE_DOMAINS).length} domains...`,
    duration: 1000,
    phase: "decompose",
    artifactType: null,
  });

  const domainSummary = decomposition.activeDomains
    .map(d => `${d.label}: entropy=${d.entropy.toFixed(2)}, density=${d.density.toFixed(2)} [${d.matchedTerms.slice(0, 3).join(", ")}]`)
    .join("\n");

  flow.push({
    agent: "orchestrator",
    action: `Decomposition complete — ${decomposition.activeDomains.length} active domains, ${decomposition.phases.length} phases`,
    duration: 800,
    phase: "decompose",
    output: `ENTROPIC DECOMPOSITION\n━━━━━━━━━━━━━━━━━━━━━\n${domainSummary}\n\nExecution order: uncertainty-first\nPhases: ${decomposition.phases.map(p => p.name).join(" → ")}`,
    artifactType: "HYPOTHESIS",
  });

  // Execute each phase
  for (const phase of decomposition.phases) {
    const phaseName = phase.name.toLowerCase();

    for (const domainInfo of phase.domains) {
      const domain = domainInfo.domain;

      // Select agent by trust
      const candidates = AGENTS.filter(a => (a.capabilities || []).includes(domain) && !a.alwaysActive);
      if (candidates.length === 0) continue;

      const selection = trustModel.selectBestAgent(domain, candidates);
      if (!selection.agent) continue;

      agentSelections.push({
        domain,
        agent: selection.agent.id,
        score: selection.score,
        reasoning: selection.reasoning,
      });

      // Orchestrator announces routing decision
      flow.push({
        agent: "orchestrator",
        action: `Trust-based routing: ${selection.agent.name} selected for "${domainInfo.label}" — ${selection.reasoning}`,
        duration: 500,
        phase: phaseName === "discovery" ? "research" : phaseName === "verification" ? "review" : phaseName,
        targets: [selection.agent.id],
      });

      // Agent executes and deposits artifacts
      const actions = getAgentActions(selection.agent.id, taskText, domain, domainInfo);
      actions.forEach(a => flow.push({
        ...a,
        phase: phaseName === "discovery" ? "research" : phaseName === "verification" ? "review" : phaseName,
      }));
    }
  }

  // Pheromone trail synthesis
  flow.push({
    agent: "orchestrator",
    action: "Reading pheromone trail — collecting high-strength artifacts for synthesis...",
    duration: 800,
    phase: "synthesis",
  });

  flow.push({
    agent: "orchestrator",
    action: "Synthesizing final deliverable from strongest artifacts",
    duration: 1200,
    phase: "synthesis",
    artifactType: "SYNTHESIS",
    output: `PHEROMONE TRAIL SYNTHESIS\n━━━━━━━━━━━━━━━━━━━━━━━\nArtifacts deposited: ${flow.filter(f => f.artifactType).length + 2}\nHigh-pheromone artifacts: ${Math.max(3, decomposition.activeDomains.length)}\nDomains covered: ${decomposition.activeDomains.map(d => d.label).join(", ")}\nTrust updates: ${agentSelections.length} agents scored\n\n✅ All epistemic gates passed — deliverable assembled`,
  });

  return { flow, decomposition, agentSelections };
}

function getAgentActions(agentId, task, domain, domainInfo) {
  const lower = task.toLowerCase();
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) return [];

  // Sage (Senior Architect) — always does deep reasoning
  if (agentId === "senior_architect") {
    const steps = agent.reasoningSteps || [];
    const actions = steps.map((step, i) => ({
      agent: agentId,
      action: `🔬 Reasoning Step ${i + 1}: ${step}`,
      duration: 1200 + Math.random() * 800,
      artifactType: i === steps.length - 1 ? "DECISION" : null,
    }));

    // ADR output depends on task content
    let adrOutput = "ARCHITECTURE DECISION RECORD (ADR-001)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    if (/microservice|distributed|event/i.test(lower)) {
      adrOutput += "Context: Distributed system with high availability\nCandidates: Monolith (rejected) | Microservices (selected) | Serverless (rejected)\nDecision: Event-driven microservices with saga orchestration\nPatterns: CQRS, Event Sourcing, Circuit Breaker\nRisks: Distributed tracing → mitigate with OpenTelemetry";
    } else if (/saas|platform|mvp|full.?stack/i.test(lower)) {
      adrOutput += "Context: SaaS product with multi-tenancy needs\nDecision: Modular monolith (start simple, decompose later)\nStack: React + Node.js + PostgreSQL + Prisma\nTrade-offs: Ship velocity ✓ vs. scale limits ✗\nMitigation: Clean module boundaries for future split";
    } else if (/chat|real.?time|websocket/i.test(lower)) {
      adrOutput += "Context: Real-time bidirectional communication\nDecision: WebSocket + Redis Pub/Sub for horizontal scale\nRejected: SSE (no client→server), polling (latency)\nStorage: PostgreSQL (messages) + Redis (presence)";
    } else {
      adrOutput += "Context: System requires careful architectural choices\nCandidates: 3 patterns evaluated with trade-off matrix\nDecision: Optimal pattern selected with justification\nRisks: 2 identified with mitigation strategies";
    }

    actions.push({
      agent: agentId,
      action: "Depositing ADR artifact to pheromone trail (confidence: 0.92)",
      duration: 600,
      artifactType: "DECISION",
      output: adrOutput,
      pheromoneAction: "deposit",
      confidence: 0.92,
    });

    return actions;
  }

  // Researcher — deposits EVIDENCE
  if (agentId === "researcher") {
    return [
      { agent: agentId, action: `Scanning for evidence in "${domainInfo.label}" domain...`, duration: 1800, artifactType: null },
      {
        agent: agentId,
        action: `Depositing EVIDENCE artifact (confidence: 0.85)`,
        duration: 800,
        artifactType: "EVIDENCE",
        output: `Evidence gathered for ${domainInfo.label}:\n${domainInfo.matchedTerms.length} signals detected, best practices compiled\nPheromone strength: 0.85 (high relevance)`,
        pheromoneAction: "deposit",
        confidence: 0.85,
      },
    ];
  }

  // Planner — deposits DECISION
  if (agentId === "planner") {
    return [
      { agent: agentId, action: `Creating structured plan for "${domainInfo.label}"...`, duration: 1600 },
      {
        agent: agentId,
        action: "Depositing DECISION artifact — execution plan",
        duration: 700,
        artifactType: "DECISION",
        output: `Execution plan for ${domainInfo.label}:\nWork packages defined, dependencies mapped\nPheromone strength: 0.80`,
        pheromoneAction: "deposit",
        confidence: 0.80,
      },
    ];
  }

  // Coders — deposit IMPLEMENTATION
  if (agentId.startsWith("coder_")) {
    const implLabel = domain === "frontend" ? "UI components" : domain === "backend" ? "API + data layer" : "infra + tooling";
    return [
      { agent: agentId, action: `Reading trail for architecture decisions...`, duration: 600, pheromoneAction: "read" },
      { agent: agentId, action: `Building ${implLabel} (referencing ${domainInfo.matchedTerms.slice(0, 3).join(", ")})...`, duration: 2200 },
      {
        agent: agentId,
        action: `Depositing IMPLEMENTATION artifact (confidence: 0.88)`,
        duration: 600,
        artifactType: "IMPLEMENTATION",
        output: `Implementation: ${implLabel} complete\nReinforcing architecture artifacts on trail (+0.15 pheromone)\nPheromone strength: 0.88`,
        pheromoneAction: "deposit",
        confidence: 0.88,
      },
    ];
  }

  // Writer — deposits IMPLEMENTATION
  if (agentId === "writer") {
    return [
      { agent: agentId, action: `Reading trail for context and decisions...`, duration: 500, pheromoneAction: "read" },
      { agent: agentId, action: `Drafting ${domainInfo.label} deliverable...`, duration: 2000 },
      {
        agent: agentId,
        action: "Depositing content IMPLEMENTATION artifact (confidence: 0.83)",
        duration: 600,
        artifactType: "IMPLEMENTATION",
        output: `Written deliverable deposited to trail\nPheromone strength: 0.83`,
        pheromoneAction: "deposit",
        confidence: 0.83,
      },
    ];
  }

  // Reviewer — deposits CRITIQUE + updates trust
  if (agentId === "reviewer") {
    return [
      { agent: agentId, action: "Scanning pheromone trail for all artifacts...", duration: 800, pheromoneAction: "read" },
      { agent: agentId, action: "Running epistemic verification — checking confidence vs. quality...", duration: 2000 },
      {
        agent: agentId,
        action: "Depositing CRITIQUE artifact — trust scores updated",
        duration: 1000,
        artifactType: "CRITIQUE",
        output: `EPISTEMIC REVIEW\n━━━━━━━━━━━━━━━━\nArtifacts reviewed: all on trail\nChallenges: 1 minor (low-confidence artifact reinforced after check)\nTrust updates: +α for high-quality contributors\nPheromone adjustments: 2 reinforced, 0 evaporated\nOverall quality score: 96/100`,
        pheromoneAction: "deposit",
        confidence: 0.95,
      },
    ];
  }

  return [
    { agent: agentId, action: "Executing task...", duration: 2000 },
    { agent: agentId, action: "Artifact deposited", duration: 600, artifactType: "IMPLEMENTATION" },
  ];
}

// ═══════════════════════════════════════════════════════════════════════
//  UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

const getAgent = (id) => AGENTS.find((a) => a.id === id);

const PHASE_LABELS = {
  decompose: { label: "DECOMPOSING", color: "#8B5CF6" },
  research: { label: "RESEARCHING", color: "#3B82F6" },
  architecture: { label: "ARCHITECTING", color: "#D97706" },
  execution: { label: "EXECUTING", color: "#10B981" },
  review: { label: "REVIEWING", color: "#EF4444" },
  synthesis: { label: "SYNTHESIZING", color: "#8B5CF6" },
};

function AgentCard({ agent, isActive, isBusy, currentAction, messageCount, isSelected, trustProfile }) {
  const dimmed = isSelected !== undefined && !isSelected;
  return (
    <div style={{ background: isActive ? `${agent.color}15` : "#13132a", border: `2px solid ${isActive ? agent.color : dimmed ? "#1a1a2e" : "#222244"}`, borderRadius: 14, padding: "14px 16px", transition: "all 0.4s ease", transform: isActive ? "scale(1.02)" : "scale(1)", boxShadow: isActive ? `0 0 20px ${agent.color}30` : "none", position: "relative", overflow: "hidden", opacity: dimmed ? 0.35 : 1 }}>
      {isBusy && <div style={{ position: "absolute", top: 0, left: 0, height: 3, background: `linear-gradient(90deg, transparent, ${agent.color}, transparent)`, animation: "sweep 1.5s infinite", width: "100%" }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 24 }}>{agent.emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: "#fff", fontSize: 14 }}>{agent.name}</div>
          <div style={{ fontSize: 10, color: agent.color, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>{agent.role}</div>
        </div>
        {messageCount > 0 && <span style={{ background: agent.color, color: "#fff", borderRadius: 99, fontSize: 10, fontWeight: 700, padding: "2px 7px" }}>{messageCount}</span>}
      </div>
      <div style={{ fontSize: 11, color: "#666", lineHeight: 1.4, marginBottom: currentAction || trustProfile ? 8 : 0 }}>{agent.description}</div>
      {trustProfile && Object.keys(trustProfile).length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: currentAction ? 6 : 0 }}>
          {Object.entries(trustProfile).slice(0, 3).map(([domain, data]) => (
            <span key={domain} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: `${KNOWLEDGE_DOMAINS[domain]?.color || "#666"}20`, color: KNOWLEDGE_DOMAINS[domain]?.color || "#666", fontWeight: 600 }}>
              {domain} {(data.expected * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      )}
      {currentAction && (
        <div style={{ padding: "7px 9px", background: "#0b0b1a", borderRadius: 7, fontSize: 11, color: agent.color, fontFamily: "'JetBrains Mono', monospace", borderLeft: `3px solid ${agent.color}`, lineHeight: 1.4 }}>
          {currentAction}
        </div>
      )}
    </div>
  );
}

function EntropyPanel({ decomposition, agentSelections }) {
  if (!decomposition) return null;
  return (
    <div style={{ padding: "14px 16px", background: "#0d0d20", borderRadius: 12, border: "1px solid #1e1e3a", marginBottom: 12, animation: "fadeSlide 0.3s ease" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 14 }}>🧠</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#8B5CF6", textTransform: "uppercase", letterSpacing: 1 }}>SESI Entropic Decomposition</span>
      </div>
      <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>Domains ranked by information entropy (uncertainty-first execution):</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {decomposition.activeDomains.map((d, i) => (
          <div key={d.domain} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: "#0a0a18", borderRadius: 6 }}>
            <span style={{ fontSize: 11, color: "#555", fontFamily: "monospace", width: 16 }}>#{i + 1}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: d.color, minWidth: 80 }}>{d.label}</span>
            <div style={{ flex: 1, height: 4, background: "#1a1a2e", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.max(5, d.entropy * 100)}%`, background: d.color, borderRadius: 2, transition: "width 0.5s" }} />
            </div>
            <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace", minWidth: 50 }}>H={d.entropy.toFixed(2)}</span>
          </div>
        ))}
      </div>
      {agentSelections.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid #1a1a2e", paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>Trust-based agent routing:</div>
          {agentSelections.map((sel, i) => {
            const agent = getAgent(sel.agent);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", background: "#0a0a18", borderRadius: 5, marginBottom: 2 }}>
                <span style={{ fontSize: 12 }}>{agent?.emoji}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: agent?.color }}>{agent?.name}</span>
                <span style={{ fontSize: 10, color: "#555" }}>→ {sel.domain}</span>
                <span style={{ fontSize: 9, color: "#444", fontFamily: "monospace", marginLeft: "auto" }}>{sel.reasoning}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LogEntry({ entry, index }) {
  const agent = getAgent(entry.agent);
  const phaseInfo = entry.phase ? PHASE_LABELS[entry.phase] : null;
  const artifactInfo = entry.artifactType ? ARTIFACT_TYPES[entry.artifactType] : null;
  return (
    <div style={{ display: "flex", gap: 10, padding: "9px 12px", background: index % 2 === 0 ? "transparent" : "#13132a44", borderRadius: 8, animation: "fadeSlide 0.3s ease" }}>
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 2 }}>{agent?.emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, color: agent?.color, fontSize: 12 }}>{agent?.name}</span>
          {phaseInfo && <span style={{ fontSize: 9, color: phaseInfo.color, fontWeight: 700, background: `${phaseInfo.color}15`, padding: "1px 6px", borderRadius: 4, letterSpacing: 0.5 }}>{phaseInfo.label}</span>}
          {artifactInfo && <span style={{ fontSize: 9, color: artifactInfo.color, fontWeight: 600, display: "flex", alignItems: "center", gap: 2 }}>{artifactInfo.icon} {artifactInfo.label}</span>}
          <span style={{ fontSize: 10, color: "#555" }}>{entry.time}</span>
          {entry.targets && entry.targets.length > 0 && (
            <span style={{ fontSize: 10, color: "#777", display: "flex", alignItems: "center", gap: 3 }}>→ {entry.targets.map((t) => getAgent(t)?.emoji).join(" ")}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "#bbb", lineHeight: 1.4 }}>{entry.action}</div>
        {entry.output && (
          <div style={{ marginTop: 5, padding: "7px 9px", background: "#090918", borderRadius: 6, fontSize: 11, color: "#7dd3fc", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "pre-wrap", borderLeft: `3px solid ${agent?.color}33`, lineHeight: 1.5 }}>{entry.output}</div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════════

const globalTrustModel = new EpistemicTrustModel();

export default function AgentSwarm() {
  const [task, setTask] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [activeAgents, setActiveAgents] = useState(new Set());
  const [busyAgents, setBusyAgents] = useState(new Set());
  const [agentActions, setAgentActions] = useState({});
  const [messageCounts, setMessageCounts] = useState({});
  const [connections, setConnections] = useState([]);
  const [progress, setProgress] = useState(0);
  const [completedTasks, setCompletedTasks] = useState(0);
  const [decomposition, setDecomposition] = useState(null);
  const [agentSelections, setAgentSelections] = useState([]);
  const [currentPhase, setCurrentPhase] = useState(null);
  const [trustProfiles, setTrustProfiles] = useState({});
  const logRef = useRef(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Update trust profiles for display
  useEffect(() => {
    const profiles = {};
    AGENTS.forEach(a => { profiles[a.id] = globalTrustModel.getAgentProfile(a.id); });
    setTrustProfiles(profiles);
  }, [completedTasks]);

  const runSwarm = useCallback(async (taskText) => {
    cancelRef.current = false;
    setIsRunning(true);
    setLog([]);
    setActiveAgents(new Set());
    setBusyAgents(new Set());
    setAgentActions({});
    setMessageCounts({});
    setConnections([]);
    setProgress(0);
    setCurrentPhase(null);
    setDecomposition(null);
    setAgentSelections([]);

    const { flow, decomposition: decomp, agentSelections: selections } = generateSESIWorkflow(taskText, globalTrustModel);
    setDecomposition(decomp);
    setAgentSelections(selections);

    const counts = {};
    for (let i = 0; i < flow.length; i++) {
      if (cancelRef.current) break;
      const step = flow[i];
      const agentId = step.agent;

      setCurrentPhase(step.phase || null);
      setActiveAgents(prev => new Set([...prev, agentId]));
      setBusyAgents(prev => new Set([...prev, agentId]));
      setAgentActions(prev => ({ ...prev, [agentId]: step.action }));
      counts[agentId] = (counts[agentId] || 0) + 1;
      setMessageCounts({ ...counts });

      if (step.targets) {
        setConnections(step.targets.map(t => ({ from: agentId, to: t })));
        step.targets.forEach(t => setActiveAgents(prev => new Set([...prev, t])));
      }

      const now = new Date();
      const time = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
      setLog(prev => [...prev, { ...step, time }]);

      await new Promise(r => setTimeout(r, step.duration));

      setBusyAgents(prev => { const next = new Set(prev); next.delete(agentId); return next; });
      if (!step.targets) setConnections([]);
      setProgress(((i + 1) / flow.length) * 100);
    }

    // Update trust model (simulate positive outcomes)
    selections.forEach(sel => {
      globalTrustModel.recordSuccess(sel.agent, sel.domain);
    });

    setIsRunning(false);
    setBusyAgents(new Set());
    setConnections([]);
    setAgentActions({});
    setCurrentPhase(null);
    if (!cancelRef.current) setCompletedTasks(p => p + 1);

    // Refresh trust profiles
    const profiles = {};
    AGENTS.forEach(a => { profiles[a.id] = globalTrustModel.getAgentProfile(a.id); });
    setTrustProfiles(profiles);
  }, []);

  const handleSubmit = (e) => { e.preventDefault(); if (!task.trim() || isRunning) return; runSwarm(task.trim()); };
  const handleCancel = () => { cancelRef.current = true; setIsRunning(false); setBusyAgents(new Set()); setConnections([]); setAgentActions({}); setCurrentPhase(null); };

  const presets = [
    "Build a SaaS dashboard with auth and analytics",
    "Design a scalable microservices architecture",
    "Create a REST API with user management",
    "Architect a real-time chat system",
    "Write a technical blog post about event sourcing",
    "Migrate monolith to event-driven microservices",
    "Build a landing page with pricing",
  ];

  const selectedSet = agentSelections.length > 0 ? new Set(["orchestrator", ...agentSelections.map(s => s.agent)]) : undefined;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a1a", color: "#e0e0e0", fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}>
      <style>{`
        @keyframes sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes fadeSlide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes gradientShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        input::placeholder { color: #555; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 3px; }
      `}</style>

      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #1a1a2e" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "linear-gradient(135deg, #8B5CF6, #D97706, #10B981)", backgroundSize: "200% 200%", animation: "gradientShift 4s ease infinite", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🐝</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#fff", letterSpacing: -0.5 }}>SESI — Stigmergic Epistemic Swarm Intelligence</h1>
            <p style={{ margin: 0, fontSize: 12, color: "#666" }}>{AGENTS.length} agents · entropy decomposition · Bayesian trust · pheromone trail · {completedTasks} tasks</p>
          </div>
          {currentPhase && PHASE_LABELS[currentPhase] && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: 99, background: PHASE_LABELS[currentPhase].color, animation: "pulse 1s infinite" }} />
              <span style={{ fontSize: 11, color: PHASE_LABELS[currentPhase].color, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>{PHASE_LABELS[currentPhase].label}</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", height: "calc(100vh - 82px)" }}>
        <div style={{ width: 300, padding: "16px 12px", overflowY: "auto", borderRight: "1px solid #1a1a2e", flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10, paddingLeft: 4 }}>Agent Fleet ({AGENTS.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {AGENTS.map(agent => (
              <AgentCard key={agent.id} agent={agent} isActive={activeAgents.has(agent.id)} isBusy={busyAgents.has(agent.id)} currentAction={agentActions[agent.id] || null} messageCount={messageCounts[agent.id] || 0} isSelected={selectedSet ? selectedSet.has(agent.id) : undefined} trustProfile={trustProfiles[agent.id]} />
            ))}
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #1a1a2e" }}>
            <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
              <input type="text" value={task} onChange={e => setTask(e.target.value)} placeholder="Describe a task — SESI will decompose it by entropy, route by trust, coordinate via pheromone trail..." disabled={isRunning} style={{ flex: 1, padding: "11px 14px", background: "#12122a", border: "2px solid #2a2a4a", borderRadius: 10, color: "#fff", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
              {isRunning
                ? <button type="button" onClick={handleCancel} style={{ padding: "11px 20px", background: "#EF444418", border: "2px solid #EF4444", borderRadius: 10, color: "#EF4444", fontWeight: 700, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>Stop</button>
                : <button type="submit" disabled={!task.trim()} style={{ padding: "11px 20px", background: task.trim() ? "linear-gradient(135deg, #8B5CF6, #D97706)" : "#2a2a4a", border: "none", borderRadius: 10, color: task.trim() ? "#fff" : "#555", fontWeight: 700, cursor: task.trim() ? "pointer" : "default", fontSize: 13, fontFamily: "inherit", whiteSpace: "nowrap" }}>Deploy</button>
              }
            </form>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {presets.map(p => <button key={p} onClick={() => !isRunning && setTask(p)} disabled={isRunning} style={{ padding: "4px 10px", background: "#13132a", border: "1px solid #222244", borderRadius: 6, color: "#777", fontSize: 11, cursor: isRunning ? "default" : "pointer", fontFamily: "inherit", opacity: isRunning ? 0.4 : 1 }}>{p}</button>)}
            </div>
          </div>

          {isRunning && (
            <div style={{ padding: "0 20px", paddingTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 10, color: "#777" }}>Swarm progress</span>
                <span style={{ fontSize: 10, color: "#8B5CF6", fontWeight: 600 }}>{Math.round(progress)}%</span>
              </div>
              <div style={{ height: 3, background: "#1a1a2e", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, #8B5CF6, #D97706, #10B981)", borderRadius: 99, transition: "width 0.5s ease" }} />
              </div>
            </div>
          )}

          {connections.length > 0 && (
            <div style={{ padding: "8px 20px 0", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {connections.map((c, i) => { const a1 = getAgent(c.from); const a2 = getAgent(c.to); return (
                <div key={i} style={{ fontSize: 10, color: "#666", padding: "2px 8px", background: "#13132a", borderRadius: 99, display: "inline-flex", alignItems: "center", gap: 4, animation: "pulse 1s infinite" }}>{a1?.emoji} → {a2?.emoji}</div>
              ); })}
            </div>
          )}

          <div ref={logRef} style={{ flex: 1, overflowY: "auto", padding: "14px 20px" }}>
            {log.length === 0 && !decomposition ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#444" }}>
                <div style={{ fontSize: 44, marginBottom: 12 }}>🐝</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>SESI Swarm standing by</div>
                <div style={{ fontSize: 12, color: "#555", maxWidth: 420, margin: "0 auto", lineHeight: 1.6 }}>
                  Enter any task — the swarm will decompose it by information entropy, select agents by Bayesian trust, coordinate through a stigmergic pheromone trail, and synthesize the strongest artifacts into a deliverable.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <EntropyPanel decomposition={decomposition} agentSelections={agentSelections} />
                <div style={{ fontSize: 10, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>Pheromone Trail Activity ({log.length} ops)</div>
                {log.map((entry, i) => <LogEntry key={i} entry={entry} index={i} />)}
                {!isRunning && log.length > 0 && (
                  <div style={{ textAlign: "center", padding: "16px", margin: "10px 0", background: "linear-gradient(135deg, #10B98112, #D9770612)", borderRadius: 10, border: "1px solid #10B98130" }}>
                    <div style={{ fontWeight: 700, color: "#10B981", fontSize: 13 }}>SESI task complete</div>
                    <div style={{ fontSize: 11, color: "#666", marginTop: 3 }}>
                      {agentSelections.length} agents · {log.filter(l => l.artifactType).length} artifacts deposited · trust scores updated · pheromone trail decayed
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
