// ═══════════════════════════════════════════════════════════════════════════
//  HIVEMIND PROTOCOL v1 (LEGACY) — Before SESI Algorithm
//  Kept for benchmarking comparison purposes
// ═══════════════════════════════════════════════════════════════════════════
//  This is the original orchestration engine that uses:
//  - LLM-based classification (orchestrator decides everything)
//  - Direct message passing between agents
//  - Simple swarm memory (short-term / long-term arrays)
//  - Keyword-triggered debate protocol
//
//  REPLACED BY: sesi-swarm-server.js (SESI Algorithm)
//
//  SETUP:
//    npm install
//    echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
//    node legacy/hivemind-server-v1.js
// ═══════════════════════════════════════════════════════════════════════════

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Swarm Memory ────────────────────────────────────────────────────
class SwarmMemory {
  constructor() {
    this.shortTerm = [];
    this.longTerm = [];
    this.decisions = [];
    this.debates = [];
    this.taskCount = 0;
  }
  addContext(agentId, content) {
    this.shortTerm.push({ agentId, content, timestamp: Date.now() });
    if (this.shortTerm.length > 50) this.shortTerm.shift();
  }
  addLearning(learning) {
    this.longTerm.push({ learning, timestamp: Date.now() });
    if (this.longTerm.length > 20) this.longTerm.shift();
  }
  addDebate(debate) { this.debates.push({ ...debate, timestamp: Date.now() }); }
  getContext() {
    return {
      recentOutputs: this.shortTerm.slice(-10).map(s => `[${s.agentId}]: ${s.content}`).join("\n"),
      pastLearnings: this.longTerm.map(l => l.learning).join("\n"),
      pastDecisions: this.decisions.slice(-3).map(d => `ADR: ${d.title} - ${d.decision}`).join("\n"),
      taskCount: this.taskCount,
    };
  }
  clearShortTerm() { this.shortTerm = []; this.taskCount++; }
}

const swarmMemory = new SwarmMemory();

// ─── Agent Definitions ───────────────────────────────────────────────
const AGENT_DEFS = {
  orchestrator: {
    name: "Nexus", emoji: "🧠", role: "Orchestrator", color: "#8B5CF6",
    systemPrompt: `You are Nexus, the orchestrator. Analyze the task, select agents, create a plan.
Output JSON: { "classification": "...", "selectedAgents": [...], "reasoning": [...], "plan": [...] }`,
  },
  researcher: {
    name: "Scout", emoji: "🔍", role: "Research Agent", color: "#3B82F6",
    systemPrompt: "You are Scout. Gather information, analyze options, find best practices.",
  },
  planner: {
    name: "Architect", emoji: "📐", role: "Planning Agent", color: "#F59E0B",
    systemPrompt: "You are Architect. Create structured execution plans with dependencies.",
  },
  senior_architect: {
    name: "Sage", emoji: "🏛️", role: "Senior Architect", color: "#D97706",
    systemPrompt: "You are Sage. Reason through architecture decisions step-by-step. Produce ADRs.",
  },
  coder_frontend: {
    name: "Bolt", emoji: "⚡", role: "Frontend Coder", color: "#10B981",
    systemPrompt: "You are Bolt. Write production-quality frontend code.",
  },
  coder_backend: {
    name: "Forge", emoji: "🔧", role: "Backend Coder", color: "#06B6D4",
    systemPrompt: "You are Forge. Write production-quality backend code.",
  },
  coder_systems: {
    name: "Core", emoji: "🔩", role: "Systems Coder", color: "#A855F7",
    systemPrompt: "You are Core. Handle algorithms, DevOps, infrastructure, CI/CD.",
  },
  writer: {
    name: "Quill", emoji: "✍️", role: "Writing Agent", color: "#EC4899",
    systemPrompt: "You are Quill. Draft high-quality written content.",
  },
  reviewer: {
    name: "Sentinel", emoji: "🛡️", role: "Review Agent", color: "#EF4444",
    systemPrompt: "You are Sentinel. Review outputs for quality, bugs, security. You may CHALLENGE any output.",
  },
};

// ─── Legacy Hivemind Engine ──────────────────────────────────────────
class HivemindEngine {
  constructor() {
    this.sessions = new Map();
    this.spectators = new Map();
  }

  createSession() {
    const sessionId = randomUUID().slice(0, 8);
    this.sessions.set(sessionId, { id: sessionId, status: "idle", task: null, log: [], startTime: null });
    this.spectators.set(sessionId, new Set());
    return sessionId;
  }

  broadcast(sessionId, message) {
    const spectators = this.spectators.get(sessionId);
    if (!spectators) return;
    const data = JSON.stringify(message);
    for (const ws of spectators) { if (ws.readyState === 1) ws.send(data); }
  }

  async callAgent(sessionId, agentId, task, context = "") {
    const agentDef = AGENT_DEFS[agentId];
    if (!agentDef) throw new Error(`Unknown agent: ${agentId}`);
    const memCtx = swarmMemory.getContext();

    this.broadcast(sessionId, { type: "agent_start", data: { agentId, name: agentDef.name, emoji: agentDef.emoji, role: agentDef.role, color: agentDef.color, task } });

    let fullResponse = "";
    try {
      const stream = await anthropic.messages.stream({
        model: "claude-sonnet-4-20250514", max_tokens: 4096,
        system: agentDef.systemPrompt,
        messages: [{ role: "user", content: `TASK: ${task}\n${context ? `CONTEXT:\n${context}\n` : ""}${memCtx.recentOutputs ? `MEMORY:\n${memCtx.recentOutputs}\n` : ""}Complete your task.` }],
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.text) {
          fullResponse += event.delta.text;
          this.broadcast(sessionId, { type: "agent_token", data: { agentId, token: event.delta.text } });
        }
      }
    } catch (err) {
      fullResponse = `[Error: ${err.message}]`;
    }

    swarmMemory.addContext(agentId, fullResponse.slice(0, 500));
    this.broadcast(sessionId, { type: "agent_complete", data: { agentId, name: agentDef.name, output: fullResponse } });

    const session = this.sessions.get(sessionId);
    if (session) session.log.push({ agentId, output: fullResponse, timestamp: Date.now() });
    return fullResponse;
  }

  async triggerDebate(sessionId, agentA, agentB, topic, ctxA, ctxB) {
    this.broadcast(sessionId, { type: "debate_start", data: { agentA, agentB, topic } });
    const posA = await this.callAgent(sessionId, agentA, `DEBATE: ${topic}\nState your position.\n${ctxA}`);
    const posB = await this.callAgent(sessionId, agentB, `DEBATE: ${topic}\nChallenge:\n${posA}\nYour view:\n${ctxB}`);
    const resolution = await this.callAgent(sessionId, agentA, `RESOLVE DEBATE:\nYours: ${posA}\nChallenge: ${posB}\nSynthesize.`);
    swarmMemory.addDebate({ topic, agentA, agentB, resolution: resolution.slice(0, 300) });
    this.broadcast(sessionId, { type: "debate_end", data: { topic, resolution: resolution.slice(0, 500) } });
    return resolution;
  }

  async executeTask(sessionId, taskText) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    session.status = "running"; session.task = taskText; session.startTime = Date.now(); session.log = [];
    swarmMemory.clearShortTerm();

    this.broadcast(sessionId, { type: "swarm_start", data: { task: taskText, algorithm: "Legacy Hivemind v1" } });
    this.broadcast(sessionId, { type: "phase_change", data: { phase: "analyzing", label: "ANALYZING" } });

    // Step 1: Orchestrator classifies (LLM-based)
    const planRaw = await this.callAgent(sessionId, "orchestrator", taskText);
    let plan;
    try { const m = planRaw.match(/\{[\s\S]*\}/); plan = m ? JSON.parse(m[0]) : null; } catch { plan = null; }

    if (!plan || !plan.plan) {
      plan = {
        classification: "general",
        selectedAgents: ["researcher", "planner", "writer", "reviewer"],
        plan: [
          { step: 1, agent: "researcher", task: `Research: ${taskText}` },
          { step: 2, agent: "planner", task: `Plan: ${taskText}` },
          { step: 3, agent: "writer", task: `Draft: ${taskText}` },
          { step: 4, agent: "reviewer", task: "Review all outputs" },
        ],
      };
    }

    this.broadcast(sessionId, { type: "plan_ready", data: plan });

    // Step 2: Execute sequentially (no parallelism)
    const outputs = {};
    for (const step of plan.plan) {
      if (!AGENT_DEFS[step.agent]) continue;
      const ctx = Object.entries(outputs).map(([a, o]) => `[${AGENT_DEFS[a]?.name}]: ${o.slice(0, 800)}`).join("\n\n");
      const output = await this.callAgent(sessionId, step.agent, step.task, ctx);
      outputs[step.agent] = output;

      if (step.agent === "reviewer" && output.toLowerCase().includes("challenge") && outputs.senior_architect) {
        await this.triggerDebate(sessionId, "senior_architect", "reviewer", "Architecture quality", outputs.senior_architect, output);
      }
    }

    // Step 3: Synthesize
    this.broadcast(sessionId, { type: "phase_change", data: { phase: "assembling", label: "ASSEMBLING" } });
    const allOut = Object.entries(outputs).map(([a, o]) => `=== ${AGENT_DEFS[a]?.name} ===\n${o}`).join("\n\n");
    const finalOutput = await this.callAgent(sessionId, "orchestrator", `Synthesize into final deliverable for: "${taskText}"\n\n${allOut}`);

    swarmMemory.addLearning(`Task: "${taskText.slice(0, 100)}" - ${(plan.selectedAgents||[]).length} agents`);
    session.status = "complete";

    this.broadcast(sessionId, {
      type: "swarm_complete",
      data: { task: taskText, algorithm: "Legacy Hivemind v1", duration: Date.now() - session.startTime, finalOutput },
    });

    return { finalOutput, plan, outputs };
  }
}

const hivemind = new HivemindEngine();

// ─── REST API ────────────────────────────────────────────────────────
app.post("/api/sessions", (req, res) => {
  const sessionId = hivemind.createSession();
  res.json({ sessionId, algorithm: "Legacy Hivemind v1" });
});

app.post("/api/sessions/:id/run", async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: "task required" });
  try { res.json({ success: true, ...(await hivemind.executeTask(req.params.id, task)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/sessions/:id", (req, res) => {
  const s = hivemind.sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  res.json(s);
});

// ─── WebSocket ───────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const sessionId = new URL(req.url, `http://${req.headers.host}`).pathname.replace("/ws/", "");
  if (!hivemind.sessions.has(sessionId)) hivemind.createSession();
  if (!hivemind.spectators.has(sessionId)) hivemind.spectators.set(sessionId, new Set());
  hivemind.spectators.get(sessionId).add(ws);
  ws.send(JSON.stringify({ type: "connected", data: { sessionId, algorithm: "Legacy Hivemind v1" } }));
  ws.on("message", async (raw) => {
    try { const m = JSON.parse(raw); if (m.type === "run_task" && m.task) hivemind.executeTask(sessionId, m.task).catch(console.error); } catch {}
  });
  ws.on("close", () => hivemind.spectators.get(sessionId)?.delete(ws));
});

// ─── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Legacy Hivemind v1 running on http://localhost:${PORT} (${Object.keys(AGENT_DEFS).length} agents)`);
});
