# Feature inventory

Run: **2026-08-20 — Cartesia voice + personal brain**  
Worker pass: 1  

Legend: Need = required for personal desktop Ask voice. Built = real code. Working = .exe path intended.

| ID | Feature | Need | Built | Working | Notes / evidence |
|----|---------|------|-------|---------|------------------|
| V01 | Richer askMemory brain context | yes | yes | yes* | `buildAskContext` + `askMemory` in `packages/agents/src/ask.ts` — timeline, leave-off, profile, turns, RAG. *Needs Ollama healthy. |
| V02 | Ask sessions / turns + ask chunks | yes | yes | yes | `ask_sessions` / `ask_turns` in migrate+schema; `memory_chunks` kind `ask`. |
| V03 | Cartesia STT/TTS proxy + secret | yes | yes | yes* | `packages/agents/src/cartesia.ts`; `POST /api/ask/voice`, `/api/settings/cartesia`, `GET /api/ask/voice-status`; `apiVersion` 11. *Needs user key. |
| V04 | Widget / Ask mic + thread + TTS | yes | yes | yes* | `WidgetPage.tsx`, `AskPage.tsx`, `ask-voice.ts`. Push-to-talk. *Needs key + mic OS grant. |
| V05 | Settings Voice key surface | yes | yes | yes | `SettingsPage.tsx` — Voice ready / Not configured; privacy copy. |
| V06 | Desktop WebView2 mic allow | yes | yes | yes | `allow_widget_microphone` in `apps/desktop/src-tauri/src/main.rs`; `REQUIRED_API_VERSION = 11`. |

Prior Improve U01–U15 inventory remains in older worker logs / synthesizer history.
