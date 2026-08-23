# Logic Review

Lens: correctness vs intended behavior. Needed vs moot. Built vs stub. Working vs broken. Does **not** own UX copy or CORS policy (unless it makes the feature logically fail).

For each Planner feature: would the personal desktop agent actually do this job?

---

## Log

## Run 2026-08-20 — Cartesia voice + personal brain

**What:** Logic check that voice Ask answers from local brain, not Cartesia-as-LLM.

**Why:** North star: Ollama is the brain; Cartesia is speech I/O.

**Evidence:** `POST /api/ask/voice` → `cartesiaTranscribe` → `askMemory` (RAG + timeline + loops + profile + turns) → `cartesiaSpeak`. Empty STT rejected. Missing key → 503 with Settings hint. Text path unchanged without key.

**Verdicts:** V01–V06 needed and built as intended. Not a second knowledge-graph UI — learn_nodes remain classifier training, not Ask traversal (correct vs north star).

---

## Run 2026-08-18 — Improve coach re-audit

**What:** Logic re-audit of Planner U01–U15 against the shipped Improve coach. Static inspection of extract/rank → generate → widget → capture identity. Did not implement. Did not KEEP RescueTime / focus telemetry.

**Why:** Intended behavior is unchanged: searched **graph engineering** last week → widget names it, 1–2 local suggestions, Track; later matching searches show progress; FOCUS cards must not return. Worker claims the remaining hole is capture identity. This node checks whether the .exe would actually do that job, especially U11 (graph engineering then weather).

**Would the .exe do this job?** Only on a fragile happy path. Opening the app now shows Learn/Progress coach cards, not FOCUS/DEEP_WORK. Extract + Track + https Open + telemetry delete are real. The graph-engineering promise **fails as soon as another Google search happens**: ranking reads **artifacts last 7d**, not `observations`; all `google.com/search` visits share one URL artifact; last title wins; that last query inherits the week’s `touchCount`. Progress uses `topicMatches` against that same list. Cron `jobInsights` and widget Refresh use `replace: true`; boot catch-up generates only if `listInsights()` is empty.

**Evidence:**
- `packages/capture/src/index.ts` `artifactKey` — URL identity is `origin+pathname` (query stripped). `https://www.google.com/search?q=graph+engineering` and `?q=weather` are one key. `touchArtifact` overwrites `title` and increments `touchCount`. Window ticks without a URL get `contentHash([app, window_title])` — distinct per title, but only if Chrome was foreground on a title change.
- `packages/core/src/db/schema.ts` — `observations.windowTitle` / `url` still store each event (full query string). `artifacts` unique on `(kind, key)`. Ranker never reads observations.
- `packages/agents/src/insights.ts` `generateWeeklyInsights` — `recentArts` from `artifacts` where `lastTouchedAt >= weekAgo`. Lock: skip if current week already has `learn`/`progress` + `isCoachCardText` unless `replace`. Deletes `TELEMETRY_KINDS` always; current-week rows only when `replace`. `rankLearningTopics` → progress via `topicMatches` → learn `slice(0, 2)` + `suggestResources`. `listInsights` only `learn`/`progress`.
- `packages/agents/src/insight-quality.ts` `extractLearningTopic` / `rankLearningTopics` / `topicMatches` — parser maps `graph engineering ai - Google Search` → `graph engineering`. Friends/Gmail → null. Rank sums `touchCount` per extracted topic.
- `packages/agents/src/llm.ts` `runLlm` — `skipHosted: true` for `improve-suggest`; offline stub if not Ollama. `parseSuggestions` keeps ≤2 `isHttpsUrl` items (no HEAD).
- `packages/worker/src/scheduler.ts` — `jobInsights` → `generateWeeklyInsights({ replace: true })`. `catchUpOnBoot` → generate **without** replace iff `listInsights().length === 0`.
- `packages/worker/src/api.ts` — `apiVersion: 6`, GET `/api/insights` lists only (no auto-generate), POST generate `{ replace: true }`, POST track, DELETE dismiss.
- `apps/web/src/pages/WidgetPage.tsx` Improve — Learn/Progress labels, Watch/Read + host, `openExternal` https-only, Track this + “I want to learn”, Dismiss, Refresh. Tracking list is titles only (no Done/untrack).
- `apps/desktop/src-tauri/src/core.rs` — `REQUIRED_API_VERSION = 6`; reuse if healthy **and** `core_is_current`; stale version → `stop_core_if_owned` + `stop_core_on_port`. Quit also clears the port.
- `packages/evals/src/insight-quality.test.ts` — extracts `graph engineering`; Friends/Gmail null; telemetry copy rejected; https-only. One collapsed `/search` fixture. No two-query ranking test. No suggestion JSON parse test.

**U11 scenario (graph engineering, then weather):** Browser-history ingest writes one `url` artifact `https://www.google.com/search`. After weather, `title` is weather, `touchCount` is **all** Google searches that week. `rankLearningTopics` emits **weather** with that inflated count. Graph engineering is gone from the URL row. A window artifact *might* still hold `graph engineering ai - Google Search` at count ≈ title-change ticks, then lose `slice(0, 2)` to weather + any other extractable tab. Tracked “graph engineering” progress also misses unless that leaky window row still exists. Observations still have both queries; unused.

**Worker facts — verified:** Ranker = artifacts 7d, not observations. One `google.com/search` artifact; last title wins; touchCount is the sum. Progress = `topicMatches` on that list. Generate lock skips existing coach cards unless `replace`. Cron uses `replace: true`. Agree.

**Disagreements with Worker:**
1. U11 is the product-break, not a side note under U01. Extract-on-a-title is working; **identity of distinct searches is not**. Do not call U01 “working on the .exe.”
2. Window-title artifacts are a leaky backup, not a fix. Worker’s “one row” is exact for URL-kind; window-kind can keep an old query at low count. That is not “later searches do not erase earlier ones.”
3. U09 is working for the v5→v6 coach cutover. Residual: reuse still keys off `apiVersion` only — a later `insights.ts` edit without bump 7 would stale-attach again. Not the 08-13 screenshot bug.
4. `listInsights` does not filter `weekKey`. `replace` only deletes the **current** ISO week. Last week’s learn cards can still list. Not FOCUS, but Improve is not a single-week surface.
5. Agree U06/U07 working. `focusStats` leftover in `insight-quality.ts` is unused by the generator — moot, not KEEP RescueTime.

**Verdicts:**

- **U01** Topics from search/browse titles — Need yes / Built yes / **broken as a product path**. Parser and unit tests do the job on whatever title they get. Generator ranks collapsed artifacts, so last week’s distinct searches do not become topics. Friends/Gmail drop is correct.

- **U02** 1–2 article/video suggestions — Need yes / Built yes / **partial**. Local Ollama + `skipHosted`; offline copy, no fake URLs. Items only exist if U01 ranked the right topic and the model returned https JSON. Topic string only in the prompt (not full history) — correct.

- **U03** Open suggestion from widget — Need yes / Built yes / **working** given a real https item. `openExternal` returns unless https; host shown. Fails closed if U02 hallucinates or is empty.

- **U04** Track a topic — Need yes / Built yes / **working**. Card Track + “I want to learn” → `Learn: {topic}` loop, tag `upskill`, `topicMatches` de-dupe. Widget duplicate check is exact lowercase (stricter than `topicMatches`) — minor, not a miss.

- **U05** Tracked-target progress — Need yes / Built yes / **broken** when U11 overwrites the search title. Hit path: `ranked.find(topicMatches)` → `progress` card + `lastSeenAt`. Miss path: tracked graph engineering, later weather on the same `/search` artifact → no hit. Body is boolean (“looked this up again”), no count (U15).

- **U06** No focus / deep-work telemetry cards — Need yes (cut that product) / Built yes / **working**. Generator does not insert `focus`/`deep_work`/`artifacts`/`skills`; deletes those kinds. Do **not** KEEP RescueTime because `focusStats` still compiles.

- **U07** Hide/delete stale telemetry in DB — Need yes / Built yes / **working**. Delete pass + `listInsights` kind filter + `isCoachCardText` (rejects `activity blocks` / `notifications paused`). GET cannot return FOCUS rows. Boot generate-if-empty still purges telemetry kinds even without `replace`.

- **U08** Widget Improve UX — Need yes / Built yes / **partial**. Coach titles, Learn/Progress, Track/Open/Dismiss/Refresh/custom target. Tracking list has no Done. Refresh uses `replace: true` (lock does not trap the user). Empty state Generate is one-click.

- **U09** Core loads new Improve after rebuild — Need yes / Built yes / **working** for apiVersion 6. Health `improve-learn`; desktop requires ≥6; mismatch kills port. Reuse of a healthy v6 core is intended. Future insight-only edits still need a version bump.

- **U10** Eval fixtures — Eng-need yes / Built yes / **partial**. Locks extract `graph engineering` and noise-as-not-work (still true for pin-as-work). Would **pass while U11 is broken** — no fixture that two Google queries both survive ranking. No `parseSuggestions` JSON fixture. Synthetic `you@example.com`.

- **U11** Distinct search queries survive capture — Need yes / Built **no** / **broken**. This is the .exe failure for the stated story. Observations keep each query; artifacts + ranker do not. Last Google search of the week is labeled “looked this up a lot” with the **sum** of every `/search` visit. YouTube `/watch` and DuckDuckGo `/` collapse the same way.

- **U12** Suggestion URL quality — Need yes / Built partial / **broken**. `isHttpsUrl` only (no userinfo, hostname must contain `.`). Model can ship `https://en.wikipedia.org/wiki/Graph_engineering`. No HEAD, no host allowlist. Offline path correctly ships zero URLs.

- **U13** Stop tracking / Done from Improve — Need yes / Built **no** / **missing**. Improve Tracking block is titles only. Loop Done/Dismiss live on other widget filters, not on this surface. Planner: user can stop from Improve.

- **U14** Topics from Wikipedia / docs / learning tabs — Nice / Built partial / **partial**. Wiki titles extract; wiki **pathnames differ**, so article tabs do not collapse like Google. Docs/GitHub README titles are not extracted unless they look like Search/Wiki/YT. Rank still artifacts-only.

- **U15** Richer progress — Nice / Built **no** / **missing**. `rankLearningTopics` already has `count`; progress body ignores it. No last URL, no “3 searches this week.”

**Not KEEP:** focus / deep-work / RescueTime honesty. Dead `focusStats` helpers are not a product.

---

## Run 2026-08-13 — Improve = learn from last week's searches

**What:** Logic review of Planner U01–U10 only. Static inspection of search→artifact→insight path, suggestion/track absence, focus/deep_work still inserting, widget Improve, core attach/`apiVersion`, evals. Screenshot after rebuild (FOCUS 549-blocks + DEEP_WORK notifications-paused) is the runtime test. Did not implement. Did not KEEP focus metrics.

**Why:** Intended product is last-week searches → 1–2 article/video suggestions → Track. North star upskill is from what they actually searched, not RescueTime. Previous run’s “honest sessionize” is moot.

**Would the .exe do this job?** No. Opening the desktop app still shows weekly telemetry cards. It would not name “graph engineering,” would not propose resources, would not let the user track a topic, and after a rebuild it can keep serving the *old* generator because health reuse does not notice `insights.ts` changes.

**Evidence:**
- `packages/capture/src/index.ts` `artifactKey` — URL key = `origin+pathname` (query stripped → all Google searches collapse to `/search`); `title` = `obs.window_title` (e.g. `graph engineering ai - Google Search`). `touchArtifact` overwrites title on that hot key, so the last query is stored.
- `packages/agents/src/insight-quality.ts` `isNoiseSurface` / `isWorkArtifact` — `NOISE_RE` matches `google search`; `SEARCH_HOST_RE` matches `google.com/search`. Search titles are **captured then dropped**. No parse of ` - Google Search` / YouTube search into a topic. Denylist-as-delete, not denylist-as-not-a-surface.
- `packages/agents/src/insights.ts` `generateWeeklyInsights` — still `insert("focus"…)` and `insert("deep_work"…)` from `focusStats`. `listInsights` filters via `isSafeInsightText` (rejects `activity blocks` / `notifications paused` / `pinning or scripting`). `jobInsights` calls `{ replace: true }`. Catch-up only if `listInsights().length === 0`. No suggestion rows, no topic kind, no LLM call.
- `packages/agents/src/llm.ts` `runLlm` — local Ollama then hosted then stub. Unused by insights.
- `packages/agents/src/tools.ts` `createManualLoop` — inserts `openLoops` with `category: "other"`. No Improve “Track this.” `user_profiles.goalsJson` exists; Improve does not write it.
- `apps/web/src/pages/WidgetPage.tsx` Improve — maps `insights`; Dismiss + Refresh/Generate; CSS `uppercase` on kind (`Focus` → FOCUS). `openExternal` only on loop `sourceUrl`, not insight cards. No Track, no custom target, no Watch/Read.
- `apps/desktop/src-tauri/src/core.rs` `health_ok` — any `:3000` `200` + `"ok":true`. `REQUIRED_API_VERSION = 5`. `packages/worker/src/api.ts` health `apiVersion: 5` (unchanged when insight logic changes). `ensure_core_running`: if healthy **and** version ≥ 5, **reuse**. Force-kill of the .exe does not run `stop_core_if_owned` → orphan worker; next launch attaches. Post-spawn wait is `health_ok` only, not a content hash of `insights.ts`.
- `packages/worker/src/scheduler.ts` `jobInsights` — Monday cron still regenerates focus/deep_work templates.
- `packages/evals/src/insight-quality.test.ts` — asserts `graph engineering ai - Google Search` is noise / not a work artifact (correct for pin-as-work, **wrong** for this run’s extract-topic job). Asserts telemetry copy must not ship. No fixture that extracts `graph engineering`.

**Search titles captured then dropped:** Yes. Window/history ingest writes the query in `artifacts.title`. `generateWeeklyInsights` then `isWorkArtifact` → false, so the query never becomes an Improve topic. The earlier artifacts card showing “graph engineering ai” was the collapsed `/search` row’s last title before the denylist.

**Why stale cards still show:** Source `listInsights` *would* hide `549 activity blocks` / `notifications paused` **if that worker were serving**. Screenshot of those exact strings means the widget is talking to a process without that filter — almost certainly a leftover `:3000` core with `apiVersion` still 5, reused after rebuild/Force-kill. Hiding old copy is not the same as cutting focus: even a fresh worker would insert new focus/deep_work cards.

**Disagreements with Worker:**
1. U01 “Built: no” undersells capture. The title *is* stored. The logic bug is drop-after-capture, not “search never lands.” Verdict **broken**, not a missing ingest.
2. U03/U04 “partial” are unused primitives (`shell:allow-open`, `createManualLoop`), not a half-built Improve feature → **missing** / **stub**.
3. Agree U06 must not be KEEP because sessionize is “more honest.” User cut that product. Generator still inserts.

**Verdicts:**

- **U01** Extract learning topics from search/browse — Need yes / Built capture yes, extract **no** / **broken**. Would capture `graph engineering ai - Google Search` on a collapsed `/search` key, then throw it away as noise. Would not emit a topic. Friends/Gmail drop is correct; using the same denylist to delete search *queries* is the inverted job.

- **U02** Suggest 1–2 articles/videos — Need yes / Built **no** / **missing**. Templates only. `runLlm` is unused. No `{title, url?, kind}` prompt. Offline stub must not invent URLs. The .exe would never propose a resource on last week’s topic.

- **U03** Open a suggestion from the widget — Need yes / Built **no** / **missing**. `openExternal` + `shell:allow-open` exist for loop links only. Insight rows have no URL. Nothing to open.

- **U04** Track a topic — Need yes / Built **stub** / **broken**. `createManualLoop` and `goalsJson` are generic leftovers. Improve has no Track, no custom “I want to learn X,” no `upskill` category. A manual loop would not come back as a learning target.

- **U05** Tracked-target progress — Need yes / Built **no** / **missing**. No re-score of a saved topic against later searches/watches. Reminders are snooze/calendar, not “you searched this again.”

- **U06** CUT focus / deep-work telemetry — Need yes (cut) / Built the *opposite* / **broken**. `generateWeeklyInsights` still inserts `focus` and `deep_work` from `focusStats`. Screenshot still has both. Do **not** KEEP because dwell math improved. Intended: those cards do not exist.

- **U07** Hide/delete stale telemetry in `insights` — Need yes / Built hide-on-read (`isSafeInsightText` in `listInsights`); delete only via `dismissInsight` or generate `replace` / **broken**. If the new worker served, old 549-blocks / notifications-paused bodies would not list. Screenshot proves they still list → filter not on the process behind the widget (see U09). Hide-on-read also leaves rows in SQLite if generate never runs.

- **U08** Widget Improve UX — Need yes / Built a telemetry list / **broken**. Dismiss + Refresh/Generate work on whatever I01 stored. No topic, no suggestions, no Track/Dismiss-as-not-this-topic, no custom target. Kind CSS `uppercase` makes Focus → FOCUS (Style owns the label; logic owns that kind is still `focus`).

- **U09** Core serves new Improve after rebuild — Need yes / Built version gate that does not track this change / **broken**. `health_ok` + `apiVersion: 5` reuse any healthy core. Insight/filter edits do not bump `REQUIRED_API_VERSION`. Force-kill skips `stop_core_if_owned`; orphan Node keeps old `listInsights`/`generateWeeklyInsights`. This is why the screenshot still shows the old FOCUS/DEEP_WORK copy after rebuild.

- **U10** Eval fixtures — Eng-need yes / Built partial (noise + telemetry-copy rejects) / **broken**. Tests lock in “Search is not a work artifact” and do **not** require extracting `graph engineering`. They would pass while U01 stays inverted. Telemetry-copy rejects are the right gate for U06/U07 copy, not a substitute for a topic-extract fixture.

**Not KEEP:** U06/U02-path focus metrics. Honest RescueTime is out of scope for this product.

## Run 2026-08-13 — Improvement loop (upskill insights)

**What:** Logic review of Planner I01–I12 (Improve / upskill loop only). Static inspection of `generateWeeklyInsights`, capture `artifactKey` / `touchArtifact` / `sessionizeRecent`, profile, buckets, scheduler/API, widget Improve tab. Screenshot of three Improve cards is the working-as-intended test. Did not query live SQLite. Did not implement fixes.

**Why:** North star pillar 4 is upskill from what this person actually does. Cards are live and they fail that job: inconsistent math, generic advice, entertainment ranked over work. Worker inventory is mostly right; two causal stories do not match the code + screenshot.

**Evidence:**
- `packages/agents/src/insights.ts` `generateWeeklyInsights` / `weekKey` / `insert` — template-only; lock `existing.length >= 3`; rolling 7d `weekAgo` vs ISO `weekKey`; `switches` = app-name churn; deep work = per-block `dwellMs >= 25*60_000`; artifacts = `touchCount` desc, no noise filter; skills = GH count or a constant browse string; `getUserProfile()` only for `roleBit`/`goalBit` prefixes; `score` unused in UI
- `apps/desktop/src-tauri/src/capture.rs` `tick_window` / `tick_browser` / `tick_ocr` — dwell only on window **title/exe change**; browser history and OCR always `"dwell_ms": 0`
- `packages/capture/src/index.ts` `artifactKey` — URL key = `origin+pathname` (query stripped, so all Google searches collapse); `touchArtifact` increments every ingest hit; `sessionizeRecent` folds only same app AND (same title OR same url) within 5m; ingest `isSpam` skips whole obs (no insight-time filter)
- `packages/core/src/spam.ts` `HARD_RE` — does not match “Claim Your One-Time Pack”; no YouTube/search host denylist
- `packages/agents/src/feedback.ts` `getUserProfile` — `workHours` default 09:00–18:00 never read by insights
- `packages/agents/src/buckets.ts` `bucketOpenLoops` — loads `calendarBlocks` for today; insights generator never imports calendar
- `packages/core/src/config.ts` `schedule.insights` = `"0 8 * * 1"`
- `packages/worker/src/scheduler.ts` `jobInsights` + `catchUpOnBoot` (`listInsights().length === 0` → generate)
- `packages/worker/src/api.ts` GET `/api/insights` auto-generates if table globally empty; POST `/api/insights/generate` is the same function (lock applies); no DELETE/PATCH/dismiss for insights
- `apps/web/src/pages/WidgetPage.tsx` `filter === "improve"` renders `insights.map`; Generate button only when `insights.length === 0`; default voice = brief or loop titles, never insight bodies
- Screenshot: FOCUS 44 switches / 549 blocks / Cursor 5m / chrome 5m / deep-work ~0; DEEP_WORK under-2h canned line; ARTIFACTS Google Search · YouTube Friends · Gmail promo · X · Notion. No SKILLS card. No `For a …` prefix.

**Disagreements with Worker:**

1. **“549 blocks vs 5m top apps means dwell is wrong *or* the week was ~15 minutes.”** The 15-minute-week reading is not equally likely. Browser + OCR observations are hard-coded `dwell_ms: 0`. Window ticks emit only on title/exe change. `sessionizeRecent` will not glue Cursor file-switches into one block. Top-app minutes are **window-title-stability time**, not time spent. 549 dwell-zero (or title-churn) blocks plus Cursor (5m) is the expected instrumentation output for a real work week, not proof the user only worked 15 minutes.

2. **“Skills never appears because it is the 4th insert and lock is ≥3.”** The lock is checked **once at the start**, not between inserts. A successful empty-week generate with artifacts writes all four (`focus`, `deep_work`, `artifacts`, `skills`) in one call. A completed 3-row week (no artifacts) would show **SKILLS**, not ARTIFACTS. The screenshot is FOCUS / DEEP_WORK / ARTIFACTS — that is insert order 1–3, skills missing. That matches **no transaction + crash/return after the third insert**, then lock stuck, **or** four rows in DB with the fourth below the widget fold. It does **not** match “lock skips card 4 mid-generate.” The lock **is** still a bug: it can freeze a 3-row week forever and it blocks refresh of junk.

**Verdicts:**

- **I01** Weekly insight generator — Need yes / Built yes (not a stub) / **broken**. Would insert 3–4 canned rows on Monday cron, boot catch-up if the table is globally empty, or GET `/api/insights` when empty. Would not produce an upskill agent: no LLM, no calendar, no skill extraction, ISO-week lock vs rolling-7d data. Screenshot proves the pipeline fires and that the output is the templates, not personal coaching.

- **I02** Focus / context-switch metric — Need yes / Built yes / **broken**. `switches` counts app-name changes (44 in the screenshot — that part is internally consistent with “not 549 app hops”). Copy then cites 549 blocks and top-app minutes that cannot be the same quantity: most blocks are title-churn or dwell-0 browser/OCR fragments; deep-work minutes in the same sentence are a third definition (25m contiguous **block**). `Math.min(1, switches/80)` is stored and never shown. The agent would tell the user they are fragmented even when they sat in Cursor all day switching files.

- **I03** Deep-work metric + advice — Need yes / Built yes / **broken**. Deep work cannot survive title changes, so a 90-minute Cursor session of 2-minute file hops scores ~0. Screenshot `~0 minutes` / under-2h branch is that definition, not a calendar fact. Advice is a string literal: “Block 90 minutes tomorrow morning with notifications paused.” Does not read `calendarBlocks`, `workHours`, or `pause_capture`. `buckets.ts` already loaded today’s calendar for loops; insights ignore it.

- **I04** Recurring-artifacts ranking — Need yes / Built yes / **broken**. Rank = `touchCount` last 7d, titles raw. `artifactKey` collapses every Google search onto `origin+pathname` (`google.com/search`) so one row accumulates all queries (screenshot “graph engineering ai” is the **last** title on a hot key). Gmail pathname similarly collapses; `touchArtifact` overwrites title, so a promo subject can wear the visit count of all mail. YouTube pathnames are per-video so a Friends episode outranks unique work docs. Copy “pinning or scripting the top one” is not an action this PC can take. Screenshot is the intended failure mode.

- **I05** Skills card — Need yes / Built partial / **stub** (GitHub branch is a count + canned “merge one today”; browse branch never reads artifacts/history). `items` kind `issue`/`pr` from `packages/connectors/src/github.ts` is real, so “Shipping rhythm” can appear if GH items exist this week — still not a skill. Screenshot has no SKILLS card; see disagreement #2. The agent would not name a repo, language, or topic the user actually touched.

- **I06** Profile personalization — Need yes / Built partial / **broken**. `getUserProfile()` is called (prior full-product logic review that said insights “does not read `userProfiles`” is stale). Only empty-role/empty-goals prefixes; `workHours` unused. Seed profile is `role: null`, `goals: []`. No widget/settings form calls `saveProfile` (`PATCH /api/profile` exists). Screenshot has no prefix → personalization did not run, which is correct for an empty profile, but the user also cannot set one from the .exe UI. Empty profile does not fake a role (good); it also cannot change the templates.

- **I07** Widget Improve tab — Need yes / Built yes / **broken** as an upskill surface, **working** as a list of whatever I01 stored. Filter returns `[]` loops and maps `insights`. GET auto-generate means the empty-state Generate button is almost unreachable after first successful fetch (Worker’s “Generate is the only UI path” overstates it). Kind is CSS `uppercase` of `focus` → FOCUS (Style owns labels). No Done/Spam. User who only opens the .exe **does** see these cards (screenshot).

- **I08** Insight actions — Need yes / Built **stub** (absent) / **broken**. No dismiss/snooze/delete route. “Notifications paused” is not wired to desktop `pause_capture`. No “propose calendar block” against `calendarBlocks`. Stale junk stays until next ISO week, and not even then if lock already has ≥3 rows.

- **I09** Weekly lock / refresh — Need yes / Built yes / **broken**. `>= 3` vs a 4-card generator; POST generate no-ops; Generate UI hidden once any insights exist; `listInsights` is global recency, not `weekKey`. Catch-up/GET only run when the **whole table** is empty, so a prior week’s rows block this week’s auto-gen until Monday cron (which then no-ops if this week already has 3). User cannot regenerate after seeing YouTube-as-upskill.

- **I10** Artifact noise filter — Need yes / Built **no** / **broken** (moot as implemented: there is no insight-time filter to evaluate). Ingest `isSpam` does not treat search/video/social/mail tabs as non-artifacts. Promo Gmail title survived `HARD_RE`. Ranking therefore prefers entertainment and collapsed search/mail over Cursor/repos. Screenshot is ground truth that this job is not done.

- **I11** Insights on default widget voice — Need yes / Built **no** / **broken**. `WidgetPage` `load` sets `voice` from `now.brief.voice` or the first three loop titles or “Connect Gmail…”. Insights are fetched every load and ignored unless `filter === "improve"`. Default filter is `"open"`. The agent does not speak upskill on the primary surface.

- **I12** Insight eval / quality gate — Need eng-yes / Built **no** / **stub**. `packages/evals` fixtures are mail/github/trading/OCR loops. `ocr-005` YouTube is an OCR loop fixture, not “YouTube is not an upskill artifact.” Nothing would fail CI for 549-vs-5m or Friends-as-recurring-surface.

**Would the desktop agent do this job?** It would show three weekly template cards on Improve. It would not upskill the user from real work, would not protect a real calendar gap, would not let them throw away junk, and would not notice that Cursor was the actual job.

## Run 2026-08-13 — Personal AI agent for desktop

**What:** Logic review of Planner F01–F22 vs north-star personal desktop agent. Static code inspection of capture, loops, scheduler, reminders, insights, widget, license, schema leftovers. No .exe run.

**Why:** Worker left six unproven gaps; audit body is stale vs 2026-08-12/13 changelog. Need to mark moot vs broken vs working for Synthesizer.

**Evidence:**
- `apps/desktop/src-tauri/src/capture.rs` `read_toggles` / `CaptureEngine::run` — honors `capture-control.json` `toggles.{window,browser,ocr}` each tick; `is_chat_surface` still OCRs chat (no early return); `wake_core_loops` on `hot = chat || trading`
- `packages/worker/src/api.ts` PATCH settings — mirrors `capture.toggles` into `capture-control.json`
- `packages/agents/src/reminders.ts` `fireDueReminders` — reopens snoozed loops; writes `pending-notifications.json`; **no** tray/OS notify consumer (`apps/desktop` tray = pause/resume/toggle only)
- `packages/agents/src/insights.ts` `generateWeeklyInsights` — real heuristic inserts (focus/deep_work/artifacts/skills); **does not** read `userProfiles`
- `packages/agents/src/brief.ts` `const profile = null` — hardcoded; horizons/goals loaded but job never scheduled
- `packages/worker/src/scheduler.ts` `startScheduler` — `jobExtract` still on `loops` cron; **no** `jobPlan`/`jobBrief`; has `jobReminders`/`jobInsights`/`jobDigest`
- `packages/agents/src/extractor.ts` `extractTasksFromTopItems` — still `db.insert(tasks)`; no `/api/tasks`
- `packages/agents/src/tools.ts` `listTasks` — alias of `listOpenLoops`, not the `tasks` table
- `packages/agents/src/buckets.ts` `bucketOpenLoops` — Improve = `insights` rows, not loops
- `apps/web/src/pages/WidgetPage.tsx` filter `improve` — renders `api.insights()`; empty until weekly cron (`config.schedule.insights` = Mon 08:00); Trade chip still first-class
- `packages/agents/src/loops.ts` `detectOpenLoops` — comment “No L1 bypass”; `FAST_ACCEPT`/`L1_ACCEPT` **gone**; overflow/`asAccepted(c, false)` drops unverified; OCR non-chat still `COMMITMENT_RE` → recall 0.4 → LLM
- `packages/capture/src/index.ts` `ingestSpool` — skips chat **and always skips trading** (opt-in `isTradingInterestEnabled` cannot revive OCR trades)
- `packages/agents/src/categories.ts` `classifyMailLoop` + `isFromMe` SENT — sent mail never `reply`; career → `follow_up`; else `keep: false`
- `packages/agents/src/loop-dedupe.ts` `loopsAreDuplicate` / `collapseItemsByThread` / `sourceThreadKey` — thread + sender+topic + normalized titles (2026-08-13 claim holds in code)
- `packages/agents/src/license.ts` — 14-day trial; **no** `requireAuth`/route gate on `licensed`; no Settings UI
- `packages/core/src/db/seed.ts` — generic `DEFAULT_HORIZONS`/`DEFAULT_GOALS`; `interests.trading=false`

**Per feature:**

- **F01** One-click shell — Need yes / Built yes / Working yes / **KEEP** — `core.rs` spawn + health + widget; matches product law.
- **F02** Ambient capture — Need yes / Built yes / Working partial / **FIX** — window/browser/OCR + blocklists real; changelog “skip chat at capture” is false: Rust still OCRs chat, ingest drops it.
- **F03** Capture toggles + pause — Need yes / Built yes / Working yes / **KEEP** — Settings → API → `capture-control.json` → `read_toggles`; tray pause 60m. (Settings extra unauth `fetch` is redundant, not the live path.)
- **F04** Loop detect — Need yes / Built yes / Working partial / **FIX** — mail/cal/gh + LLM gate; OCR of IDEs/docs still candidates; quality still the product risk.
- **F05** Buckets — Need yes / Built yes / Working partial / **FIX** — Urgent/Today/Todo use `dueAt`/`priority` (`isUrgentLoop`); Improve is insights not loops; Trade filter leftover.
- **F06** Auto-close + snooze — Need yes / Built yes / Working partial / **FIX** — snooze writes reminder and `fireDueReminders` reopens loop; user sees nothing unless widget is open (no OS notify).
- **F07** Widget primary — Need yes / Built yes / Working partial / **FIX** — `/widget` is the shell URL; list + filters, not a speaking agent; Trade chip fights north star.
- **F08** Dashboard SPA — Need overflow / Built yes / Working mixed / **FIX** — allowed overflow; `NowPage` still tells user `npm run dev:worker` (one-click law).
- **F09** Ask / search — Need yes / Built yes / Working likely / **KEEP** — `/ask` + `/api/ask`/`/api/search`; widget has no Ask surface (dashboard only).
- **F10** Gmail/Cal/GitHub — Need yes / Built yes / Working likely / **KEEP** — connectors + incremental sync; propose-only.
- **F11** Spam / not-tracking — Need yes / Built yes / Working partial / **FIX** — widget actions + `user_spam_rules` + `feedback_events`; rules still pattern-literal.
- **F12** Upskill + profile — Need yes / Built partial / Working weak / **FIX** — weekly heuristics are real, not a stub; profile unused in insights/briefs; empty Improve until Monday cron; no widget profile UI.
- **F13** Morning brief + plan — Need yes (agent voice) / Built yes / Working no / **FIX** — `generateMorningBrief`/`generateDailyPlan` exist; **not** in `startScheduler`; CLI-only; not on widget.
- **F14** Digest — Need no (dup of F13/F05) / Built yes / Working no surface / **CUT** — `generateDigest` returns markdown, persists nothing, widget never reads it.
- **F15** MCP — Need no (builder overflow) / Built yes / Working likely / **CUT** — `packages/mcp` stdio tools; not the desktop user path.
- **F16** Eval harness — Need eng-yes / Built yes / Working yes / **KEEP** — `packages/evals` + fixtures; not user-facing; needed to measure F04.
- **F17** License / trial — Need no / Built yes / Working n/a / **CUT** — SaaS leftover; `licenseStatus` never gates the .exe; personal use must not require a key.
- **F18** Trading — Need no / Built yes / Working gated-dead / **CUT** — ingest always drops trading OCR; widget Trade filter still first-class; fights north star.
- **F19** Horizons/goals/projects/tasks — Need no as product / Built schema+orphan writes / Working no / **CUT** — seed generic goals; extractor still fills `tasks` on loops cron; widget uses `open_loops` only.
- **F20** Ollama + hosted fallback — Need local yes / Built yes / Working mixed / **KEEP** — `runLlm` Ollama-first, `tryHostedLlm` optional; product is local.
- **F21** API auth / CORS / secrets — Need yes / Built yes / Working yes / **KEEP** — `requireAuth` except `/api/health`; `corsOriginFor` allowlist; secrets AES-GCM. (Security owns depth.)
- **F22** Backup / purge / retention — Need yes / Built yes / Working background / **KEEP** — scheduled `jobPurge`/`jobBackup`; no widget control needed for personal use.

**Answers to Worker gaps:**

1. **Toggles:** Yes. Rust `read_toggles` gates `tick_window` / `tick_browser` / `tick_ocr`. API writes `toggles` into `capture-control.json` when `capture.toggles` is patched. Audit “unwired” is stale.

2. **Reminders visible without widget:** No OS/tray notification. `fireDueReminders` marks rows fired, unsnoozes loops, writes `pending-notifications.json`. Nothing in `main.rs` reads that file or calls a notify API. User only sees the loop after opening the widget (if they look). Calendar lead reminders same path.

3. **`generateWeeklyInsights` stub? Profile?** Not a stub — counts app switches, deep-work dwell, artifacts, GitHub items and inserts 3–4 `insights` rows/week. **Profile is unused** there. `brief.ts` hardcodes `profile = null`. `userProfiles` is used for trading `interestPacksJson` (`isTradingInterestEnabled`) and `feedback.ts` get/save. Widget has API client, no profile UI. Insights cron is weekly Monday 08:00; boot catch-up does not generate them.

4. **`tasks` on loops cron:** Yes. `startScheduler` `loops` job: `jobTag` → `jobExtract` → `jobLoops`. `extractTasksFromTopItems` still inserts into `tasks`. Dead for the widget (`listTasks` aliases loops). Dual inbox: proposals nobody sees.

5. **Improve yourself:** Real `insights` rows when the weekly job (or `POST /api/insights/generate`) has run; otherwise empty-state copy. Not loop-derived upskill. Generic (“Protect a deep-work window”), not from the user’s profile. Filter returns `[]` loops and maps `insights` instead.

6. **Fast-loop after chat cut:** Fast path still runs (`scheduleFastLoopDetect` 4s after spool/wake). Chat OCR is **not** skipped in Rust; ingest drops chat lines so they should not become loops; wake still fires on chat/trading `hot`. Non-chat OCR (Cursor, browser, docs) still matches `COMMITMENT_RE` and goes to LLM (`recall` 0.4 ≥ `RECALL_THRESHOLD` 0.35). Trading: ingest **unconditionally** `continue`s trading surfaces/TP-SL text, so `interests.trading` cannot create OCR trade loops; `loops.ts` skip is belt-and-suspenders on any obs that leaked through.

**Also verified:**
- LLM gate vs fast accept: **no L1/FAST_ACCEPT bypass**. Budget miss or JSON parse fail → `keep: false`. Fast mode only narrows window (`sinceMinutes: 20`) and candidate cap.
- `jobPlan` / `jobBrief`: **confirmed absent** from `startScheduler`; CLI `brain plan|brief` only.
- Dedupe/categories/sent-mail (2026-08-13): **present** — `collapseItemsByThread`, `loopsAreDuplicate` (thread/item/sender+topic/titleSim), `classifyMailLoop` sent ≠ reply.
- Horizons/goals/projects: schema + seed + brief/planner/extractor/enrich `goalBoost`. **Not** on widget. `projects` table unused in agents HTTP. Moot for the four pillars.
- License for personal use: **not needed**. Unused gate. CUT.

**Moot (CUT):** F14 digest-as-orphan, F15 MCP-as-product, F17 license, F18 trading, F19 horizons/tasks dual-write.
**Highest logic breaks:** F06 no notify, F12/F13 not on the .exe path, F04 OCR-continue noise, F02 chat still OCR’d, F19 `jobExtract` still writing `tasks`.
