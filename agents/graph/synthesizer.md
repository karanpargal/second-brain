# Synthesizer

Merges Worker + three reviews into one verdict per feature. Security blockers beat style. North-star “not this product” beats “it works.”

---

## Log

## Run 2026-08-18 — Improve coach re-audit

**What:** Merged Worker pass 1 + Security ([Security](43f2eff2-f774-4b8d-aced-2a235e33b516)) + Logic ([Logic](feefac75-71c7-4186-8218-12bd484a174b)) + Style ([Style](1bfa42d0-418d-4466-9ceb-28bcefe4e825)).

**Why:** User asked to pick over the graph-engineering Improve loop after the 08-13 guide shipped. Score what works vs what to add. Do not re-open RescueTime.

**Conflict rules applied:**

- Security: **no shipping-blocker** on U01–U15. Last run’s hosted-LLM / email-on-card / unsanitized-open / stale-core issues are closed. Inherited F21 (localhost CORS / token-in-HTML) is labeled, not this Gate.
- Logic: U11 is the product break. Parser unit tests ≠ “working on the .exe.” Beats Style “template is the coach line.”
- Style: Improve tab now feels like a coach. Next UX slice is Done/untrack (U13). Does not beat Logic on capture identity.
- U11/U13/U15 primitives already exist (`observations`, loop Done, `rankLearningTopics.count`) → **FIX** (wire), not MISSING a new product.
- U06 stays **KEEP** (successfully cut). Dead `focusStats` helpers are not KEEP RescueTime.
- U14/U15 are nice; still classify so the next-slice guide is honest.

**Verdicts:**

| ID | Verdict | Next action |
|----|---------|-------------|
| U01 | FIX | Parser is done. Rank **distinct** search titles (see U11). Do not KEEP extract-on-collapsed-artifact. |
| U02 | KEEP | Local Ollama, `skipHosted`, topic-only prompt, honest offline. URL invention is U12. |
| U03 | KEEP | Watch/Read, https-only, host shown, click-only. |
| U04 | KEEP | Track this + “I want to learn.” Persists `Learn: {topic}` / `upskill`. |
| U05 | FIX | Progress matching must read the same distinct-query source as U11. Then U15. |
| U06 | KEEP | Telemetry kinds not generated; not listed. RescueTime stays cut. |
| U07 | KEEP | Delete pass + kind filter. GET cannot return FOCUS. |
| U08 | KEEP | Coach copy, human Learn/Progress, Track/Open/Dismiss/Refresh. Remaining verbs are U13. |
| U09 | KEEP | `apiVersion` 6 + kill stale `:3000`. Bump again on the next Improve semantic change. |
| U10 | FIX | Add eval: two Google queries both ranked; `parseSuggestions` rejects non-https. Keep Friends/Gmail/telemetry rejects. |
| U11 | FIX | Rank last-7d `observations.windowTitle`/`url`, or include search `q=` in `artifactKey`. Last Google title must not inherit the week’s touchCount. |
| U12 | FIX | Allowlist well-known hosts and/or fail closed on empty parse. Do not invent Wikipedia slugs. Not a security shipping-blocker. |
| U13 | FIX | Done / untrack on the Improve Tracking list (same loop actions, this tab). |
| U14 | FIX | Optional next: Wikipedia already extracts and does not collapse. Docs/GitHub README titles after U11. |
| U15 | FIX | Optional after U11: use `count` — “3 searches this week.” Keep last URL off the card unless https-gated. |

**Product shape:**

Improve on the widget **is** a learning coach when the topic is right. The .exe still **cannot promise graph engineering** if they searched anything else on Google later that week.

1. Working today: coach UI, Track, Open, no FOCUS, local suggestions, apiVersion 6.
2. Add next: **distinct searches** (U11) so “You were into graph engineering” survives a later query.
3. Then: Done on Tracking (U13), two-query eval (U10), URL allowlist (U12).
4. Later: wiki/docs breadth (U14), richer progress (U15).

---

## Run 2026-08-13 — Improve = learn from last week's searches

**What:** Merged Worker pass 2 + Security ([Security](31d3d1a4-b237-45c0-a75e-922eb9eb4e94)) + Logic ([Logic](1e80ce97-8c6e-42ba-8c1f-57faa1dac01d)) + Style ([Style](38939428-642e-4e53-ba15-6b44ffb7576a)).

**Why:** User cut RescueTime. Improve must be: last week’s searches → 1–2 resources → Track. Screenshot after rebuild still shows FOCUS 549-blocks — delivery (U09) plus generator still inserting telemetry (U06).

**Conflict rules applied:**

- User + north star “upskill from what you do” beat the previous run’s “honest focus metrics.” **U06 is CUT**, not FIX-sessionize.
- Security: do not LLM the artifacts table; local Ollama of the **topic string** only; no hosted fallback for this purpose; `https:` open only. Beats Style “just show 1–2 links.”
- Logic: U01 is **broken extract**, not missing capture.
- U02–U05 exist as unused primitives (`runLlm`, `openExternal`, `createManualLoop`) → **FIX** (wire), not a new product from scratch.

**Verdicts:**

| ID | Verdict | Next action |
|----|---------|-------------|
| U01 | FIX | Parse topic from `… - Google Search` / YouTube search on-box. Keep Gmail/Friends/promo denylist. Do not dump raw SERP titles. |
| U02 | FIX | 1–2 `{title, url, kind}` from local Ollama given **only** the topic. Skip `tryHostedLlm` for this purpose. No fake stub URLs. |
| U03 | FIX | Watch/Read on click. Allow `https:` (and visible host). Never auto-open. |
| U04 | FIX | **Track this** + optional “I want to learn X.” Persist the topic string (manual loop tagged upskill), not a Gmail title. |
| U05 | FIX | Later searches/watches matching the saved topic count as progress on Improve. |
| U06 | CUT | Do not generate or show focus-fragmentation / deep-work-minute cards. |
| U07 | FIX | Delete stale telemetry rows on generate. Keep `isSafeInsightText` hide. Synthetic email in evals. |
| U08 | FIX | Coach copy: “You were into **graph engineering**.” Human labels, no CSS `uppercase` enums. Track / Open / Dismiss. |
| U09 | FIX | Bump `apiVersion` + `REQUIRED_API_VERSION`. On launch, kill/replace core if version is old. Do not Force-kill without stopping `:3000`. |
| U10 | FIX | Fixture: extract `graph engineering` from that Search title. Keep “Friends/Gmail ≠ topic.” Forbid activity-block copy. |

**Product shape:**

Improve is a **learning coach on the widget**:

1. “You were into **graph engineering** last week.”
2. “Try these 1–2 things” (open in browser if they want).
3. “Track this” / “I meant X.”
4. No FOCUS / DEEP_WORK stats.

---

## Run 2026-08-13 — Improvement loop (upskill insights)

**What:** Merged Worker pass 2 + Security ([Security](36b29207-c023-464b-af59-3fac8aa3e621)) + Logic ([Logic](f365d775-2dbe-42da-873c-7f0ba8a05580)) + Style ([Style](18a71558-46fc-4ad9-ad96-cc284db71ee3)).

**Why:** Improve cards are live and they fail the upskill pillar. Three lenses agree the loop is needed and broken; they disagree on *when* to put insights on the always-on voice, and on *why* the numbers look absurd.

**Conflict rules applied:**

- Security shipping-blocker (Gmail email / search queries in `insights.body`) beats Style “put 1–2 insights on the default voice now.” I11 is FIX **after** I10 redaction, not CUT.
- Logic’s dwell story (title-stability + dwell-0 OCR/browser) beats Worker’s “maybe a 15-minute week.”
- Logic’s lock story (start-of-fn, not mid-insert) beats Worker’s “skills skipped as 4th insert.”
- North star “from what you actually do” beats “the templates ran, so KEEP.” Nothing in I01–I12 is KEEP.
- I08/I10/I11/I12 are gaps on an existing generator/widget/evals tree → **FIX** (wire it), not MISSING (that would imply a new product).

**Verdicts:**

| ID | Verdict | Next action |
|----|---------|-------------|
| I01 | FIX | Rewrite `generateWeeklyInsights` as 1–3 work-named lines. No GET side-effect generate. No telemetry nouns (`activity blocks`). |
| I02 | FIX | Sessionize by **app**, ignore dwell-0 browser/OCR as switches. Do not print block count vs 5m as if they were the same clock. |
| I03 | FIX | Deep work = app-session ≥25m (survive file-title hops). Advice must name a real calendar gap from `calendarBlocks` / `workHours`, or drop the sentence. Do not say “notifications paused” unless `pause_capture` is offered. |
| I04 | FIX | Rank **work** artifacts (Cursor/repos/docs). Strip emails from titles. Never dump Search / YouTube / Gmail promo / X as “surfaces to pin.” |
| I05 | FIX | Name a skill from GitHub repos or filtered Cursor/browse topics — not “N PRs” or a generic homework line. |
| I06 | FIX | Thin role/goals on Settings (or infer from activity). Keep empty-profile honest. Use `workHours` for I03. |
| I07 | FIX | Human labels (Focus, Deep work, Skills). Refresh control when cards exist. Same card grammar as loops. |
| I08 | FIX | Dismiss / Not my work deletes or redacts the row. Optional: “block this morning” → calendar propose + pause. |
| I09 | FIX | Lock must not freeze junk. Allow replace-this-week. Generate/refresh visible after first fill. |
| I10 | FIX | Insight-time denylist: search hosts, YouTube, social, Gmail window titles, promo subjects. Redact `\S+@\S+`. **Shipping blocker until this lands.** |
| I11 | FIX | After I10: 1–2 redacted work lines on the default voice. Not before. |
| I12 | FIX | Evals: YouTube/Gmail-promo/search = not an insight; Cursor/repo = keep; 549-vs-5m copy must fail. |

**Product shape (from Style, accepted; Security timing on I11):**

Improve is a **coach on the widget**, not a RescueTime dump:

1. Human kind labels.
2. Sentences that name this PC’s real work.
3. Dismiss junk the same way you Spam a loop.
4. Refresh without npm.
5. Voice speaks 1–2 of those lines only after titles cannot contain an email.

Do not ship: `activity blocks`, raw `chrome`, “pinning or scripting,” window-title dumps, Generate hidden after first fill.

---

## Run 2026-08-13 — Personal AI agent for desktop

**What:** Merged Worker pass 2 + Security ([review](7bc7a7ec-1d73-4344-9d5c-233c89aacda1)) + Logic ([review](2c2fb1bf-c287-429c-928b-bcfec06e54ca)) + Style ([review](da6adcdc-5d50-4440-887c-ddc034b43186)).

**Why:** Three lenses disagreed on F03 (KEEP vs FIX), F09 (KEEP vs FIX), F13 (FIX vs MISSING), F14 (CUT vs FIX), F15 (KEEP vs CUT), F21 (KEEP vs FIX). Need one table the Gate can score.

**Conflict rules applied:**

- Security pause-clobber and default master key beat Logic “working.”
- North star “talks to you on the widget” beats Logic “Ask works on `/ask`.”
- F13 is built but off the product path → **FIX** (wire it), not MISSING (that would imply writing it from scratch).
- Digest vs brief: north star needs one morning voice → keep F13, **CUT** F14.
- MCP: keep as builder overflow (like evals), **CUT** from user UX — verdict **KEEP (eng)**.
- Trading: **CUT** the product; stopping chat/trade OCR is part of **F02 FIX**.

**Verdicts:**

| ID | Verdict | Next action (if FIX/CUT/MISSING) |
|----|---------|----------------------------------|
| F01 | KEEP | — |
| F02 | FIX | Stop chat OCR (and background hunt). Skip incognito in `tick_ocr`. Stop `ocr-debug.log` text. Don’t OCR trading desks. |
| F03 | FIX | Pause must merge `capture-control.json`, not replace it. |
| F04 | FIX | Keep LLM gate. Cut OCR-`Continue:` noise unless the user is clearly committing. Measure with evals. |
| F05 | FIX | Widget: Urgent/Today as “what matters now.” Improve = 1–2 insights. Remove Trade as a peer filter. |
| F06 | FIX | Tray or OS notify when a snooze/calendar reminder fires. |
| F07 | FIX | Widget = agent voice + today’s work + thin Ask + spam actions. Drop Trade, PowerShell, winget as happy path. |
| F08 | FIX | Overflow OK. Replace every user-visible `npm` / `brain loops` with “reopen the Desktop app.” Drop Widget preview from user nav. |
| F09 | FIX | Put a thin Ask on the widget. Hide retrieval scores on overflow Ask. |
| F10 | FIX | Keep connectors. Cut CLI error copy. Add OAuth `state`. |
| F11 | KEEP | Literal spam rules are enough for a personal agent; semantic later. |
| F12 | FIX | Use profile in insights. Don’t send empty Improve to Health. Generate on boot if week is empty. |
| F13 | FIX | Schedule brief/plan with the core. First widget paint = “here’s today.” |
| F14 | CUT | Orphan markdown. F13 covers the voice. |
| F15 | KEEP | Stdio MCP for the builder. Not on the widget. |
| F16 | KEEP | Engineering. Required to know if F04 got better. |
| F17 | CUT | Do not gate the personal .exe. Remove unused client + routes when convenient. |
| F18 | CUT | Remove Trade filter/scorer from the primary surface. Capture skip is F02. |
| F19 | CUT | Stop `jobExtract` writing `tasks`. Leave schema until a migration is cheap. |
| F20 | KEEP | Local Ollama. If hosted env is set, require explicit consent (do not silent-POST mail/OCR). |
| F21 | FIX | Generate per-install `BRAIN_MASTER_KEY` on first launch. Stop embedding the API token in HTML long-term; HttpOnly cookie or Tauri-only. |
| F22 | KEEP | Keep purge/backup. Fold debug-log retention into F02. |

**Product shape (from Style, accepted):**

Widget always: agent voice, today’s work, Ask, 1–2 insights, connect/sync without terminals.  
Dashboard overflow: Timeline, full loops, privacy settings, Health.  
Neither surface: Trade, license, npm, confidence-as-UX, Widget preview.

