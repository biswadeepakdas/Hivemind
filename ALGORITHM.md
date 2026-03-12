# Stigmergic Epistemic Swarm Intelligence (SESI) Algorithm

## A Novel Multi-Agent Orchestration Algorithm

**Author:** Biswadeepak
**Date:** March 2026
**Version:** 1.0

---

## 1. Abstract

SESI (Stigmergic Epistemic Swarm Intelligence) is a novel multi-agent orchestration
algorithm that combines three concepts that have never been merged in a production
multi-agent LLM system:

1. **Stigmergic Coordination** — agents communicate indirectly through a shared
   environment (the "Pheromone Trail"), not through direct message passing
2. **Epistemic Trust Scoring** — each agent maintains a Bayesian competence model
   that evolves based on review outcomes, creating earned reputation
3. **Entropic Task Decomposition** — tasks are decomposed based on information
   entropy rather than keyword matching, measuring uncertainty to determine
   which specialists reduce it most

This is NOT a recombination of CrewAI's role assignment + LangGraph's DAG execution.
It is a fundamentally different coordination paradigm.

---

## 2. What Makes This Genuinely Novel

### What EXISTS in literature (and what we avoid copying):
| Concept | Where it exists | How SESI differs |
|---------|----------------|-----------------|
| Role-based agents | CrewAI, MetaGPT | SESI has NO fixed roles — agents earn specializations through performance |
| DAG execution | LangGraph | SESI has NO predetermined graph — execution order emerges from pheromone signals |
| Multi-agent debate | MAD (Du et al. 2023) | SESI uses epistemic trust, not debate rounds — low-trust outputs get automatically re-evaluated |
| Swarm intelligence | SwarmSys (2025) | SwarmSys uses pheromones for task matching. SESI uses pheromones for KNOWLEDGE ACCUMULATION — the trail IS the shared reasoning |
| Confidence scoring | iMAD (2025) | iMAD scores confidence on final answers. SESI scores COMPETENCE on agents themselves, updated via Bayesian inference |

### The novel combination:
No existing system uses stigmergic pheromone trails as a shared knowledge substrate
where agents deposit epistemic artifacts (not just task signals), combined with
Bayesian trust that determines agent authority, combined with entropy-based
decomposition that measures information gaps rather than matching keywords.

---

## 3. Core Algorithm

### 3.1 The Pheromone Trail (Shared Knowledge Environment)

Instead of agents passing messages to each other, agents read from and write to
a shared environment called the Trail. The Trail is a structured knowledge graph
where each node is an "epistemic artifact" — a piece of knowledge with metadata.

```
TrailNode {
  id: string
  content: string              // The actual knowledge/output
  author_agent: string         // Who deposited it
  artifact_type: enum {
    HYPOTHESIS,                // An unverified claim or approach
    EVIDENCE,                  // Research findings or data
    DECISION,                  // An architectural or design decision
    IMPLEMENTATION,            // Code or written deliverable
    CRITIQUE,                  // A challenge to another artifact
    SYNTHESIS                  // A merge of multiple artifacts
  }
  confidence: float [0, 1]     // Author's self-assessed confidence
  pheromone_strength: float    // Decays over time, reinforced by usage
  references: TrailNode[]      // Which artifacts this builds on
  challenges: TrailNode[]      // Which artifacts challenge this
  timestamp: int
}
```

**Key insight:** Agents don't talk to each other. They read the Trail, decide what
to work on based on pheromone strength (strong pheromone = important/validated
knowledge), and deposit new artifacts. This is indirect coordination — stigmergy.

**Pheromone dynamics:**
- When an agent reads an artifact and builds on it -> pheromone increases
- When an artifact gets challenged -> pheromone decreases
- Over time, unused artifacts decay (evaporation rate lambda)
- Final synthesis only draws from high-pheromone artifacts

```
pheromone(t+1) = (1 - lambda) * pheromone(t) + sum(reinforcements) - sum(challenges)
```

### 3.2 Epistemic Trust Model (Bayesian Agent Competence)

Each agent has a trust score per domain, modeled as a Beta distribution:

```
Trust(agent, domain) = Beta(alpha, beta)

  alpha = number of successful contributions in this domain + 1
  beta = number of failed/challenged contributions + 1

  Expected competence = alpha / (alpha + beta)
  Uncertainty = 1 / (alpha + beta)  // decreases with more observations
```

Trust is updated after each review cycle:
- If Sentinel approves an artifact -> alpha += 1
- If Sentinel rejects an artifact -> beta += 1
- Trust persists across tasks (this is the "learning" mechanism)

### 3.3 Entropic Task Decomposition

Instead of keyword matching or LLM-based classification, SESI decomposes tasks
by measuring INFORMATION ENTROPY — how much uncertainty exists in different
aspects of the task.

```
Given task T, compute entropy for each knowledge domain D:

  H(D|T) = -sum( p(x) * log2(p(x)) )

  where p(x) is estimated from:
    - keyword density for domain D in task T
    - inverse document frequency of domain terms
    - historical task similarity (from swarm memory)
```

Domains with HIGH entropy (high uncertainty) get assigned specialists first.

### 3.4 The Execution Loop

```
SESI_EXECUTE(task):

  1. DECOMPOSE
     entropies = compute_domain_entropies(task)
     active_domains = filter(entropies > threshold)
     phases = topological_sort_by_entropy_and_dependency(active_domains)

  2. For each phase P in phases:

     a. SELECT AGENTS
        For each domain D in P:
          candidates = agents_with_capability(D)
          selected = argmax(Trust(agent, D).expected_competence)
          if Trust(agent, D).uncertainty > EXPLORE_THRESHOLD:
            mark as exploratory (will be double-checked)

     b. EXECUTE (parallel within phase)
        For each selected agent A:
          context = Trail.read(pheromone > MIN_STRENGTH, relevant_to=D)
          output = A.execute(task_slice, context)
          artifact = TrailNode(output, type=infer_type(output), confidence=A.self_assess())
          Trail.deposit(artifact)

     c. CROSS-POLLINATE
        For each new artifact:
          related = Trail.find_related(artifact)
          if contradiction_detected(artifact, related):
            deposit CRITIQUE artifact
            reduce pheromone on contradicted artifact
            flag for epistemic resolution

     d. VERIFY (epistemic trust gate)
        For artifacts where author.trust.uncertainty > THRESHOLD
        OR artifact.confidence < CONFIDENCE_THRESHOLD
        OR artifact has CRITIQUE:
          verification = Sentinel.verify(artifact)
          update Trust(author, domain) based on result
          update pheromone based on result

  3. SYNTHESIZE
     high_pheromone_artifacts = Trail.read(pheromone > SYNTHESIS_THRESHOLD)
     final = Orchestrator.synthesize(high_pheromone_artifacts)

     // Learning: update long-term trust scores
     for each agent A that contributed:
       persist Trust(A, domain) for future tasks

  4. EVAPORATE
     Trail.decay_all(lambda)  // old artifacts fade, preventing stale knowledge
```

---

## 4. Why This Is Legally Safe

1. **Stigmergy** is a biological concept (coined by Pierre-Paul Grasse, 1959)
   applied to ant colonies. It is a public-domain scientific concept, not
   patentable. Our APPLICATION of it to LLM knowledge sharing is novel.

2. **Beta-distributed trust** is standard Bayesian statistics. The APPLICATION
   to agent competence routing is our contribution.

3. **Information entropy** (Shannon, 1948) is public domain. Using it for
   TASK DECOMPOSITION routing is our contribution.

4. **The combination** of all three into a single coordination algorithm has
   no prior art in either academic literature or commercial products as of
   March 2026 based on our research.

5. This does NOT copy:
   - CrewAI's YAML-based role definitions
   - LangGraph's state machine / graph API
   - AutoGen's conversation protocol
   - MetaGPT's SOP-based workflow
   - OpenAI Swarm's handoff pattern
   - SwarmSys's explorer/worker/validator roles

---

## 5. Comparison Table

| Feature | CrewAI | LangGraph | AutoGen | SwarmSys | **SESI** |
|---------|--------|-----------|---------|----------|----------|
| Agent selection | Manual roles | Graph nodes | Conversation | Fixed roles | **Bayesian trust + entropy** |
| Coordination | Sequential/parallel | State machine | Chat | Pheromone matching | **Stigmergic knowledge trail** |
| Task decomposition | Manual | Manual | LLM-driven | Fixed | **Entropy-based (uncertainty-first)** |
| Quality control | None built-in | Manual | None | Validators | **Epistemic trust gates** |
| Learning | None | State persistence | None | Pheromone decay | **Bayesian trust evolution** |
| Communication | Direct message | Shared state | Chat history | Pheromone signals | **Indirect via knowledge artifacts** |
| Execution order | Predefined | Graph topology | Dynamic chat | Role-based | **Entropy-ranked (most uncertain first)** |

---

## 6. Name and Branding

**SESI** — Stigmergic Epistemic Swarm Intelligence

This name is not used by any existing product, framework, or paper.
Recommended: register as a trademark for the software product.
