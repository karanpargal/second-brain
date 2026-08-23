# Planner

Decomposes a product-analysis run: what to inspect, what “working as intended” means, pass criteria for the Gate.

Does **not** inventory code (that is Worker) and does **not** verdict features (that is Synthesizer).

---

## Log

## Run 2026-08-20 — Cartesia voice + personal brain

**What:** Scoped Ask-your-agent voice loop (Cartesia STT/TTS) grounded on richer local brain context (timeline, resume, profile, multi-turn). Cartesia is I/O only; Ollama stays the brain.

**Why:** User wants talk-back-and-forth on what they have been doing, from the desktop widget.

**Intended behavior:**

1. Push-to-talk mic on widget / Ask page → core proxies Cartesia STT → `askMemory` with brain context → Cartesia TTS → play audio.
2. Text Ask still works without a Cartesia key.
3. Key in encrypted secrets; never in the webview.
4. Answers use today timeline, where-left-off, open loops, profile, session turns, RAG memory.
5. One-click: reopen desktop app; no npm for daily use.

**Pass criteria:** V01–V06 KEEP or FIX-with-next-action; no API key in SPA; mic allowed in WebView2.

**Features:**

| ID | Feature |
|----|---------|
| V01 | Richer `askMemory` brain context |
| V02 | Ask sessions / turns + memory_chunks kind ask |
| V03 | Cartesia STT/TTS proxy + encrypted key |
| V04 | Widget / Ask mic + thread + TTS playback |
| V05 | Settings Voice key surface |
| V06 | Desktop WebView2 microphone allow |

---

## Run 2026-08-18 — Chat apps, zero friction (scope)


**What:** Scoped adding WhatsApp / Telegram / Slack / Discord / Signal / Teams **without any connect UX**. Not a full Worker inventory this pass — Improve U11/U12/U13/U10 shipped in the same session.

**Why:** User asked to add chat with **0 user friction**. Connectors (QR, OAuth, bot tokens, chat export) are friction and were already CUT. Ambient window capture already runs when they open the .exe.

**Intended behavior:**

1. User never taps Connect, never scans a QR, never pastes a token. Opening the desktop app is enough.
2. **OCR of chat bodies stays off** (`tick_ocr` already returns early on `is_chat_surface`). Do not hunt background WhatsApp windows for pixels.
3. **Window titles may be ingested** (`tick_window` already emits `"chat": true` + title like `Farhan - WhatsApp`). Today `ingestSpool` `continue`s all chat — that drop is the only hole.
4. Titles are **Today's work / follow-up**, not Improve topics. `Farhan - WhatsApp` is a person, not “you were into Farhan.”
5. Propose-only: “You were talking to Farhan on WhatsApp” + Dismiss / Not tracking. Never send a message.
6. No hosted LLM of chat titles. On-box peer parse only.
7. Same pattern for Telegram / Slack / Discord / Signal / Teams desktop (and web titles that match).

**Pass criteria (when built):**

1. No new Settings / OAuth / QR surface.
2. Chat OCR remains skipped.
3. Improve still cannot name a contact as a learning topic.
4. User who only opens the .exe sees chat follow-ups iff they actually had that window in the foreground.

**Features to inspect / build later:**

| ID | Feature |
|----|---------|
| C01 | Ingest window-source chat titles (strip OCR text; keep `chat: true`) |
| C02 | KEEP skip chat OCR (already in `tick_ocr`) |
| C03 | CUT connectors / QR / bots (stay deleted) |
| C04 | On-box peer parse: `Name - WhatsApp` / `Name — Telegram` |
| C05 | Propose-only Today card; Dismiss / Not tracking; never send |
| C06 | Chat titles never become Improve learning topics |
| C07 | Local only — no hosted LLM of peer names |

**Out of scope:** WhatsApp Web login, Telegram Bot API, Slack OAuth, reading message history, sending replies, OCR of bubbles.

---

## Run 2026-08-18 — Improve coach re-audit (graph engineering)

**What:** Re-scope Improve after the 2026-08-13 implementer guide landed. The product promise is unchanged: if they searched **graph engineering** last week, the widget names it, offers 1–2 things to try, and lets them Track. This run scores what now works vs what to add.

**Why:** The last run was analysis-only (everything FIX/CUT). Code has since shipped (`extractLearningTopic`, `generateWeeklyInsights` learn/progress cards, Track, apiVersion 6). The user asked to pick over this loop and name the next slice — not to re-litigate RescueTime.

**Intended behavior (working as intended):**

1. Opening the .exe shows Improve as a learning coach, not FOCUS / DEEP_WORK telemetry.
2. Last week’s **distinct** searches become topics (`graph engineering ai - Google Search` → `graph engineering`). Later searches do not erase earlier ones.
3. 1–2 propose-only https articles/videos from **local Ollama**, topic string only. If Ollama is down, say so — no fake URLs, no hosted fallback.
4. Track this / “I want to learn X” persists. Later matching searches show progress. User can stop tracking from Improve.
5. Gmail / Friends / promo never become topics. Account emails never on cards.
6. One-click: Generate / Track / Open / Dismiss on the widget. No npm.

**Pass criteria (Gate):**

1. Every feature below is KEEP / FIX / CUT / MISSING with file evidence.
2. Name what a user who only opens the .exe actually gets today.
3. Capture identity of search queries is classified (collapse `/search` vs observations).
4. Security: no hosted LLM of history; no emails on cards; https-only open.
5. `output.md` is the next-slice guide (working / add next), not a rewrite of north star.

**Features the Worker must cover:**

| ID | Feature |
|----|---------|
| U01 | Extract learning topics from search/browse titles (on-box parser) |
| U02 | Suggest 1–2 articles/videos (local Ollama, skip hosted) |
| U03 | Open a suggestion from the widget (https only, show host) |
| U04 | Track a topic (card button + “I want to learn”) |
| U05 | Tracked-target progress on Improve |
| U06 | No focus / deep-work telemetry cards |
| U07 | Hide/delete stale telemetry already in `insights` |
| U08 | Widget Improve UX (coach copy, Track/Open/Dismiss, human labels) |
| U09 | Core actually serves this Improve after rebuild (apiVersion) |
| U10 | Eval fixtures: extract “graph engineering”; drop Friends/Gmail; no activity-block copy |
| U11 | Distinct search queries survive capture (do not collapse all Google searches onto one artifact) |
| U12 | Suggestion URL quality (no invented 404s) |
| U13 | Stop tracking / Done from Improve |
| U14 | Topics from Wikipedia / docs / learning tabs, not only Google Search chrome |
| U15 | Richer progress (counts / last seen, not only “looked this up again”) |

**Out of scope:** mail-loop quality, toasts, trading, chat, Google/YouTube Search APIs as a product dependency, RescueTime honesty.

**Evidence consulted:** `packages/agents/src/insights.ts`, `insight-quality.ts`, `packages/evals/src/insight-quality.test.ts`, `packages/capture/src/index.ts` `artifactKey` / `touchArtifact`, `apps/web/src/pages/WidgetPage.tsx` Improve, `packages/worker/src/api.ts` insights routes, `apps/desktop/src-tauri/src/core.rs` `REQUIRED_API_VERSION = 6`, prior `output.md` (2026-08-13).

---

## Run 2026-08-13 — Improve = learn from last week's searches

**What:** Rescoped Improve yourself. The user rejected focus-fragmentation (values are wrong) and asked for: if they searched “graph engineering” last week, suggest 1–2 articles/videos; let them **target** a topic and **track** it.

**Why:** North star pillar 4 is upskill from what they actually do. Search queries *are* the signal. The previous run tried to make RescueTime honest; the user does not want that product. Screenshot after rebuild still shows the old FOCUS / DEEP_WORK telemetry cards — that is a delivery bug, not a reason to keep the metric.

**Intended behavior (working as intended):**

1. **No focus-fragmentation / deep-work-minute cards.** Those numbers are not a clock. Do not show them.
2. **Topics from last week’s searches and learning tabs** (e.g. “graph engineering”), not Gmail promo, not YouTube Friends as “work to pin.”
3. **1–2 proposed articles or videos** on that topic. Propose-only. Local Ollama. Widget is the surface; opening a link is optional overflow.
4. **Track this** — user can pin a topic as a learning target. It comes back on Improve until they dismiss or mark done. Progress = later searches/watches/notes on that topic.
5. User can name their own target (“I want to learn X”) if the inferred topic is wrong.
6. One-click: Generate / Track / Dismiss / Done on the widget. No npm.
7. Stale telemetry rows must not appear after a rebuild (core must actually load new worker code).

**Pass criteria (Gate):**

1. Every feature below is KEEP / FIX / CUT / MISSING with evidence.
2. Focus/deep-work telemetry is CUT or FIX-delete, not KEEP.
3. Topic extraction + suggestions + track are classified; missing is allowed if named.
4. Security: no hosted LLM of full history; no emails on cards; search-topic on widget is OK.
5. `output.md` is the implementer guide for this Improve product.

**Features the Worker must cover:**

| ID | Feature |
|----|---------|
| U01 | Extract learning topics from search/browse (query in title, not denylist-as-delete) |
| U02 | Suggest 1–2 articles/videos for the top topic (local Ollama, propose-only) |
| U03 | Open a suggestion from the widget |
| U04 | Track a topic (button + optional custom target) as durable state |
| U05 | Show tracked-target progress on Improve later |
| U06 | CUT focus-fragmentation and deep-work telemetry cards |
| U07 | Hide/delete stale telemetry already in `insights` |
| U08 | Widget Improve UX (topic + suggestions + Track/Dismiss, human labels) |
| U09 | Core actually serves new Improve code after rebuild (stale-core attach) |
| U10 | Eval fixtures: extract “graph engineering”; drop Friends/Gmail; no activity-block copy |

**Out of scope:** mail-loop quality, toasts, trading, chat, a Settings profile wizard, fetching live Google/YouTube APIs as a product dependency.

**Evidence consulted:** user screenshot (still old FOCUS/DEEP_WORK copy + Dismiss); user brief (graph engineering → 1–2 resources + track); `insights.ts`, `insight-quality.ts` (`isNoiseSurface` drops Google Search entirely), `artifactKey` (search key collapses to `/search`, title = last query), `llm.ts` `runLlm`, `createManualLoop`, `WidgetPage` Improve cards, `core.rs` `health_ok` / `REQUIRED_API_VERSION`.

---

## Run 2026-08-13 — Improvement loop (upskill insights)

**What:** Scoped a focused graph run over the **Improve yourself** loop — weekly insight cards on the widget (FOCUS / DEEP_WORK / ARTIFACTS / SKILLS), not the whole product.

**Why:** The user showed the Improve tab. Cards are live but they are not an upskill agent: they dump raw stats, generic advice, and noisy surfaces (Google Search, YouTube, Gmail promo, X). North star pillar 4: *“upskill / improve yourself from what you actually do, not generic advice.”*

**Intended behavior (working as intended):**

1. Insights name **this person’s work** (repos, docs, skills they actually touch), not entertainment / search / promo.
2. Numbers are **internally consistent** (top-app minutes vs block count vs deep-work).
3. Advice is **actionable on this PC** (a real calendar gap, a real skill from browsing/GitHub) — not “consider pinning or scripting.”
4. The widget is the surface: generate / refresh without npm. Cards are readable as an agent, not `deep_work` enum labels.
5. Stale or junk insights can be dismissed; regenerating this week is allowed.
6. Profile (role / goals) actually changes the text when set; empty profile does not fake personalization.

**Pass criteria (Gate):**

1. Every Improve-loop feature is KEEP / FIX / CUT / MISSING with file evidence.
2. Screenshot contradictions (5m “top apps” vs 549 blocks; YouTube/Gmail promo as “recurring surfaces”) are named, not smoothed over.
3. One-click law: Improve never tells the user to open a terminal.
4. Security: insights must not leak extra PII into logs or off-box; they may show local titles the user already generated.
5. `output.md` becomes an implementer guide for making Improve a real upskill loop.

**Features the Worker must cover:**

| ID | Feature |
|----|---------|
| I01 | Weekly insight generator (`generateWeeklyInsights`) |
| I02 | Focus / context-switch metric |
| I03 | Deep-work metric + advice |
| I04 | Recurring-artifacts ranking |
| I05 | Skills card (GitHub vs browsing) |
| I06 | User-profile personalization (role / goals) |
| I07 | Widget Improve tab (cards, empty state, Generate) |
| I08 | Insight actions (dismiss, propose calendar, pause capture) |
| I09 | Weekly lock / refresh (`existing.length >= 3`) |
| I10 | Noise filter on artifacts (search, video, social, promo mail) |
| I11 | 1–2 insights on the default widget voice (not only Improve tab) |
| I12 | Eval / quality gate for insight text |

**Out of scope this run:** mail-loop quality, Windows toasts, capture OCR gates, trading, chat — already covered in the prior full-product run. Do not implement fixes in this graph pass.

**Evidence consulted before planning:** user screenshot of Improve cards; `packages/agents/src/insights.ts`; `packages/agents/src/feedback.ts` `getUserProfile`; `packages/capture/src/index.ts` `artifactKey` / `touchArtifact`; `apps/web/src/pages/WidgetPage.tsx` Improve filter; `packages/worker/src/api.ts` `/api/insights`; `packages/worker/src/scheduler.ts` `jobInsights`; `NORTH-STAR.md` upskill pillar.

---

## Run 2026-08-13 — Personal AI agent for desktop

**What:** Scoped the first graph run over the whole Second Brain app, judged against a personal AI agent the user only opens as a desktop .exe.

**Why:** The user asked for a graph that checks each feature: needed vs moot, built vs stub, working as intended. The north star is not “generic second brain” or a multi-user SaaS — it is a **personal desktop agent**.

**Pass criteria (Gate):**

1. Every user-visible surface is classified KEEP / FIX / CUT / MISSING with evidence.
2. One-click desktop law is either KEEP or FIX (never treated as optional).
3. Security blockers (localhost data leak, secrets, capture of passwords) are named explicitly.
4. Moot verticals (trading-as-default, chat OCR, npm-as-UX, SaaS license if it fights personal use) are CUT or FIX, not silently KEEP.
5. The four pillars — today’s work, reminders, upskill, spam — each have a clear status.
6. `output.md` can be handed to an implementer as the guide for the personal desktop agent.

**Features the Worker must cover:**

| ID | Feature |
|----|---------|
| F01 | One-click Tauri shell (spawn core, health, widget, tray quit) |
| F02 | Ambient capture (window, browser history, OCR) + privacy gates |
| F03 | Capture settings toggles + pause |
| F04 | Open-loop detect from mail / calendar / GitHub / PC (not chat) |
| F05 | Loop ranking buckets (Urgent / Today / To-do / Improve) |
| F06 | Auto-close + snooze / reminders |
| F07 | Widget as primary agent surface |
| F08 | Full dashboard SPA (Now, Timeline, Loops, Ask, Settings, Health) |
| F09 | Ask / search over local memory |
| F10 | Gmail / Calendar / GitHub connectors |
| F11 | Spam + not-tracking feedback |
| F12 | Upskill insights + user profile |
| F13 | Morning brief + daily plan |
| F14 | Digest job |
| F15 | MCP server for Cursor |
| F16 | Eval harness |
| F17 | License / trial |
| F18 | Trading scorer + Trade widget filter |
| F19 | Horizons / goals / projects / legacy tasks |
| F20 | Local LLM (Ollama) + hosted fallback |
| F21 | API auth, CORS, secrets encryption |
| F22 | Backup / purge / retention |

**Out of scope this run:** implementing fixes; re-litigating the chat-connector deletion (already CUT in product law).

**Evidence consulted before planning:** `CLAUDE.md`, `README.md`, `docs/PRODUCT-AUDIT.md` changelog (through 2026-08-13), `packages/agents/src/index.ts`, `packages/worker/src/scheduler.ts`, `packages/worker/src/api.ts` routes, `apps/web` pages, `packages/core/src/db/schema.ts`.
