# Worker

Executes the Planner’s feature list. Writes the inventory in `features.md`. Does not final-verdict (Synthesizer) and does not deep-review security/logic/style (those nodes).

On a **Gate fail**, revise `features.md` using synthesizer notes, then append a new log section.

---

## Log

## Run 2026-08-18 — Improve coach re-audit

**What:** Re-inventoried U01–U15 against the current tree. Replaced `features.md`. Did not verdict KEEP/FIX/CUT.

**Why:** The 08-13 guide is mostly implemented. Remaining product hole is capture identity (all Google searches share one artifact) plus a few UX extras (untrack, richer progress, URL quality).

**How:** Read `insights.ts` (`generateWeeklyInsights`, `suggestResources`, `trackLearningTopic`, `listInsights`), `insight-quality.ts` (`extractLearningTopic`, `rankLearningTopics`), `insight-quality.test.ts`, `capture/index.ts` `artifactKey`/`touchArtifact`, `WidgetPage.tsx` Improve, `api.ts` `/api/insights*`, `llm.ts` `skipHosted`, `core.rs` apiVersion 6 + `stop_core_on_port`.

**Facts for reviews:**

1. Parser **works in unit tests**: `graph engineering ai - Google Search` → `graph engineering`. Friends/Gmail → null. Generator ranks **artifacts**, not `observations`.
2. `artifactKey` still keys URLs as `origin+pathname` (query stripped). `touchArtifact` overwrites title. All Google searches are one row; last query wears the week’s touchCount. `observations.windowTitle` / `url` still keep each event.
3. Suggestions: `runLlm({ purpose: "improve-suggest", skipHosted: true })`. Offline → honest copy, empty items. URLs must pass `isHttpsUrl`; no HEAD/allowlist. Hallucinated https Wikipedia URLs can ship.
4. Widget: Learn/Progress labels (no FOCUS uppercase), Watch/Read + host, Track this, Dismiss, “I want to learn” placeholder `graph engineering`, Refresh. Tracking list is titles only — no Done/untrack.
5. Progress cards: title `Still on {topic}`, body `You looked this up again this week.` No count. Same ranking source as (2), so progress can miss if the collapsed title is no longer that topic.
6. Telemetry: generator deletes `focus`/`deep_work`/`artifacts`/`skills`. `listInsights` only `learn`/`progress`. Boot generate if empty; cron `jobInsights` uses `replace: true`.
7. apiVersion **6** matches `REQUIRED_API_VERSION`. Stale core on :3000 is killed via `stop_core_on_port` on launch and Quit.
8. Evals cover extract, noise-as-work, telemetry-copy reject, https URL. No fixture that two sequential Google queries both survive ranking. Fixture email is `you@example.com`.

**Hand-off:** Reviews inspect U01–U15. Do not re-open RescueTime as KEEP. Do not treat unit-test extract as “working on the .exe” if U11 collapse still eats the query.

---

## Run 2026-08-13 — Improve topics Worker pass 2

**What:** Corrected U01: capture stores the query; extract is missing. U03/U04 primitives unused → stub/missing for Improve.

**Why:** Logic: do not call ingest “not built.”

---

## Run 2026-08-13 — Improve = learn from last week's searches

**What:** Inventoried U01–U10 against the user’s new Improve product (topics from searches → 1–2 resources → track). Wrote `features.md`. Did not verdict KEEP/FIX/CUT.

**Why:** User screenshot after rebuild is still “Focus fragmentation / 549 activity blocks” and “notifications paused.” They do not want honest RescueTime; they want upskill from last week’s curiosity.

**How:** Read `insights.ts` (still generates focus/deep_work), `insight-quality.ts` (Google Search is noise, not a topic), `artifactKey` (collapsed `/search` + last query title), `llm.ts`, `createManualLoop`, `WidgetPage` Improve, `core.rs` health reuse + apiVersion 5. Compared to screenshot.

**Facts for reviews:**

1. Search query **is captured** (`graph engineering ai - Google Search` was in the earlier artifacts card). Current code **throws it away** as noise instead of parsing a topic.
2. Suggestions and Track **do not exist**. Ollama `runLlm` and manual loops are unused for this.
3. Focus/deep-work templates **still insert**. User asked to remove them.
4. `listInsights` *should* hide `activity blocks` copy; screenshot proves the widget is not talking to that filter — most likely **stale core on :3000** after Force-kill (U09).
5. CSS `uppercase` on kind labels makes even “Focus” render as FOCUS.

**Hand-off:** Reviews inspect U01–U10 only. Do not KEEP focus telemetry because “sessionize is more honest.” User cut that product.

---

## Run 2026-08-13 — Improvement loop Worker pass 2

**What:** Corrected I02, I05, I07 notes after Logic review. Did not re-inventory from scratch.

**Why:** Gate needs an inventory that is not wrong on dwell math or the skills-card lock.

**Corrections:**

1. 549 blocks vs 5m Cursor is **window-title-stability + dwell-0 browser/OCR**, not evidence the week was ~15 minutes.
2. Week lock is checked **once at start**. A generate with artifacts writes all four cards. Missing SKILLS on the screenshot is crash-after-3 or below-fold, not “lock skips insert 4.”
3. GET `/api/insights` auto-generates when the table is empty; Improve Generate is not the only path.

`features.md` updated. Final KEEP/FIX/CUT/MISSING lives in synthesizer + output.

---

## Run 2026-08-13 — Improvement loop (upskill insights)

**What:** Inventoried the Improve / upskill loop against Planner I01–I12. Wrote `features.md` for this run. Did not verdict KEEP/FIX/CUT (Synthesizer).

**Why:** User screenshot of the Improve tab is the intended-behavior test. Cards exist (Need + Built) but contradict the north star (“from what you actually do, not generic advice”).

**How:** Read `insights.ts`, `feedback.ts` profile, `capture/index.ts` `artifactKey`/`touchArtifact`/`foldBlocks`, widget Improve UI, `/api/insights` + generate, scheduler `jobInsights`, schema `insights` / `artifacts` / `user_profiles`. Compared each template line to the screenshot. Did not query the live SQLite in this pass.

**Facts for reviews:**

1. Generator is **template-only**. Profile strings are optional prefixes; screenshot has none → profile empty or unused in practice.
2. Focus metric is **app-name churn**, not task churn. 549 blocks with Cursor/chrome at **5 minutes each** means dwell aggregation or capture window is wrong *or* the week of real work is ~15 minutes and the copy still sounds like a serious weekly review.
3. Deep-work advice is **hardcoded**. “Notifications paused” does not call desktop pause.
4. Artifacts are **touchCount × window title**. Google Search, YouTube, Gmail promo, X beat Cursor/repos because browser tabs get a touch per visit. No entertainment/search/mail filter at insight time (ingest `isSpam` already ran; Gmail window titles still become artifacts).
5. Week lock: **≥3 rows this `weekKey` → generate is a no-op.** User cannot refresh after seeing junk. Empty-state Generate is the only UI path.
6. Skills card is the 4th insert; if a previous generate already stored 3 rows, skills never appears. Screenshot shows exactly the first three templates.
7. No dismiss, no eval fixtures, no insights on the default widget voice.
8. `PATCH /api/profile` has no widget/settings form.

**Hand-off:** `features.md` is the inventory. Security / Logic / Style mark disagreements in their own files. Screenshot path (for Style/Logic): Improve tab, three white cards, violet KIND labels.

---

## Run 2026-08-13 — Personal AI agent for desktop

**What:** Walked the repo against Planner F01–F22. Wrote `features.md` with Need / Built / Working and file evidence.

**Why:** Reviews cannot run in parallel without a shared inventory. PRODUCT-AUDIT.md is useful history but its body is partly superseded by the 2026-08-12/13 changelog (API auth, evals, chat removed, trading opt-in, categories).

**How:** Read schema, scheduler, API routes, widget, dashboard pages, agents package exports, desktop Rust entry, MCP, evals. Did not execute the .exe in this pass (static analysis).

**Notes for reviews:**

- `jobPlan` / `jobBrief` exist in the worker but are **not** registered in `startScheduler()` — CLI-only.
- `NowPage` still tells the user to `npm run dev:worker` when the API is down — violates one-click law on a secondary surface.
- Widget still has a **Trade** source filter; trading ingest is opt-in (`interests.trading=false`).
- Reminders table + cron exist; no OS/tray notification on fire (tray only pause/resume/toggle window).
- Legacy `tasks`, `goals`, `projects`, `horizons` remain in schema; extractor still proposes into tasks.

**Hand-off:** `features.md` is the inventory. Security / Logic / Style should mark disagreements in their own files, not edit `features.md` in this pass.

## Run 2026-08-13 — Worker pass 2 (review corrections)

**What:** Corrected facts the parallel reviews disproved. Did not re-inventory from scratch.

**Why:** Gate needs an inventory that is not wrong on chat capture, pause/toggles, and reminders.

**Corrections:**

1. Chat windows are **not** skipped in Rust. `is_chat_surface` speeds OCR; `capture_any_chat_window_ocr` hunts chat apps. Ingest drops chat lines later — wasteful and a privacy miss.
2. Capture toggles **do** reach Rust via `capture-control.json`. Node `POST /api/capture/pause` **wipes** toggles (all tiers snap back on).
3. `fireDueReminders` writes `pending-notifications.json` only — no tray/OS notify.
4. `generateWeeklyInsights` is real heuristics, not a stub; profile unused; Improve empty until Monday cron.
5. `jobExtract` still inserts orphan `tasks` on the loops cron.
6. No L1/FAST_ACCEPT bypass — LLM gate or drop. Non-chat OCR still becomes `Continue:` candidates.
7. Trading OCR is always dropped at ingest; widget Trade filter is leftover UI.

`features.md` updated to match. Final KEEP/FIX/CUT/MISSING lives in synthesizer + output.
