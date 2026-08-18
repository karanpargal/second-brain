---
name: feature-graph
description: >-
  Runs the Planner → Worker → parallel Security/Logic/Style reviews → Synthesizer → Gate
  graph over Second Brain product features. Use when analyzing features, judging if
  something is moot or needed, checking if a feature works as intended, running the
  feature graph, or aligning the app to a personal AI desktop agent.
---

# Feature graph

Orchestrate the agents in [agents/graph](../../../agents/graph/README.md). Do not skip nodes. Do not serialize the three reviews.

## Before anything

Read:

1. `agents/graph/NORTH-STAR.md`
2. `agents/graph/GRAPH.md`
3. `.cursor/rules/one-click-desktop.mdc`

North star for this product: **a personal AI agent on the desktop** (one-click .exe, widget not Chrome, local Ollama, propose-only).

## Sequence

1. **Planner** — scope, feature list to inspect, pass criteria. Append `## Run <date> — <title>` to `agents/graph/planner.md`.
2. **Worker** — for each feature: Need? Built? Working? Evidence paths. Write `agents/graph/features.md` (replace the inventory table for this run) and append a log to `agents/graph/worker.md`.
3. **Parallel reviews** — spawn three explore/generalPurpose subagents at once. Each reads north-star + planner + worker + features, inspects the repo through its lens only, appends its journal:
   - Security → `agents/graph/security-review.md`
   - Logic → `agents/graph/logic-review.md`
   - Style → `agents/graph/style-review.md`
4. **Synthesizer** — one verdict per feature (`KEEP` / `FIX` / `CUT` / `MISSING`). Conflicts: security blockers win over style; north-star "not this product" wins over "it works." Append `agents/graph/synthesizer.md`.
5. **Gate** — **Pass** if every needed feature is KEEP or FIX-with-next-action, and no shipping-blocker security hole is unlabeled. **Fail** → Worker revision (max 2 total Worker passes) with synthesizer notes. Append `agents/graph/gate.md`.
6. **Output** — rewrite `agents/graph/output.md` as the guide for building the personal desktop agent. Newest-first log still lives in the other files.

## Journal format (every agent)

```markdown
## Run YYYY-MM-DD — <short title>

**What:** …
**Why:** …
**Evidence:** `path` — symbol or behavior
**Verdicts:** …
```

## Anti-patterns

- Reviewing from README only — open the code.
- Treating `docs/PRODUCT-AUDIT.md` as current without checking the changelog and the tree.
- Recommending `npm run` as the user path.
- Keeping trading, chat-OCR, or multi-tenant work unless the north star file says so.
