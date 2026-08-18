# Guide — Improve yourself + chat (zero friction)

Gate: **PASS** on 2026-08-18 (re-audit). **Shipped this session:** distinct searches, evals, Done/Untrack, URL allowlist. `apiVersion` **7**.

The user opens **one .exe**. If they searched **graph engineering** last week, then later **weather**, Improve still names **graph engineering**.

## What is working (Improve)

1. **Coach cards** — `You were into {topic}` / `Still on {topic}`. Learn / Progress. No FOCUS telemetry.
2. **Track** — Track this + “I want to learn”. Tracking list: **Done** / **Untrack**.
3. **Open** — Watch / Read, host shown, click-only. Unknown hosts never ship.
4. **Suggestions** — local Ollama, `LEARN_TOPIC` only, `skipHosted`. Offline → zero URLs. Allowlist (Wikipedia, YouTube, GitHub, MDN, …) or fail closed.
5. **Distinct searches** — rank last-7d **observations** (each visit = 1). Browser `q=` is a fallback. New artifacts key search URLs with `q=` so Google searches no longer collapse onto one row.
6. **Stale core** — `apiVersion` 7; desktop replaces an old `:3000`.
7. **Evals** — extract `graph engineering`; two queries (`graph engineering` + `weather`) both ranked; Friends/Gmail out; `parseSuggestions` drops `evil.example` / `javascript:` / `http:`.

## Chat apps — scope (not built)

**Zero friction:** no Connect, no QR, no bot token, no export. The app already sees WhatsApp / Telegram / Slack / Discord / Signal / Teams windows.

Already true in the tree:

- `tick_window` writes `chat: true` + window title (`Farhan - WhatsApp`).
- `tick_ocr` **returns early** on chat — message bodies are not OCR’d.
- `ingestSpool` **drops** every chat line — titles never reach SQLite.

**Build later (C01–C07):**

1. Ingest **window-source** chat titles only (empty/strip OCR text). Keep OCR skip.
2. On-box parse peer from `Name - WhatsApp` / `Name — Telegram`.
3. Today’s work, propose-only: “You were talking to Farhan on WhatsApp.” Dismiss / Not tracking. Never send.
4. **Not** an Improve topic. Contacts ≠ graph engineering.
5. Never restore `packages/connectors-chat`. Never hosted-LLM the title.

Until C01, opening WhatsApp does nothing in the widget — by design of the current drop, not because the user failed to connect.

## Later Improve (not this slice)

- Docs/README titles as topics (U14).
- Progress copy with a count (U15) — observation counts are window ticks, so do not print raw “40 times.”

## Security (do not skip)

- Search **topic** on the widget is OK. Account emails and chat **bodies** are not.
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
