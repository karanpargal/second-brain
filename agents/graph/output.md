# Guide — Cartesia voice + personal brain (2026-08-20)

Gate: **PASS**. `apiVersion` **11**. Feature `cartesia-voice`.

The user opens **one .exe**. They type or push-to-talk in the widget. Ollama answers from local memory (what they have been doing). Cartesia only turns speech ↔ text.

## What shipped

1. **Brain Ask** — `askMemory` uses RAG + today’s activity blocks + where you left off + open loops + profile + last ~12 turns. Q&A stored as `memory_chunks` kind `ask`.
2. **Voice** — Mic on widget + Ask page → `POST /api/ask/voice` → Ink STT → ask → Sonic TTS → play. No always-on listening.
3. **Secrets** — Cartesia key in `secrets.enc.json` via Settings → Voice. SPA never sees the key.
4. **Desktop** — WebView2 microphone permission allowed for the widget; core still auto-starts.

## How to use

1. Open the desktop app.
2. Settings → Voice → paste Cartesia API key.
3. Widget footer: mic to talk, or type “Ask your agent…”.

## Privacy

Speech audio goes to Cartesia for STT/TTS. Answers are generated on this PC via Ollama. Capture OCR bitmaps are still never saved.

## Prior (Improve + chat)

Coach cards, Track / Done, chat OCR follow-ups, and one-click desktop law from earlier runs still apply. Voice is an Ask surface on top of that memory.
