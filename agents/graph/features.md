# Feature inventory

Run: **2026-08-18 — Improve coach re-audit (graph engineering)**  
Worker pass: 1  
Final verdicts: see `synthesizer.md` / `output.md` after Gate.

Legend: Need = required for this Improve product (north star upskill). Built = real code. Working = user who only opens the .exe sees the intended behavior.

| ID | Feature | Need | Built | Working | Notes / evidence |
|----|---------|------|-------|---------|------------------|
| U01 | Topics from search/browse titles | yes | yes | partial | `extractLearningTopic` / `rankLearningTopics` in `packages/agents/src/insight-quality.ts`. Generator uses artifacts last 7d (`insights.ts`). Parser does the job; ranking source is the collapsed artifact (see U11). |
| U02 | 1–2 article/video suggestions | yes | yes | partial | `suggestResources` → `runLlm` `purpose: "improve-suggest"`, `skipHosted: true`. Offline copy if provider ≠ ollama. `parseSuggestions` keeps ≤2 `https` URLs. No existence check (U12). |
| U03 | Open suggestion from widget | yes | yes | yes* | Widget Watch/Read; `openExternal` returns unless `isHttpsUrl`. Host shown. `shell:allow-open`. *Depends on U02 producing a real URL. |
| U04 | Track a topic | yes | yes | yes | `trackLearningTopic` → `Learn: {topic}` loop, tag `upskill`. Widget Track this + “I want to learn” form (`WidgetPage.tsx`). Duplicate match via `topicMatches`. |
| U05 | Tracked-target progress | yes | yes | partial | On generate, matching ranked topic → `progress` card + `lastSeenAt`. Body is a single sentence. Fragile if U11 overwrote the search title. |
| U06 | No focus / deep-work telemetry | yes | yes | yes | Generator no longer inserts those kinds; deletes `TELEMETRY_KINDS`. `listInsights` only `learn`/`progress`. |
| U07 | Hide stale telemetry in DB | yes | yes | yes | Same delete pass. GET cannot return old FOCUS rows through `listInsights`. |
| U08 | Widget Improve UX | yes | yes | partial | Coach titles (`You were into {topic}`), Learn/Progress labels, Track/Dismiss/Refresh/custom target. Tracking list has no Done. No “I meant X” on the card. |
| U09 | Core loads new Improve after rebuild | yes | yes | yes | `apiVersion: 6` (`packages/worker/src/api.ts`) and `REQUIRED_API_VERSION = 6` (`core.rs`). `core_is_current`; old :3000 stopped via `stop_core_on_port`. Quit also stops port. |
| U10 | Evals for topics vs telemetry | eng-yes | yes | partial | `insight-quality.test.ts`: extract `graph engineering`; Friends/Gmail null; telemetry copy fails; https-only. Missing: two Google queries both ranked; suggestion JSON parse. Synthetic `you@example.com`. |
| U11 | Distinct search queries survive capture | yes | no | no | `artifactKey` = `origin+pathname` (`packages/capture/src/index.ts`). All `google.com/search` share one row; `touchArtifact` overwrites title. `observations` still stores each `windowTitle`/`url`. Ranker does not read observations. |
| U12 | Suggestion URL quality | yes | partial | no | `isHttpsUrl` only (no userinfo, must have a dot). Model can invent `https://en.wikipedia.org/wiki/Graph_engineering`. No HEAD, no host allowlist. |
| U13 | Stop tracking / Done from Improve | yes | no | no | Tracking block lists titles only. Untrack would be loop Done/Dismiss on other filters, not Improve. |
| U14 | Topics from Wikipedia/docs tabs | nice | partial | partial | Parser handles `… - Wikipedia` and non-entertainment YouTube. Docs/GitHub README titles are not extracted unless they look like Search/Wiki/YT. Rank still artifacts-only. |
| U15 | Richer progress | nice | no | no | Progress is boolean-per-week. No search count, no last URL, no “3 searches this week.” |

Prior U01–U10 inventory (2026-08-13) is in the previous worker log. This table replaces it for **this** run.
