# CLAUDE.md

This file provides guidance to Claude Code when working with the Hivemind SESI codebase.

## Project Overview

**Hivemind Protocol v2** is a multi-agent AI orchestration system powered by the **SESI algorithm** (Stigmergic Epistemic Swarm Intelligence). It coordinates 9 specialized AI agents through:
- **Stigmergic Pheromone Trail** — indirect communication via shared knowledge artifacts
- **Epistemic Trust Model** — Bayesian Beta-distributed competence per domain
- **Entropic Task Decomposition** — uncertainty-first execution ordering

## Running the Project

```bash
# Install dependencies
npm install

# Start the server
npm start

# Run in development mode (with watch)
npm run dev

# Run tests
npm test

# Run benchmark suite
npm run benchmark

# Lint code
npm run lint

# Validate configuration
npm run validate
```

## Architecture

### Core Components (sesi-swarm-server.js)
- **PheromoneTrail** — Artifact storage with reinforcement/challenge/decay dynamics
- **EpistemicTrustModel** — Bayesian agent competence tracking (Beta distributions)
- **SESIEngine** — Main orchestration loop, session management, agent dispatch
- **computeDomainEntropy()** — Shannon entropy calculation per knowledge domain
- **decomposeTask()** — Phase generation from entropy analysis

### Utility Modules (scripts/lib/)
- **logger.js** — Structured logging with levels (debug/info/warn/error)
- **retry.js** — Exponential backoff retry logic for API calls
- **cost-tracker.js** — Token usage and cost estimation per session
- **persistence.js** — Save/load trust model and session data to disk
- **validate-input.js** — Input validation, rate limiting, error handling middleware

### Tests (tests/)
- **core-algorithm.test.js** — Unit tests for PheromoneTrail, EpistemicTrustModel, entropy decomposition
- **utilities.test.js** — Unit tests for utility modules

### CI Scripts (scripts/ci/)
- **validate-config.js** — Validates project configuration and scans for secrets

## Key Conventions

- **ES Modules** — All files use `import`/`export` (type: "module" in package.json)
- **No TypeScript** — Pure JavaScript with JSDoc comments
- **9 Agents** — Nexus, Scout, Architect, Sage, Bolt, Forge, Core, Quill, Sentinel
- **7 Knowledge Domains** — requirements, architecture, frontend, backend, infrastructure, content, quality
- **Constants** — Algorithm constants defined at module top level (DECAY_RATE, SYNTHESIS_THRESHOLD, etc.)

## Security Guidelines

- NEVER hardcode API keys or secrets in source files
- Always validate user input before processing
- Use rate limiting on public endpoints
- Don't leak internal error details to clients

## Testing

- Run `npm test` before committing
- Tests don't require API keys or network access
- Add tests for new algorithm components
- Maintain test coverage for core classes
