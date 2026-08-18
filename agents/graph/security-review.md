# Security Review

Lens: privacy, auth, capture gates, secrets, localhost exposure. Does **not** restyle UI or argue product taste.

For each relevant feature: attack/privacy story, whether the north-star personal agent is safe to leave running all day.

---

## Log

## Run 2026-08-18 — Improve coach re-audit

**What:** Privacy/auth re-audit of U01–U15 (Improve coach after the 2026-08-13 implementer guide landed). Did not restyle, did not implement, did not rewrite `output.md`. Question: does topic extract, local Ollama suggestions, https open, Track, and apiVersion 6 ship without hosted LLM of history, without Gmail/Friends on cards, and without unsanitized `shell.open`.

**Why:** Planner pass criterion 4: no hosted LLM of history; no emails on cards; https-only open. Worker claimed those gates are in the tree — verify, do not rubber-stamp. North star: local Ollama, propose-only, secrets stay on this PC. Security blockers beat style.

**Evidence:**

- `packages/agents/src/insight-quality.ts` `extractLearningTopic` — on-box parser. `graph engineering ai - Google Search` → `graph engineering` (eval). Gmail titles: `EMAIL_RE` / `\bgmail\b` / promo phrases return `null`. Friends YouTube: `isEntertainmentTitle` → `null`. Does **not** invert `isNoiseSurface`. `redactPii` strips emails. `isCoachCardText` blocks emails, `\bgmail\b`, telemetry copy (allows a topic like “youtube api”). `isHttpsUrl`: `https:` only, no `username`/`password`, hostname must contain `.` (rejects `javascript:`, `http:`, `https://user:pass@…`; `https://127.0.0.1` still passes because the hostname has dots).
- `packages/agents/src/insights.ts` `suggestResources` — `runLlm({ purpose: "improve-suggest", skipHosted: true, prompt: \`LEARN_TOPIC: ${topic}\` })`. Prompt is the extracted topic string only — not artifact titles, not Gmail, not the week’s browse table. If `provider !== "ollama"`, items `[]` and honest offline copy. `parseSuggestions` keeps ≤2 URLs that pass `isHttpsUrl` + `redactPii` on titles. `generateWeeklyInsights` ranks `artifacts` via `rankLearningTopics`, inserts only after `redactPii` + `isCoachCardText`. Deletes `TELEMETRY_KINDS`. Logs `{ weekKey, created }` only. `listInsights` filters `learn`/`progress`, re-redacts, re-filters suggestion URLs. `trackLearningTopic` persists `normalizeLearningTopic` → `Learn: ${topic}` (not raw `artifacts.title`).
- `packages/agents/src/llm.ts` `runLlm` / `tryHostedLlm` — `skipHosted` skips hosted on both Ollama-down and throw paths. `offlineStub` for a `LEARN_TOPIC` prompt is plaintext “Ollama not available…”, not fake JSON URLs. `trackUsage` stores `{ purpose }` only, not the prompt.
- `packages/worker/src/scheduler.ts` `jobInsights` / boot catch-up — still call `generateWeeklyInsights` unattended. Safe **because** the prompt is topic-only and `skipHosted: true`. Would be a shipping-blocker if that ever copied Ask’s `recentArtifacts[].title` pattern.
- `packages/capture/src/index.ts` `artifactKey` — URL key remains `origin+pathname` (query stripped). All `google.com/search` share one row. `touchArtifact` overwrites `title` with last `window_title`. `observations` still store each `windowTitle`/`url`. Ranker does not read observations (product hole U11, not extra Improve amplification of Gmail — Gmail still never becomes a topic).
- `apps/web/src/pages/WidgetPage.tsx` `openExternal` — returns unless widget `isHttpsUrl` (`https:` + no userinfo). Then `shell.open` / `plugin:shell|open` / `window.open`. Host shown via `suggestionHost`. No auto-open. Widget `isHttpsUrl` is slightly weaker than the agent helper (no “hostname must contain a dot”), but Improve items are already filtered by `listInsights`. React renders titles/bodies as text. Voice may show learn/progress **titles** (topic copy, allowed).
- `apps/desktop/src-tauri/capabilities/default.json` — still unscoped `shell:allow-open`. JS https gate is the Improve control; capability is not scoped to https.
- `packages/worker/src/api.ts` — `apiVersion: 6`. Insight routes behind `requireAuth`. `GET /api/insights` lists only (no generate-on-GET). `POST /api/insights/generate` returns `{ created, weekKey }`. `POST /api/insights/track` → `trackLearningTopic`. `/api/health` still the only public `/api/*` (`dataDir`, Ollama names, spool counts). Inherited F21: token-in-HTML, non-HttpOnly `brain_token`, `corsOriginFor` any localhost port, `SameSite=Strict`. Core still `127.0.0.1`. `GET /api/artifacts` still dumps raw titles (adjacent, not Improve UI).
- `apps/desktop/src-tauri/src/core.rs` — `REQUIRED_API_VERSION = 6`. `ensure_core_running` recycles a healthy-but-stale core via `stop_core_if_owned` → `stop_core_on_port`. Quit also `stop_core_on_port`. Previous U09 “orphan telemetry/email cards after rebuild” is closed for apiVersion < 6.
- `packages/evals/src/insight-quality.test.ts` — extract `graph engineering`; Friends/Gmail `null`; `you@example.com` (not the live mailbox). https / userinfo / `javascript:` cases. No eval that `skipHosted` is set; no two sequential Google queries both ranked (U11, logic not privacy).

**All-day verdict:** Safe to leave running **for this Improve loop**: no hosted LLM of search history, no Gmail/Friends/account emails on coach cards, suggestions stay on-box, opens are user-click + https, stale-core attach no longer serves the old telemetry generator. Search **topics** on the widget are allowed. Capture still stores full queries and Gmail window titles in `artifacts` / `observations` forever (inherited, not this card path). No **shipping-blocker** on U01–U15.

**Verdicts:**

| ID | leak/safe/n/a | notes |
|----|---------------|--------|
| U01 | **safe** | On-box extract. Gmail / Friends / promo stay `null`. Showing “graph engineering” is allowed. Do not send the artifacts table to an LLM — current code does not. |
| U02 | **safe** | `skipHosted: true`; prompt is `LEARN_TOPIC: ${topic}` only; offline stub invents no URLs. **Previous shipping-blocker is fixed.** Cron/boot Ollama of a topic string is OK. |
| U03 | **safe** | Click-only; `https:` + no userinfo; host shown. Unscoped `shell:allow-open` remains capability-level hardening. Widget helper omits the hostname-dot check; Improve URLs already passed agent `isHttpsUrl`. |
| U04 | **safe** | Authed `POST /api/insights/track`. Stores normalized topic, not raw SERP/Gmail title. User-typed “I want to learn X” is local SQLite. Inherited localhost CSRF on this POST (F21) — label, same as other POSTs. |
| U05 | **safe** | Progress is on-box `topicMatches` against ranked extract. No hosted re-score. Body is a stock sentence (no email, no URL). Fragile if U11 overwrote the title — correctness, not a leak. |
| U06 | **safe** | Telemetry kinds no longer inserted; cutting them shrinks the widget PII surface. |
| U07 | **safe** | Generator deletes `focus`/`deep_work`/`artifacts`/`skills`. `listInsights` cannot return those rows. Dismiss deletes. |
| U08 | **safe** | Coach copy + Track/Dismiss. `isCoachCardText` drops Gmail/emails. Voice titles are topic strings — allowed. No HTML. |
| U09 | **safe** | `apiVersion` 6 matches `REQUIRED_API_VERSION`. Stale :3000 is killed on launch when version is old, and on Quit. **Previous shipping-blocker-adjacent is fixed.** Future Improve semantics still need a version bump. |
| U10 | **safe** | Fixture is `you@example.com`. Extract vs Friends/Gmail covered. Missing two-query ranking / `skipHosted` evals are gaps, not production PII. (`categories.test.ts` still embeds the live mailbox — out of this Improve scope.) |
| U11 | **n/a** (product, not a leak) | Collapse does **not** put extra PII on Improve cards; it hides earlier queries behind the last Google title. Queries remain in `observations` (capture, intended). Not a shipping-blocker. Do not treat as license to LLM those observation titles later. |
| U12 | **leak-adjacent** (phishing, not history exfil) | Model may invent `https://en.wikipedia.org/wiki/Graph_engineering` or a lookalike host. No HEAD/allowlist. User must click; host is visible; no auto-open. **Not a shipping-blocker** given Planner’s https-only bar. `https://127.0.0.1/…` passes `isHttpsUrl` (dot in hostname) — hardening, not this Gate. |
| U13 | **n/a** | Missing Done/untrack is product. Stored `Learn:` loops stay local; user can still Dismiss/Done on other widget filters. No extra off-box path. |
| U14 | **safe** | Wikipedia / non-entertainment YouTube extract is on-box, same Gmail/email denylist. Docs titles that never match Search/Wiki/YT simply do not become topics. |
| U15 | **n/a** | Not built. If counts/last-URL are added later: keep last URL off the card unless https-gated; do not paste Gmail; do not hosted-LLM the week’s observations. |

**Blockers:**

- **No shipping-blocker** on U01–U15. Last run’s blockers are closed in this tree: hosted LLM of history (U02), Gmail/Friends on cards (U01/U08), unsanitized Improve open (U03), stale-core email/telemetry (U09), live mailbox in this eval file (U10).
- **Not a shipping-blocker:** U11 capture identity (logic). U12 invented https URLs with visible host (style/logic/phishing hardening). U13/U15 missing UX. Insight logs still have no titles. `GET /api/insights` is authed and does not generate. Remote `https://evil.com` still cannot CORS-read insights.
- **Inherited F21 (label, do not ignore):** token-in-HTML + localhost CORS + cookie CSRF can let another local origin credentialed-GET insight bodies (now **search topics** + suggestion URLs) and `GET /api/artifacts` (raw last titles). Accepted for the widget user; still a local-origin hole.
- **Hardening (for Synthesizer, not this node to implement):** keep `skipHosted` on improve-suggest; never prompt artifact/observation titles; reject IP-literal suggestion URLs or add a public-host allowlist; scope Tauri `shell:allow-open` to https; bump `apiVersion` on the next Improve semantic change; do not copy Ask’s full-history prompt into this path.

---

## Run 2026-08-13 — Improve = learn from last week's searches

**What:** Privacy/auth review of U01–U10 only (topics from last week’s searches → 1–2 propose-only resources → Track). Did not restyle UI, did not implement, did not re-verdict KEEP/FIX/CUT. Question: can topic extract, Ollama suggestions, opening URLs, and stored targets ship without hosted LLM of browse history, without Gmail on cards, and with search-topic on the widget allowed.

**Why:** Planner pass criterion 4: no hosted LLM of full history; no emails on cards; search-topic on the widget is OK. User cut focus telemetry. North star: local Ollama, propose-only, secrets stay on this PC.

**Evidence:**

- `packages/capture/src/index.ts` `artifactKey` — URL key is `origin+pathname` (query string dropped from the key). All Google searches collapse to `https://www.google.com/search`; `title` is `obs.window_title || obs.url` (last query, e.g. `graph engineering ai - Google Search`). `touchArtifact` overwrites that title forever. Gmail Chrome titles remain `Subject - user@gmail.com - Gmail`. No retention on `artifacts.title`.
- `packages/agents/src/insight-quality.ts` — `redactPii` strips emails only (correct for this product). `isNoiseSurface` / `isWorkArtifact` treat **Google Search, YouTube, Gmail, X** as noise — so today’s generator **never** turns a query into a topic (U01 missing). `isSafeInsightText` also rejects `google search` and emails; that hides Gmail (good) and would also hide a raw SERP string if someone pasted it onto a card.
- `packages/agents/src/insights.ts` `generateWeeklyInsights` — still **template-only**, no `runLlm`. Inserts focus / deep_work / work / skills. `insert` runs `redactPii` + `isSafeInsightText` before persist. `listInsights` redacts again and drops unsafe rows. `dismissInsight` **deletes** the row. Logs still `{ weekKey, created }` only. GET no longer auto-generates (that side-effect is gone from `packages/worker/src/api.ts`).
- `packages/worker/src/api.ts` — `/api/health` still the only unauthenticated `/api/*`. `GET /api/insights`, `POST /api/insights/generate`, `DELETE /api/insights/:id`, `POST /api/loops` (`createManualLoop`) sit behind `requireAuth`. Inherited F21 still applies: token-in-HTML, non-HttpOnly `brain_token`, `corsOriginFor` any `http(s)://127.0.0.1|localhost` port, `SameSite=Strict` (port is not the site). Core still binds `127.0.0.1`. `GET /api/artifacts` still returns raw titles (adjacent dump, not Improve UI).
- `packages/agents/src/llm.ts` `runLlm` / `tryHostedLlm` — local Ollama first (`127.0.0.1:11434`). If Ollama is down **or** the chat call throws, and `BRAIN_HOSTED_LLM_URL` + `BRAIN_HOSTED_LLM_KEY` are set, the **full prompt** is POSTed off-box. No purpose allowlist; no UI consent. `packages/agents/src/ask.ts` already sends `recentArtifacts[].title` (unredacted) through this path — **do not copy that pattern** for Improve. Insights do not call `runLlm` today.
- `packages/agents/src/tools.ts` `createManualLoop` — authenticated insert of `title` / `description` into `open_loops` (`origin: "manual"`, `category: "other"`). No length cap, no PII filter. Widget Improve has **no** Track / custom-target field yet (`WidgetPage.tsx` Improve: Dismiss + Refresh / Generate only).
- `apps/web/src/pages/WidgetPage.tsx` `openExternal` — `api.shell.open(url)` then `plugin:shell|open` then `window.open`. **No scheme check.** Loop `sourceUrl` already uses this. Improve cards have no URL/Watch/Read. `apps/desktop/src-tauri/capabilities/default.json` grants unscoped `shell:allow-open` (not `shell:default`’s http(s)/tel/mailto scope). React renders `ins.title` / `ins.body` as text — not XSS.
- `apps/desktop/src-tauri/src/core.rs` — `health_ok` attaches to any `:3000` core with `"ok":true`. `REQUIRED_API_VERSION = 5` matches `api.ts` `apiVersion: 5`. `insights.ts` changes do **not** bump it. `ensure_core_running` reuses a healthy current core. `stop_core_if_owned` + `stop_core_on_port` run on tray **quit**; Force-kill of the .exe skips that → orphan worker keeps the old generator (matches screenshot of telemetry / possible old email cards after rebuild).
- `packages/evals/src/insight-quality.test.ts` — asserts Search/YouTube/Gmail are not work artifacts; forbids activity-block copy. **No** `extractTopic("graph engineering ai - Google Search") → "graph engineering"`. Fixture used a live mailbox (replaced in git with `you@example.com`).
- Scheduler: `jobInsights` / `catchUpOnBoot` call `generateWeeklyInsights` locally. If U02 later puts history into `runLlm`, **Monday cron and boot** become an unattended off-box path.

**All-day verdict:** Safe to leave running **today** in the same sense as the last Improve pass: this loop still does not phone home, does not log bodies, and insight routes are token-gated. Search queries and Gmail subjects **remain in `artifacts` forever** (capture, not Improve). The **intended** product (topic on widget, 1–2 links, Track) is not built; the shipping risk is how it gets built. Search-topic on the widget is **allowed**. Gmail on cards is **not**. Hosted LLM of last week’s titles is **not**.

**Verdicts:**

| ID | Security verdict | Reason |
|----|------------------|--------|
| U01 | leak (if dumped) / safe (if parsed) | Capture already stores the query in `artifacts.title`. Inverse of `isWorkArtifact` must **parse** `… - Google Search` / YouTube search into a topic string, not join raw titles. Gmail / Friends / promo subjects must stay denylisted. Showing “graph engineering” on Improve is **safe** (user-ok). Showing `user@gmail.com` or the SERP chrome is **leak**. Regex/local extract — do not send the artifacts table to an LLM. |
| U02 | n/a (blocker if copied from Ask) | Not built. `runLlm` is local-first. **Shipping-blocker** if the prompt is last week’s browse/search/Gmail titles: `tryHostedLlm` will exfil that prompt whenever Ollama fails and hosted env is set; cron/boot would do it unattended. Safe shape: extract topics on-box, prompt only the topic (“graph engineering”), 1–2 propose-only `{title, url}`; skip hosted fallback for this purpose; never invent URLs in the offline stub. |
| U03 | n/a (leak if unsanitized open) | Not wired on Improve. Existing `openExternal` + unscoped `shell:allow-open` will open whatever string is passed (`file://`, UNC, random https). LLM-hallucinated “article” URLs are phishing. **Do not auto-open.** User click + `https:` (and `http:` localhost-only if needed) allowlist before `shell.open`. Show the URL/host. Propose-only matches north star. |
| U04 | n/a (safe if topic-only) | `createManualLoop` is authed, local SQLite — fine for a user-typed “I want to learn X.” **Leak** if Track copies a Gmail window title or full SERP into `open_loops` / `goalsJson`. Persist the extracted topic (or the user’s string), not `artifacts.title`. Inherited localhost CSRF on `POST /api/loops` (F21) — label, same as other POSTs. |
| U05 | n/a | No progress scorer. When built: match later **search/watch** titles against the saved topic on-box. Do not re-score by sending new history to hosted LLM. Do not treat Gmail as progress. |
| U06 | n/a | Focus / deep-work templates use app names and minutes — not emails. Cutting them is product, not a privacy hole. Removing cards slightly shrinks the widget PII surface. |
| U07 | safe | `listInsights` redacts emails and drops `isSafeInsightText` failures (including old activity-block copy). Dismiss deletes. Screenshot still showing junk is **U09** (stale process), not a missing filter in this tree. Do **not** weaken email redact to make search topics visible — split “search → topic” from “mail/social → drop.” |
| U08 | safe (topics) / leak (mail) | Improve already GETs full insight bodies on every widget `load()`, even off the Improve filter. React text is XSS-safe. Search-topic copy on Improve is OK. `insightVoice` puts non-`artifacts` titles on the always-on voice — Gmail must never be a kind that lands there; a short topic title is OK. No Track field yet — when added, treat as text, not HTML. |
| U09 | leak (delivery) | `health_ok` + `apiVersion` 5 reuses any live core. Force-kill leaves an orphan on `:3000`; next .exe attach serves **old** `listInsights` / generator (email cards, telemetry copy). Privacy fixes in `insights.ts` never reach the widget until that process dies. Not a remote exploit; it **keeps the previous I04 leak in production** after the user rebuilt. Bump `REQUIRED_API_VERSION` / `apiVersion` when Improve semantics change, or kill-by-port on launch when the running core is older than this desktop. |
| U10 | leak (fixture PII) / n/a (missing extract) | Eval correctly forbids Gmail-as-work and telemetry copy. Missing: extract `graph engineering` from a Search title. The fixture embedded a real mailbox — use a synthetic address in git (`you@example.com`). No production-DB dump. |

**Blockers:**

- **Shipping-blocker for this product (U02 design):** Do not send last week’s artifact titles, full browse history, or Gmail window titles through `runLlm`. Hosted fallback is silent and cron-capable. Local Ollama of a **topic string** is OK. No hosted LLM of history — Planner criterion 4.
- **Shipping-blocker (U01/U08 cards):** Do not put Gmail / account emails / Friends homepage on Improve. Search **topic** on the widget is OK. Inverting `isNoiseSurface` without a parser re-opens I04.
- **Shipping-blocker-adjacent (U03):** Do not pass model-generated URLs to unscoped `shell.open` without an `https:` allowlist and a visible host. No auto-navigation.
- **Shipping-blocker-adjacent (U09):** Stale-core attach means privacy filters in this tree are not what the widget runs. Treat as a ship-gate for Improve, not style.
- **Not a shipping-blocker:** Current generator still does not call hosted LLM. Insight **logs** have no titles. `GET /api/insights` is authed and no longer generates on read. `redactPii` on list/insert. Remote `https://evil.com` still cannot CORS-read insights. U06 is not a leak. User-typed Track (U04) is local.
- **Inherited F21 (label, do not ignore):** token-in-HTML + localhost CORS + cookie CSRF can let another local origin credentialed-GET insight bodies and artifacts. This product will put **search topics** (sensitive) on that payload — accepted for the widget user, still a local-origin hole.
- **Hardening (for Synthesizer, not this node to implement):** Parse query from search titles on-box; never LLM the artifacts table; skip `tryHostedLlm` for insight/suggest purpose; `https:`-only open; store topic strings not raw titles; bump `apiVersion` with Improve; replace the real email in evals; keep Gmail denylist when adding a search-topic allowlist.

## Run 2026-08-13 — Improvement loop (upskill insights)

**What:** Privacy/auth review of I01–I12 (Improve / upskill insight loop only). Did not restyle UI, did not implement fixes, did not re-litigate F01–F22 except where this loop reuses those gates. Question: is it safe to leave this personal agent running all day, given the Improve tab already showed a Gmail subject plus an account email.

**Why:** Planner pass criterion 4: insights must not leak extra PII into logs or off-box; they may show local titles the user already generated. The screenshot is extra amplification — capture already stored the window title; generate copied it into a durable weekly card, a GET body, and an unencrypted backup, with no redact and no dismiss.

**Evidence:**

- `packages/worker/src/api.ts` `handle` — `/api/health` remains the only unauthenticated `/api/*` route. `GET /api/insights`, `POST /api/insights/generate`, `GET/PATCH /api/profile`, `GET /api/artifacts`, `GET /api/buckets` all sit behind `requireAuth`. Generate is **not** an anonymous CSRF gadget for remote sites. Inherited F21 still applies: token-in-HTML + non-HttpOnly `brain_token` + `corsOriginFor` allowing any `http(s)://127.0.0.1|localhost` port + `SameSite=Strict` (port is not part of the site) means another local page on `127.0.0.1:<any>` can credentialed-fetch insight bodies. Core still binds `127.0.0.1`.
- `packages/worker/src/api.ts` `GET /api/insights` — `listInsights()` then, if empty, **calls `generateWeeklyInsights()` as a GET side-effect** and returns `{ insights: rows }`. `listInsights` is a full-table dump (`packages/agents/src/insights.ts`): `id`, `kind`, `title`, `body`, `score`, `metaJson`, `createdAt`, `weekKey`. Bodies are the leak payload. Widget `WidgetPage.load` calls `api.insights()` on **every** widget refresh, not only the Improve filter — so opening the desktop app both reads and (when empty) writes this PII.
- `POST /api/insights/generate` — authenticated; response is `{ created, weekKey }` only (no titles). Monday cron `jobInsights` and boot `catchUpOnBoot` call the same generator. `runJob` persists `statsJson` as that same `{ created, weekKey }` object. `log.info("Weekly insights generated", { weekKey, created: created.length })` and `log.info("Job ok: insights", stats)` do **not** log titles or bodies. Logs are not the leak.
- `packages/agents/src/insights.ts` `generateWeeklyInsights` — template-only, **no `runLlm`**. Insight generation does not send activity off-box. Focus/deep-work/skills templates use app names, switch counts, dwell minutes, GitHub **counts** — not window titles. The artifacts template does: ``Most-touched: ${arts.slice(0,5).map(a => a.title).join(" · ")}``. `getUserProfile()` interpolates `role` and `goals.slice(0,3)` into the focus body when set.
- `packages/capture/src/index.ts` `artifactKey` — URL key is `origin+pathname` (query stripped from the key, not from the title). Title is `obs.window_title || obs.url`. Window path: ``${obs.app}: ${obs.window_title}``. Gmail Chrome titles are `Subject - user@gmail.com - Gmail`. Google Search titles carry the query. `touchArtifact` overwrites `artifacts.title` on every touch and increments `touchCount`. Ingest `isSpam({ title: window_title, kind: obs.source })` has no Gmail `CATEGORY_PROMOTIONS` labels on a browser window; HARD_RE does not match “Claim Your One-Time Pack”. Promo mail subjects become first-class artifacts. Screenshot matches this path.
- `packages/core/src/db/schema.ts` `insights` / `artifacts` — no retention column; `purgeStaleObservations` nulls OCR `observations.text` after 30 days and thins old window rows; **does not delete or redact `artifacts` or `insights`**. `backupDb` `VACUUM INTO` copies `brain.db` unencrypted, including insight bodies and artifact titles. `activity_blocks.title` can hold the same window titles; I02 does not copy them into insight text (app names only).
- `packages/agents/src/feedback.ts` `getUserProfile` / `saveUserProfile` — single-row `id=local`. `PATCH /api/profile` is authenticated, no field-size cap; only known columns written. `GET /api/profile` returns `role`, `goals`, `workHours`, `contacts`. Contacts are not yet spliced into insight text. Widget never calls `saveProfile` (Worker). React renders `ins.title` / `ins.body` as text children in `WidgetPage.tsx` — not `dangerouslySetInnerHTML`; stored XSS via a malicious window title is not this loop’s hole.
- Adjacent amplification (not new F-features): `GET /api/artifacts` returns up to 50 raw titles; `GET /api/now` `resume` uses `whereDidILeaveOff` artifact titles; `askMemory` puts `recentArtifacts[].title` into the LLM prompt (`packages/agents/src/ask.ts`) — off-box only if hosted LLM env is set (F20). MCP `findArtifact` / recent-artifacts is stdio, same-user. `GET /api/buckets` includes `improve` insight rows with full bodies.

**All-day verdict:** Safe to leave running in the sense that this loop does **not** phone home, does **not** log insight bodies, and generate is token-gated. Not safe as a privacy story: all-day capture stores Gmail/search/social window titles as artifacts forever; the weekly job (or the first widget `GET /api/insights`) copies the top five — including the account email — into `insights.body`, serves them on GET, and backups keep them. No dismiss. Week lock freezes the leak until next ISO week.

**Verdicts:**

| ID | Security verdict | Reason |
|----|------------------|--------|
| I01 | leak | Generator is local/template (no off-box LLM) — good. It still persists raw artifact titles into `insights.body` and GET returns them. Auto-generate on empty GET is a write via read. |
| I02 | safe | App-name churn + minutes only. No titles, no emails. Score unused in UI is not a privacy issue. |
| I03 | safe | Dwell-sum + hardcoded advice. Does not read calendar bodies or call pause. No PII in the card. |
| I04 | leak | Recurring-surfaces card is the screenshot leak: Gmail subject + account email, Google Search, YouTube, X, Notion joined into one body. Titles stored in `artifacts` with no purge. |
| I05 | safe | Skills text uses GitHub issue/PR **count** or a generic browsing line — does not paste issue titles or URLs. |
| I06 | leak (latent) | Profile GET/PATCH behind auth. Role/goals can land in focus body on next generate; contacts sit in SQLite + GET `/api/profile` unused by insights today. No widget writer. Not XSS. |
| I07 | leak | Improve cards render full bodies (React text — XSS-safe). `load()` always GETs insights, so PII is in the widget process even when Improve is not selected. Kind labels are style, not security. |
| I08 | leak | No dismiss/snooze/redact. Once an email is in `insights.body`, the user cannot remove it from the widget, DB, or backups. Advice that mentions “notifications paused” does not toggle capture (logic, not a new leak). |
| I09 | leak | `existing.length >= 3` no-op locks the PII card for the ISO week. POST generate cannot replace junk. |
| I10 | leak | No insight-time noise/PII filter. `artifactKey` keeps full window titles; ingest `isSpam` does not see Gmail promo labels on a Chrome tab. Search queries and account emails are first-class surfaces. |
| I11 | n/a (do not ship unredacted) | Default voice does not render insight bodies today — fewer shoulder-surf/screenshot surfaces. Putting 1–2 insights on the always-on widget **without** stripping emails/search queries would be a shipping blocker. |
| I12 | n/a | No eval fixtures for this loop — no extra PII in eval dumps. Missing quality gate is not a privacy hole. |

**Blockers:**

- **Shipping-blocker for this loop:** I04/I10 copy live window titles (Gmail account email, search queries, promo subjects) into `insights.body` and `GET /api/insights` with no redact, no retention, no dismiss (I08), and a week lock (I09). Confirmed by the user screenshot. Do not treat “local titles the user already generated” as license to re-publish the mailbox address on a weekly card and in unencrypted backups.
- **Not a shipping-blocker:** `POST /api/insights/generate` is behind `requireAuth` and does not return bodies. Insight **logs** do not contain titles. Generator does not call hosted LLM. Remote `https://evil.com` still cannot CORS-read insights. I02/I03/I05 are title-free.
- **Inherited F21 (label, do not ignore):** token-in-HTML + localhost CORS + cookie CSRF makes `GET /api/insights` (full bodies) and `GET /api/artifacts` readable by any other local origin once the widget/core is up. This loop adds the email-bearing payload to that hole.
- **Hardening (for Synthesizer, not this node to implement):** Strip emails and search-like titles before `insert(..., a.title)`; do not generate on GET; add dismiss that deletes or redacts the row; purge or redact `artifacts.title` on the same schedule as OCR; keep I11 off the floating voice until redaction exists; do not send artifact titles to hosted LLM.

## Run 2026-08-13 — Personal AI agent for desktop

**What:** Code-backed privacy/auth review of F01–F22 for an all-day Windows agent (Tauri + core on `127.0.0.1:3000`). Did not implement fixes. Answered Worker gap 1 (capture toggles).

**Why:** A personal agent that OCRs the screen and holds Gmail/GitHub tokens must not leak that to random sites, must not capture passwords/incognito/chat, and must not send memory off-box unless the user opted in.

**Evidence:**

- `packages/worker/src/api.ts` `handle` — `GET /api/health` is the only `/api/*` route before `requireAuth`. Health does **not** return loops/OCR/mail bodies, but it is unauthenticated and returns `dataDir`, Google/GitHub `lastError`, Ollama model names, and spool file/byte counts.
- `packages/worker/src/api.ts` `tryServeStatic` + `injectTokenIntoHtml` — every HTML response (no auth) embeds the live API token in `<meta name="brain-api-token">` and `window.__BRAIN_API_TOKEN__`, and sets `Set-Cookie: brain_token=…`. A browser tab or DNS-rebind client that can `GET /` learns the token; after that, `/api/loops`, `/api/timeline` (OCR text), `/api/ask`, `/api/settings` are readable.
- `packages/core/src/api-token.ts` — token is plaintext `%LOCALAPPDATA%\second-brain\api-token` (`mode: 0o600`, ignored on NTFS ACLs). Cookie is `Path=/; SameSite=Strict; Max-Age=31536000` — **no `HttpOnly`**, no `Secure`. `isValidApiToken` is constant-time. `corsOriginFor` allowlists `tauri://localhost` plus **any** `http(s)://127.0.0.1|localhost` **port**. Combined with schemeful same-site (port is not part of the site), another local page on `127.0.0.1:<any>` can credentialed-fetch the API. Remote `https://evil.com` cannot (CORS deny + SameSite). Core binds `config.host` default `127.0.0.1` (`packages/core/src/config.ts`) — not `0.0.0.0`.
- `packages/worker/src/api.ts` `POST /api/capture/wake` — **authenticated** (falls through `requireAuth`). Not a public CSRF gadget for random websites. Desktop caller `CaptureEngine::wake_core_loops` in `apps/desktop/src-tauri/src/capture.rs` sends `Authorization: Bearer` + `X-Brain-Token` from `core::api_token()`. Localhost cookie CSRF remains (same as other POSTs). No Origin/Host pin.
- Worker gap 1 — **toggles do reach Rust, with a clobber bug.** Settings `PATCH /api/settings` when `key === "capture.toggles"` merges `toggles` into `capture-control.json`. Rust `read_toggles()` is called every capture loop tick (`loop_forever`) and gates `tick_window` / `tick_browser` / `tick_ocr`. Missing keys default **on**. **Bug:** `POST /api/capture/pause` does `writeFileSync(capture-control.json, { paused_until })` and **wipes** `toggles`. After pause, OCR/window/browser snap back to all-true until the user saves settings again. Rust `write_control` correctly merges; Node pause does not. `SettingsPage.setToggle` does call `api.patchSetting("capture.toggles", next)` (plus a redundant unauthenticated-looking `fetch` that still sends the cookie).
- `apps/desktop/src-tauri/src/capture.rs` privacy gates:
  - Password-manager **exe** blocklist in `CaptureEngine::new` (`1password.exe`, Bitwarden, KeePass, LastPass, `credentialuibroker.exe`, …). Missing Dashlane/NordPass/Keeper/Chrome built-in PM. Browser-extension vaults are not blocked.
  - Auth **domains** (`accounts.google.com`, `login.microsoftonline.com`, `auth0.com`, `paypal.com`, …) skip browser-history rows and OCR **title** / OCR **lines** (`filter_blocked_ocr_text`). Login pages whose title/URL omit those substrings still OCR.
  - Incognito: `tick_window` drops titles containing `incognito`/`inprivate`. **`tick_ocr` does not.** Incognito screen text still lands in spool JSONL.
  - Chat: **not skipped.** `is_chat_surface` **accelerates** OCR (2s vs 8s) and `wake_core_loops`. `capture_target_ocr` fallback `capture_any_chat_window_ocr` **hunts** WhatsApp/Telegram/Slack/Discord/Signal even when not focused. Contradicts north star and Worker note “chat windows skipped.”
  - Trading desks: still OCR’d. `interests.trading` is only consulted in `packages/agents/src/loops.ts` `isTradingInterestEnabled`, not in Rust.
  - Bitmaps: `win_ocr_rgba` encodes PNG in memory (`InMemoryRandomAccessStream`) — **not written to disk**. OCR **text** is appended to `spool/obs-YYYY-MM-DD.jsonl`. **`ocr_debug` appends samples (80 chars) to `ocr-debug.log` with no retention.**
  - Pause: Rust reads `paused_until` from the control file each tick; tray `pause_for_minutes` merges. Idle gate 120s, but chat/trade stay “hot.”
  - Startup / widget-focus with empty `last_user_exe`: fullscreen monitor OCR (`capture_fullscreen_ocr`) can include whatever is on screen, including vaults.
  - `load_control_into` (user `capture-rules.json`) runs only in `new()`, not each tick — new block rules need a capture-thread restart.
- `packages/core/src/crypto.ts` `deriveKey` — `config.masterKey || "dev-insecure-key-change-me-please"`. Packaged .exe does not generate `BRAIN_MASTER_KEY`. AES-256-GCM is real, but the default key is public. Google tokens (`packages/connectors/src/google-auth.ts` `TOKEN_KEY = "google_tokens"`) and GitHub PAT (`github-auth.ts` `SECRET_KEY = "github_token"`, also copied from `gh auth token`) live in `secrets.enc.json`. Google OAuth callback `127.0.0.1:3456` has **no `state`/PKCE**. Scopes are readonly. `PATCH /api/settings` has **no key allowlist**.
- `packages/mcp/src/index.ts` — stdio MCP (`StdioServerTransport`) exposes `search_memory`, `open_loops`, `timeline`, `what_did_i_do`, etc. with **no token**. Not a network listener. Anyone who can spawn the process as this user (Cursor MCP config) gets full local memory. Appropriate for a personal builder tool; unsafe if ever bound to TCP.
- `packages/agents/src/license.ts` — offline HMAC (`SB1.<payload>.<sig>`), `GET/POST /api/license` **behind auth**. No phone-home. Trial starts on first `licenseStatus()`. Not a data-exfil path.
- `packages/agents/src/llm.ts` `tryHostedLlm` — if `BRAIN_HOSTED_LLM_URL` **and** `BRAIN_HOSTED_LLM_KEY` are set, prompts (mail/OCR/loops) are POSTed off-machine whenever Ollama is down or errors. Default `.env.example` leaves them commented — **opt-in leak**, silent (no UI consent). Local Ollama otherwise stays on `127.0.0.1:11434`.
- `apps/desktop/src-tauri/tauri.conf.json` `app.security.csp: null` — widget XSS would steal `window.__BRAIN_API_TOKEN__`.
- F22: `purgeStaleObservations` nulls OCR `text` after `OCR_RETENTION_DAYS` (default 30); does **not** delete `ocr-debug.log` or spool files already ingested. `backupDb` copies `brain.db` (mail/OCR-derived rows) unencrypted into `backups/`.

**Verdicts:**

| ID | Security verdict | Reason |
|----|------------------|--------|
| F01 | KEEP | Core bound to 127.0.0.1; shell reads token from data dir. CSP-null is hardening, not a spawn bug. |
| F02 | FIX | Exe/domain blocklists and in-memory OCR bitmaps are real; chat is **captured faster**, incognito OCR is ungated, `ocr-debug.log` persists text, fullscreen fallback can see vaults. |
| F03 | FIX | Toggles **are** wired (`read_toggles` ↔ `capture-control.json`); Node `POST /api/capture/pause` overwrites that file and re-enables all tiers. |
| F04 | FIX | Chat OCR still feeds spool / fast-wake; trading OCR still written even when interest is off. |
| F09 | KEEP | Ask/search sit behind `requireAuth`; risk is the token-in-HTML path, not the route itself. |
| F10 | FIX | Tokens encrypted at rest, readonly scopes; default master key + OAuth callback without `state` are the holes. |
| F15 | KEEP | Stdio-only, no HTTP. Treat as same-user trust (Cursor). Do not expose on a port. |
| F17 | CUT | Offline license; no data leaves. Dead SaaS surface — not a privacy blocker. |
| F18 | FIX | Capture does not honor `interests.trading`; desks still OCR’d. |
| F20 | KEEP | Local Ollama is default. Hosted fallback is env-gated; if set, it **is** an off-box memory leak — needs explicit consent, not silent catch. |
| F21 | FIX | Auth exists and blocks anonymous `/api/loops`. Token-in-HTML, cookie not HttpOnly, CORS any localhost port, public health metadata, default AES key. |
| F22 | KEEP | Scheduled OCR text purge + DB backup. Debug log / control-file clobber are F02/F03. |

(F05–F08, F11–F14, F16, F19: no distinct security finding beyond F21’s API gate.)

**Blockers:**

- **Shipping-blocker:** Chat surfaces are still OCR’d (and background-hunted) despite product law that WhatsApp/Telegram/Slack are out — all-day capture of private messages. **Shipping-blocker:** `BRAIN_MASTER_KEY` defaults to a public string, so `secrets.enc.json` is reversible by anyone who copies the data dir. **Shipping-blocker-adjacent:** Node pause wiping `capture.toggles` can turn OCR back on after the user disabled it.
- **Not a shipping-blocker (hardening):** Random *remote* websites cannot CORS-read loops/OCR/mail (`SameSite=Strict` + origin allowlist + 127.0.0.1 bind). `/api/capture/wake` is **not** unauthenticated. MCP is stdio. License does not phone home. Hosted LLM does not fire unless both env vars are set.
- **Hardening (label, do not ignore):** Strip token from HTML; `HttpOnly` cookie (or Tauri invoke-only); pin `Host` to 127.0.0.1; tighten CORS to the widget origin; skip incognito in `tick_ocr`; stop `ocr-debug.log` text samples; merge (don’t replace) on pause; generate a per-install master key on first desktop launch; add `state` to Google OAuth; set a Tauri CSP; reload `capture-rules.json` each tick.

