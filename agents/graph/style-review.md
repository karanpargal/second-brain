# Style Review

Lens: widget-first UX, one-click law, copy, dead UI, personal (not SaaS) tone. Does **not** re-architect detectors.

Ask: if this is a personal AI on the desktop, does the surface feel like that — or like an admin console / trading terminal / npm demo?

---

## Log

## Run 2026-08-18 — Improve coach re-audit

**What:** Style-only re-audit of U01–U15 after the coach copy shipped. Read north star, one-click law, planner/worker 2026-08-18, `features.md`; inspected WidgetPage Improve (cards, Track, I want to learn, Generate, tracking list, empty state, voice fallback), `insights.ts` titles/bodies/`insightVoice`, `INSIGHT_KIND_LABEL`. Did not implement.

**Why:** Planner asked whether Improve now feels like a personal desktop agent: “You were into graph engineering — try these 1–2 things. Track this if you want.” Last Style run (08-13) said no — RescueTime FOCUS / DEEP_WORK, Dismiss-only. This run scores the new surface, not that old screenshot.

**Evidence:** UI path — finding

- `apps/web/src/pages/WidgetPage.tsx` Improve (`filter === "improve"`) — Cards are coach-shaped: human kind via `insightKindLabel` (`Learn` / `Progress`), title + body, Watch/Read + host, **Track this** (learn only; flips to Tracking), **Dismiss**, Refresh. Form **I want to learn** with placeholder `graph engineering`. Empty: `I'll look at what you searched last week.` + **Generate now**. No npm, no Health deferral. Default `useState("open")` — coach is still a tab, not first paint.
- Kind CSS — Improve kind node is `tracking-wide text-violet-600` **without** `uppercase`. FOCUS / DEEP_WORK as card kinds are gone. Picker group label is still `"Focus"` with `uppercase tracking-[0.08em]` → paints **FOCUS** in the view menu (inbox grouping, not insight enum).
- Tracking list (`trackingLearn`) — titles via `learnTopicLabel` only. No Done, no untrack, no Not tracking. Same widget’s loop cards (other filters) already have Done / Dismiss / Not tracking. Improve’s Tracking block is a dead poster after Track this.
- `packages/agents/src/insights.ts` — Learn: `You were into ${topic}` / `Last week you looked this up a lot. Track it if you want to go deeper.` + optional `I can't pick articles until Ollama is running on this PC.` Progress: `Still on ${topic}` / `You looked this up again this week.` First person, personal, no activity-block dump. Offline sentence does not tell them to `npm`. “Try these 1–2 things” is Watch/Read buttons, not a sentence.
- `insightVoice()` (agents) joins up to 2 learn/progress **titles**. Widget does **not** call it: local fallback filters `learn`/`progress` titles the same way, but **briefVoice wins**. On Open/Today the strip often stays mail/today, not “You were into graph engineering.”
- `insight-quality.ts` `INSIGHT_KIND_LABEL` — `learn` → Learn, `progress` → Progress. Widget duplicates the map; strings match. No FOCUS/DEEP_WORK in this map.
- One-click — Improve Generate / Track / Open / Dismiss / Refresh are widget POSTs. Offline copy: `Core offline — reopen the Desktop app.` No `npm run` in `apps/web`.
- Capture identity (U11) — style copy is ready to say graph engineering; ranking still uses the collapsed Google `/search` artifact. The .exe can speak the coach sentence about the **last** query, not last week’s distinct curiosity.

**Answer to the ask:** **Mostly yes, on the Improve tab, when the topic is right.** The widget now talks like a personal coach — “You were into {topic}”, 1–2 Watch/Read things, Track this, I want to learn `graph engineering` — not a SaaS dashboard and not RescueTime. It is not the full beat yet: they must pick Improve (default is Open); the Tracking list cannot Done/untrack; capture collapse can name the wrong topic; progress is one thin sentence; the voice strip prefers the morning brief over learn titles.

**Verdicts:** (style lens — missing / ok / off-tone)

| ID | Style | Note |
|----|-------|------|
| U01 | ok* | Template `You were into {topic}` is the coach line. *Topic identity can miss (U11) so the .exe may not say graph engineering. |
| U02 | ok | Watch/Read 1–2 on the card. Ollama-down copy is honest and local (`this PC`), no fake URLs, no npm. Empty suggest list when offline is the remaining hole. |
| U03 | ok | Watch/Read + host; https-only `openExternal`. Browser overflow is fine. |
| U04 | ok | Track this + I want to learn + placeholder `graph engineering`. Personal grammar. No on-card “I meant X”; the form below covers it. |
| U05 | ok | `Still on {topic}` is personal, not telemetry. Body is thin (see U15). |
| U06 | ok | No FOCUS/DEEP_WORK insight kinds or uppercase on cards. Human Learn/Progress. |
| U07 | ok | Stale telemetry cannot list through `listInsights`. Surface is coach cards or empty coach copy. |
| U08 | ok | Widget-first, npm-free, coach hint (`Learn from last week's searches`), empty state first-person. Gaps: still a tab; Tracking list has no verbs (U13). |
| U09 | ok | apiVersion 6 + kill stale :3000. Opening the .exe is the path; style does not send anyone to npm. |
| U10 | ok | Eng-only. Fixture names `graph engineering`; telemetry-copy reject matches what the widget must never show. |
| U11 | off-tone | Coach sentence can attach to the last Google title, not last week’s distinct searches. Feels personal but can be wrong. |
| U12 | off-tone | Showing a Watch/Read host for an invented Wikipedia URL is a coach that points at a wall. Host label is good; 404s are not. |
| U13 | missing | Tracking list is titles only. Done/untrack live on other filters, not Improve. Dead UI after Track this. |
| U14 | missing | Docs/README tabs rarely become “You were into …”. Empty state is good; the coach still mostly means Google Search chrome. |
| U15 | missing | Progress is boolean: “looked this up again.” No count / last seen. Tone is fine; the beat is incomplete. |

**Next UX slice (style):** Put **Done** and **untrack** on the Improve Tracking list (U13) — same button grammar as loop cards, on this tab. Until then Track this dumps a list the user cannot finish. After that: stop CSS-uppercasing the picker group “Focus”; let Improve (or the voice strip) say the learn title even when a brief exists; do not ship npm as the user path.

Do not keep as first-class copy: FOCUS-as-menu-header (uppercase), a Tracking list with no verbs, Health/npm empty states (already gone). Keep: `You were into`, Track this, I want to learn / `graph engineering`, `I'll look at what you searched last week.`, Ollama-offline on this PC.

---

## Run 2026-08-13 — Improve = learn from last week's searches

**What:** Style-only pass over U01–U10. Read north star, planner, worker, features, one-click law; inspected WidgetPage Improve cards, `insightKindLabel` + CSS `uppercase`, insight copy, `listInsights` filter, `REQUIRED_API_VERSION`, evals. Did not implement.

**Why:** User wants Improve to feel like a coach: “You were into graph engineering — try these 1–2 things. Track this if you want.” Screenshot after rebuild is still FOCUS / DEEP_WORK telemetry + Dismiss. Ask: does Improve feel like a personal desktop agent helping them get better?

**Evidence:** UI path — finding

- `apps/web/src/pages/WidgetPage.tsx` Improve (`filter === "improve"`) — Default view is still `"open"` (loop inbox). Improve is a tab you pick, not the agent volunteering a learning beat. Hint copy is coach-shaped (`Get better at what you do`) — the cards under it are not.
- Improve `<article>` — Title + grey body + **Dismiss only**. No Track, no Watch/Read, no “I want to learn X.” Loop cards in the same file have Done / Snooze / Dismiss / Spam / Not tracking. Improve’s only verb is reject-the-card, not take-the-lesson.
- Kind label — `insightKindLabel` maps `focus` → `Focus`, `deep_work` → `Deep work`. Then the same node has `uppercase tracking-wide text-violet-600`, so **Focus → FOCUS**. Screenshot **FOCUS / DEEP_WORK** (underscore) is the raw enum painted through CSS, which means the widget the user sees is still the old article (or a core that never got `insightKindLabel`). Either way the surface reads as telemetry kinds, not a person talking.
- `packages/agents/src/insights.ts` `generateWeeklyInsights` — Still inserts **focus + deep_work** cards (`Split attention this week`, `Protect a deep-work window`, `~Nm`, `No 25-minute stretch in one app`). That is RescueTime with nicer sentences. No topic. No 1–2 articles/videos. Skills/artifacts never parse `graph engineering ai - Google Search` because `isNoiseSurface` / `isWorkArtifact` drop Google Search entirely (`insight-quality.ts`).
- Capture already has the coach signal — `artifactKey` keeps window title `graph engineering ai - Google Search`. Improve throws the curiosity away and shows app-switch minutes instead.
- Empty / refresh — `Insights come from a week of real work on this PC.` + Generate / Refresh. One-click, no npm (good). Empty copy is still pipeline-wait, not “I’ll look at what you searched last week.” Refresh cannot invent Track + suggestions that do not exist.
- Voice strip — insight titles can fill voice if there is no brief, but those titles are still `Protect a deep-work window` / `Split attention this week`. Never “You were into graph engineering.”
- `listInsights` filters `activity blocks` / `notifications paused` via `isSafeInsightText`. Screenshot **still shows that body copy** → the widget is not talking to this list (U09 stale core), so the user still sees the ops dump.
- Desktop `core.rs` — `health_ok` reuses any `:3000` core; `REQUIRED_API_VERSION = 5` matches worker `apiVersion: 5` and does not bump when insight copy changes. Force-kill skips `stop_core_if_owned` → orphan worker keeps old cards. One-click law: opening the .exe should show the new product; it shows last week’s RescueTime.
- No Track field, no suggestion URLs, no `createManualLoop` / goals wired on Improve. `shell:allow-open` exists with nothing to open.
- Evals (`insight-quality.test.ts`) — assert Search **is noise** (fights the new coach) and forbid activity-block copy (good, not on the widget). No fixture that the surface says “graph engineering.”

**Answer to the ask:** No. Improve does **not** feel like a personal desktop agent helping them get better. It still feels like RescueTime: violet FOCUS / DEEP_WORK cards, telemetry bodies, Dismiss. The coach line (“you searched graph engineering — try these — track if you want”) is not on the widget at all.

**Verdicts:** (style lens — coach / ops dump / dead / missing; not KEEP/FIX/CUT)

| ID | Style verdict | Note |
|----|---------------|------|
| U01 | missing | Search titles are captured and then deleted as noise. No “You were into graph engineering.” Coach signal exists in the window title; Improve never speaks it. |
| U02 | missing | No 1–2 article/video suggestions. Generate still emits focus/deep-work templates. A coach would offer things to try; this tab offers stats. |
| U03 | missing | Nothing to open. Dismiss is the only Improve button. Opening a link is optional overflow — there is no link. |
| U04 | missing | No “Track this.” No custom “I want to learn X.” Loop “Not tracking” is the opposite grammar and lives on a different card type. |
| U05 | missing | No later “you searched this again” / progress on a pinned topic. Improve never comes back as a coach. |
| U06 | ops dump | Focus + deep-work cards **are** the Improve UX. Screenshot FOCUS / DEEP_WORK. User asked to cut RescueTime; the widget still is RescueTime. |
| U07 | ops dump | Stale `activity blocks` / paused-notifications copy still on screen. Filter exists in new code; the user does not see it. Style result: leftover telemetry dump. |
| U08 | ops dump (shell only) | Widget-first, npm-free, hint is coach-shaped. Cards are telemetry + Dismiss. CSS `uppercase` turns human labels into FOCUS. No Track, no resources, no target field. Grammar is a report you can throw away, not a coach. |
| U09 | dead (new product never arrives) | Double-click still paints the old ops dump. Stale-core attach + unbounced `apiVersion` means rebuild is invisible. One-click law fails as *copy*: the .exe lies about what Improve is. |
| U10 | missing (eng) | Tests treat Search as junk and do not require “graph engineering” on the card. Telemetry-copy reject never reached the screenshot. Not a user surface. |

**Widget vs coach (this run only):**

Stay on the widget, as a **person talking**:

1. “You were into **graph engineering** last week.” Human topic, not FOCUS / DEEP_WORK / `uppercase` enums.
2. “Try these 1–2 things” — titles the user can open if they want (overflow browser is OK).
3. “Track this if you want” / “I meant X” — same button grammar as loop cards, not Dismiss-only.
4. Generate / Refresh still one-click, no npm — keep that; change **what** they paint.
5. After rebuild, the .exe must actually show this copy (stale FOCUS cards are a style failure, not a reason to keep telemetry).

Do not keep as first-class copy: FOCUS / DEEP_WORK, activity-block counts, “protect a deep-work window,” Dismiss-as-the-only-verb, empty-state “wait a week of capture.”

---

## Run 2026-08-13 — Improvement loop (upskill insights)

**What:** Style-only pass over I01–I12 (Improve yourself / weekly insight cards). Read north star, planner, worker, features, one-click law; inspected widget Improve filter, insight articles, empty state, voice card, `Insight` type, and overflow dashboard pages. Did not re-architect detectors or implement fixes.

**Why:** User screenshot is three white cards with violet all-caps KIND labels (FOCUS / DEEP_WORK / ARTIFACTS), bold titles, grey telemetry bodies. Ask: if this is a personal AI on the desktop, does Improve feel like a coach — or like an analytics dashboard / admin dump?

**Evidence:** UI path — finding

- `apps/web/src/pages/WidgetPage.tsx` Improve filter (`filter === "improve"`) — Default view is `"open"` (loop inbox). Insights load on every poll (`api.insights()`) but **only render when the user picks “Improve yourself.”** Improve is a hidden analytics tab, not the agent talking.
- `WidgetPage.tsx` insight `<article>` — Kind is raw `ins.kind` with `uppercase tracking-wide text-violet-600`. Schema `focus` / `deep_work` / `artifacts` paints as **FOCUS / DEEP_WORK / ARTIFACTS**. Screenshot matches. Loop chips elsewhere use human labels (`Follow up`, `Career`); Improve dumps the enum.
- `WidgetPage.tsx` insight body — Title + grey `ins.body` only. **No Done / Snooze / Dismiss / Spam / Not tracking.** Loop cards immediately below in the same file have the full action row. Improve cards are read-only posters. User cannot reject YouTube Friends or a Gmail promo as “not my work.”
- `packages/agents/src/insights.ts` copy — Telemetry dump + generic coach, not this person’s work:
  - Focus: `You switched contexts about ${switches} times across ${blocks.length} activity blocks. Top apps: … Deep-work stretches (≥25m): ~N minutes.` Internal noun **activity blocks**; app names as captured (`chrome` not Chrome). Screenshot’s Cursor/chrome **5m** vs 549 blocks reads as a broken weekly review, not a coach.
  - Deep work: hardcoded `Block 90 minutes tomorrow morning with notifications paused.` Does not name a calendar gap, does not pause capture, does not offer a button. Sounds like a productivity blog.
  - Artifacts: `Most-touched: ${titles}. Consider pinning or scripting the top one.` Screenshot titles: Google Search, YouTube Friends, Gmail “Claim Your One-Time Pack”, X. **Entertainment / promo listed as work surfaces.** “Pinning or scripting” is admin/power-user, not a personal agent.
  - Skills (often missing on screen because week lock fills at 3): `Pick one skill from recent browser topics…` — no topics named. Generic homework.
- `WidgetPage.tsx` empty state — `Insights appear after a week of capture.` + **Generate now**. One-click: `api.generateInsights()` POST, no npm, no Health page (prior run’s “open Health” copy is gone). Empty copy is still pipeline-wait, not “I’ll look at how you worked.” Generate **vanishes once any insights exist**; with `existing.length >= 3` the API no-ops, so junk cards have no refresh control on the widget.
- `apps/web` — **No `npm` strings** on Improve (or anywhere in the web app now). One-click law is intact for this surface. Generate is the right pattern; it is just gated to the empty state.
- `WidgetPage.tsx` voice card — Black strip above every view. Built from `now.brief.voice` **or** first three **loop titles** joined with ` · `, **or** “Connect Gmail…”. Insights are never interpolated. On Improve you still hear today’s mail/tasks while the white cards dump stats. Default Open/Today voice never mentions upskill. I11 is a **missing agent beat**, not a hidden overflow.
- `WidgetPage.tsx` view hint — Improve yourself → `Work-style insights`. Product-analytics framing, not “get better at what you actually do.”
- `apps/web/src/lib/api.ts` `Insight` — `{ id, kind, title, body, score, createdAt }`. UI shows kind/title/body; **score is unused** (good — no `%` telemetry). `api.buckets().improve` exists and is **never called**. `profile` / `saveProfile` exist and **no page calls them**.
- Overflow dashboard — `NowPage` / `LoopsPage` / `TimelinePage` / `SettingsPage` / `HealthPage` / `AskPage`: **zero insight cards.** Upskill lives only behind the widget filter. Settings has capture toggles, not role/goals. Profile personalization is dead UX.
- Screenshot vs north star pillar 4 — Cards are live (not a stub UI) but they feel like a **RescueTime dump + canned coach**, not a personal desktop agent naming this person’s repos, docs, and skills.

**Answer to the ask:** Improve does **not** feel like a coach. It feels like an analytics dashboard / admin dump parked on a filter tab: raw KIND enums, activity-block counts, unfiltered window titles (Gmail promo, YouTube), advice with no buttons, and the agent voice still talking about loops.

**Verdicts:** (style lens — agent / ops dump / dead / missing; not KEEP/FIX/CUT)

| ID | Style verdict | Note |
|----|---------------|------|
| I01 | ops dump | Four canned templates. Copy is stats + blog advice (`activity blocks`, `pinning or scripting`). Generator is real; the *voice* is a weekly report, not an agent. |
| I02 | ops dump | Focus card is a context-switch counter. “44 times across 549 blocks / Cursor (5m)” is telemetry the user cannot act on. Reads as a broken admin metric, not “you were in Cursor on X.” |
| I03 | ops dump (generic coach) | Title “Protect a deep-work window” is coach-shaped; body is a constant that never names tomorrow’s calendar or wires pause. “Notifications paused” is fiction on the card. |
| I04 | ops dump | “Recurring surfaces” + raw window titles. Gmail promo and YouTube Friends as work to pin is the opposite of personal upskill. Tone is ops ranking, not “this is what you actually build.” |
| I05 | missing (on the screenshot) / generic | Skills card often never appears (week lock at 3). Fallback copy names no browser topic. Would still feel generic if it showed. |
| I06 | dead | Role/goals prefixes exist in templates; screenshot has none. No widget or Settings form writes profile. Personalization is an unused API, not a surface. |
| I07 | ops dump (partial agent shell) | Filter + white cards + Generate-on-empty is widget-first and **npm-free**. Layout matches the screenshot (violet KIND, bold title, grey body). Feels like a report tab, not a coach. Empty copy waits on capture instead of speaking. |
| I08 | dead | Insight articles have no actions. Loop cards in the same widget have Done / Snooze / Dismiss / Spam / Not tracking. Advice cannot be taken or rejected. |
| I09 | dead (after first fill) | Generate is one-click when empty — correct. After three cards the button is gone and regenerate is a no-op. User is stuck looking at junk with no “try again.” |
| I10 | ops dump (wrong objects) | Style symptom of missing noise filter: promo mail and YouTube presented as craft. A coach would not congratulate you for a Gmail pack claim. |
| I11 | missing | Default widget voice never uses insight titles. Insights stay off-stage until Improve is chosen. North star “talks to you on the widget” is unmet for upskill. |
| I12 | missing (eng) | Not a user surface. The screenshot quality failure (telemetry + generic coach + noisy titles) is exactly what a copy/quality gate would reject; none exists. |

**Widget vs coach (this run only):**

Stay on the widget, as a **person talking**:

1. Human kind labels (Focus, Deep work, Skills) — never `DEEP_WORK`.
2. One or two sentences that name **this PC’s real work**, not block counts.
3. 1–2 of those lines on the **default voice**, not only the Improve tab.
4. Actions a person can take or reject (dismiss junk, “not my work,” maybe “block this morning”) — same grammar as loop cards.
5. Generate / refresh as a one-click control **after** cards exist, still with no npm.

Do not keep as first-class copy: `activity blocks`, raw `chrome`, “consider pinning or scripting,” window-title dumps of Search / YouTube / promo Gmail, empty-state “wait a week.”

---

## Run 2026-08-13 — Personal AI agent for desktop


**What:** Inspected widget-first UX, overflow dashboard copy, tray/menu, and user-facing `npm` / CLI strings against the north star (personal AI agent on the desktop: tray + floating widget, one-click, no Chrome as primary UX).

**Why:** The Worker already flagged the widget as a task list, a Trade filter, NowPage `npm` copy, unused onboarding, and license as SaaS leftover. Style’s job is whether the *surfaces* feel like a personal agent or like an admin console / trading terminal / npm demo.

**Evidence:** UI path — finding

- `apps/web/src/pages/WidgetPage.tsx` — Primary surface is a **loop task-manager**, not a conversational agent. Header is brand + counts (`second brain`, `{n} open · {n} today · {n} resolved · updated …`), then a view picker (Urgent / Today / To-do / Improve yourself / Open / Resolved + Sources). Cards are title + Done / Snooze / Dismiss / Spam / Not tracking. Footer: `Drag header · Spam = noise · Not tracking = stop this topic`. No greeting, no “what to ignore,” no Ask box, no morning brief. Mini orb is the letters **SB**.
- `WidgetPage.tsx` `viewGroups` Sources — **Trade is first-class** (`id: "trade"`, badge `TR`, amber chip, regex for TP/SL / Binance / Bybit / Hyperliquid / TradingView). Gmail / GitHub / PC / Manual sit beside it. A personal agent does not lead with a trading desk filter.
- `WidgetPage.tsx` `filter === "improve"` — Improve yourself **does not list loops** (`return []`); it renders `api.insights()` cards. Empty copy: `Insights appear after capture accumulates. Open Health and wait for the weekly job, or sync.` That sends the user to an **ops Health page**, not to a coach.
- `WidgetPage.tsx` — **Ask is absent.** Connect Google / GitHub / Sync live in `···` and the empty state. Conversational Ask exists only on `/ask` (overflow). North star #5 (“Talks to you on the widget”) is unmet.
- `WidgetPage.tsx` empty state — Connect Gmail/Calendar + GitHub + Sync is the right personal onboarding. Then it leaks **dev CLI**: `Run these in PowerShell:` + copyable `winget` / `gh auth login` when GitHub CLI is missing. Also `Install GitHub CLI (winget)`.
- `WidgetPage.tsx` error — `Core offline — reopen the Desktop app.` **Correct** one-click copy (unlike the dashboard).
- `apps/web/src/App.tsx` — Overflow SPA is a dark sidebar ops console: brand `Second Brain`, subtitle **`local ambient memory`**, nav Now / Timeline / Loops / Ask / Settings / Health, plus **Widget preview** (dev chrome on a user dashboard) and `Command Ctrl K`. IBM Plex Mono + `bg-ink-950` (`index.html` / `index.css`) reads as a **trading terminal / admin panel**, not the light floating widget.
- `apps/web/src/pages/NowPage.tsx` — Offline: `API unreachable. Start the worker: npm run dev:worker`. Empty loops: `run brain loops`. Confidence shown as `%` next to `kind` badges (`promise`, `awaiting_reply`). This is the **npm demo / engineer dashboard**, not a personal agent. Directly violates one-click law on a user-visible surface.
- `apps/web/src/pages/AskPage.tsx` — Real conversational surface (`Chat over local memory via Ollama.`, suggestions like “What should I focus on right now?”). Lives **only** on overflow `/ask`. Sources pane shows `score 0.123` — retrieval-debug, not something a person needs.
- `apps/web/src/pages/LoopsPage.tsx` — Duplicate task list with evidence trail, status chips (`open`/`closed`/`snoozed`), `Close` (widget says `Done`), confidence `%`, `kind · origin`. Overflow-OK as a debug inbox; too ops-y to be primary.
- `apps/web/src/pages/TimelinePage.tsx` — Activity blocks + `obs` counts + Evidence. Overflow for “where I was”; copy is capture-debug (`No observation rows matched.`).
- `apps/web/src/pages/SettingsPage.tsx` — Capture tiers + blocklist + pause only. **Dead relative to product:** no profile/onboarding, no trading opt-in, no license (good), no Ollama, no connectors (those are on the widget menu). Dual PATCH of `capture.toggles` (api helper then raw `fetch`) is engineer residue, not user harm.
- `apps/web/src/pages/HealthPage.tsx` — Spool bytes, job ids, source `lastError`, Ollama model list. Correct as **overflow diagnostics**; wrong as something Improve-yourself empty state points at.
- `apps/web/src/components/CommandPalette.tsx` — `Jump to…` page router (`Go to Now`, `Ask memory`). Dashboard-only (`App.tsx` skips Ctrl+K on `/widget`). Not an agent command bar.
- `apps/web/src/lib/api.ts` — `licenseStatus` / `activateLicense` and `profile` / `saveProfile` / `onboardingDone` are **wired in the client and unused by any page**. `api.buckets()` is unused; widget re-filters loops locally (including Trade).
- `apps/desktop/src-tauri/src/main.rs` — Tray: `Show widget`, `Pause capture 1h`, `Resume capture`, `Quit`; tooltip `Second Brain widget`; left-click toggles widget; Ctrl+Shift+Space. Loading: `Starting Second Brain...`. Failure: `Second Brain's local engine did not start in time.` + Retry. **No npm in the shell UI.** No tray line for due reminders / brief (Logic/Worker already noted).
- `apps/desktop/src-tauri/src/core.rs` — Dev-path error `tsx not installed — run npm install in the repo` (log, not the Retry HTML). Packaged users should never see it; if they do, the Retry page still hides npm.
- `packages/worker/src/api.ts` — Static 404: `UI not built. Run: npm run build` (can hit a user if they open overflow before a packaged UI exists).
- `packages/connectors/src/google-auth.ts` — Thrown copy `Google not connected. Run: npm run brain -- auth google` can surface through widget `connectMsg` / sync errors. Widget’s own Connect Google path is browser OAuth; this string is leftover CLI product.
- `packages/agents/src/license.ts` — 14-day trial + HMAC seat keys. **No Settings/widget UI.** Client methods exist; nothing calls them. SaaS leftover, not a visible paywall today.
- Onboarding — `user_profiles.onboarding_done` + `getUserProfile` / Settings API; **no wizard, no widget gate, no Settings form.** Dead UX.
- `apps/desktop/index.html` — Dark iframe shell titled Second Brain, `Open UI` → `http://127.0.0.1:5173`. Dev wrapper, not the Tauri product path.

**Verdicts:**

| ID | Style verdict | Note |
|----|---------------|------|
| F01 | KEEP | Tray + loading/error HTML already speak one-click. Do not put npm on those strings. |
| F03 | KEEP (overflow) | Capture toggles + pause belong in Settings / tray, not the widget chrome. |
| F05 | FIX | Buckets on the widget are a filter menu, not “what matters now.” Trade as a Focus/Sources peer fights the product. |
| F07 | FIX | Widget is a competent **inbox of loops**, not a personal agent. Missing talk (Ask), brief, and “ignore this.” Trade filter and PowerShell/winget copy pull it toward a trading/dev demo. Offline copy is already right. |
| F08 | FIX | Overflow dashboard is allowed, but it currently **teaches npm** (`NowPage`), looks like an ops console (`local ambient memory`, Health jobs, Widget preview), and duplicates the widget’s task list without adding agent voice. |
| F09 | FIX | Ask is real and well-toned — **only on `/ask`**. Personal agent needs a thin Ask (or “what should I do”) on the **widget**. Dashboard Ask can keep sources; hide retrieval `score`. |
| F10 | FIX (copy) | Connect-from-widget is the right place. Cut PowerShell/winget as the happy path; cut Google `npm run brain -- auth google` from user-visible errors. |
| F11 | KEEP | Spam / Not tracking on the widget matches the spam pillar and reads personal, not SaaS. |
| F12 | FIX | Improve yourself is a filter that shows insight cards or an empty state that **defers to Health**. No profile/onboarding UI. Feels stubby, not a coach. |
| F13 | MISSING | Morning brief / daily plan are not on the widget (or dashboard). A personal agent’s first paint should be “here’s today,” not a filter dropdown defaulting to Today-as-task-list. |
| F14 | FIX (surface) | Digest may run in the background; nothing on the widget says “your daily note is ready.” |
| F15 | CUT (user UX) | MCP is builder overflow; do not put it on the widget. |
| F16 | KEEP (eng) | Not user-facing. |
| F17 | CUT | License/trial API + unused `api.license*` is SaaS tone on a personal app. No UI today — do not add one; remove the product surface. |
| F18 | CUT | Trade filter + TR badges are first-class on the **primary** surface. Opt-in ingest is not enough if the widget still looks like a trading terminal. |
| F19 | CUT (UX) | Horizons/goals/projects have no widget/settings story; don’t resurrect as onboarding forms unless they serve the four pillars. |
| F20 | KEEP (local) / FIX (tone) | Ollama belongs. Health listing model names is overflow. Widget should say the assistant is local, not expose spool MB. |

**Widget vs dashboard:** what the personal agent should show

**Stay on the widget (always visible):**

1. A short **agent voice** — what matters now, what to ignore, where you left off (not just `{n} open`).
2. **Today’s work** as a short list (Urgent / Today), with Done / Snooze / Spam / Not tracking.
3. A way to **Ask** (“what should I focus on?”) without opening `/ask` in a browser.
4. **Improve yourself** as 1–2 human insights, not “open Health for the weekly job.”
5. Connect + Sync only when empty or disconnected — browser login, **no npm / PowerShell**.
6. Mini / pin / hide to tray / quit — already good.

**Overflow dashboard only (`Full dashboard`):**

- Timeline (where was I)
- Full loop inbox + evidence
- Settings: capture privacy, pause, blocklist
- Health: Ollama / jobs / spool (diagnostics)
- Ask with sources (optional deep dive)

**Do not keep visible on either surface as first-class:** Trade filter, license/trial, Widget preview, `npm run` / `brain loops`, confidence scores, GitHub winget as the default connect story, unused onboarding forms.

**Tone:** Widget is already closer (light card, personal verbs). Dashboard is the other product (dark mono ops). Overflow can stay denser, but **Now must not tell anyone to start the worker with npm** — same line as the widget: reopen the Desktop app.
