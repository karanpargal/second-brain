# Guide — Improve yourself + chat (zero friction)

Gate: **PASS** on 2026-08-18 (re-audit). **Shipped this session:** distinct searches, evals, Done/Untrack, URL allowlist, chat OCR for asks, self-eval few-shot. `apiVersion` **9**.

The user opens **one .exe**. If they searched **graph engineering** last week, then later **weather**, Improve still names **graph engineering**.

## What is working (Improve)

1. **Coach cards** — `You were into {topic}` / `Still on {topic}`. Learn / Progress. No FOCUS telemetry.
2. **Track** — Track this + “I want to learn”. Tracking list: **Done** / **Untrack**.
3. **Open** — Watch / Read, host shown, click-only. Unknown hosts never ship.
4. **Suggestions** — local Ollama, `LEARN_TOPIC` only, `skipHosted`. Offline → zero URLs. Allowlist (Wikipedia, YouTube, GitHub, MDN, …) or fail closed.
5. **Distinct searches** — rank last-7d **observations** (each visit = 1). Browser `q=` is a fallback. New artifacts key search URLs with `q=` so Google searches no longer collapse onto one row.
6. **Stale core** — `apiVersion` 9; desktop replaces an old `:3000`.
7. **Evals** — extract `graph engineering`; two queries (`graph engineering` + `weather`) both ranked; Friends/Gmail out; `parseSuggestions` drops `evil.example` / `javascript:` / `http:`. Heuristic loop fixtures (mail/GitHub/chat/OCR) plus live Ollama `STRUCTURE_LOOPS` goldens. Misses persist to `eval.fewShot` and are injected into the next loop run.

## Chat apps — built (zero friction)

**No Connect, no QR, no bot token, no send.** Focused WhatsApp / Telegram (and Slack / Discord / Signal / Teams) windows are OCR’d.

1. Named peer from the window title. Visible thread text decides if anything is an ask.
2. Idle chat (`ok`, `lol`, thanks, stickers, Type a message) is **not** a loop. A name in the title is not enough.
3. Propose-only: “Follow up with Farhan on WhatsApp about sending the deck.” Dismiss / Not tracking.
4. **Not** an Improve topic. Chat OCR is never embedded for learning. Local LLM only (`skipHosted`).
5. Widget **Chats** filter. Generic chrome (`WhatsApp`, `Telegram Desktop`) is not a loop.

Trading OCR, trading scorers, and Trade UI are **CUT**.

## Later Improve (not this slice)

- Docs/README titles as topics (U14).
- Progress copy with a count (U15) — observation counts are window ticks, so do not print raw “40 times.”

## Security (do not skip)

- Search **topic** on the widget is OK. Account emails are not. Chat OCR stays on-box (`skipHosted`); it is not an Improve topic.
- Keep `skipHosted` on improve-suggest. Prompt **only** `LEARN_TOPIC: {topic}`.
- Suggestion URLs: allowlist + https + no userinfo + no IP. Show the host. Do not auto-open.
- Chat titles, when ingested: local SQLite only; no hosted LLM; not on Improve.

## What not to do

- Do not bring back FOCUS / deep-work cards.
- Do not fetch Google/YouTube APIs.
- Do not tell anyone to `npm run`.
- Do not add WhatsApp Web / Telegram bots / Slack OAuth “so chat works.”
- Do not OCR chat to invent follow-ups.

Opening the Desktop app is the path. Bump `apiVersion` again on the next Improve or chat-ingest semantic change.
