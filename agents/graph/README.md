# Product-feature agent graph

Cursor-side agents that inspect Second Brain as a **personal AI agent for the desktop**.

They do not run inside the Tauri app. They are how we (and future Cursor sessions) analyze the product: need it, built it, working as intended — or moot.

## Run a graph

Say: **run the feature graph** (or `@agents/graph` / skill `feature-graph`).

The orchestrating agent must:

1. Read `NORTH-STAR.md` and `GRAPH.md`.
2. Play **Planner** → write `planner.md`.
3. Play **Worker** (or spawn a explore subagent) → write `worker.md` and `features.md`.
4. Spawn **Security, Logic, Style** as parallel subagents → each writes its own file.
5. Play **Synthesizer** → `synthesizer.md`.
6. Play **Gate** → `gate.md`. On fail, return to Worker once (then fail closed).
7. Write `output.md` — this is the product guide for the personal desktop agent.

## Files

| Path | Owner |
|------|--------|
| `NORTH-STAR.md` | Product law for the run |
| `GRAPH.md` | Topology |
| `features.md` | Living inventory |
| `planner.md` … `gate.md` | Per-agent journals |
| `output.md` | Latest passed (or fail-closed) guide |

Related: `docs/PRODUCT-AUDIT.md` is historical diagnosis. Graph output supersedes it for "what should we do next."
