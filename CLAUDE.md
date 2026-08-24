# Second Brain — agent & product law

## One-click desktop app (non-negotiable)

**Users only open the desktop app.** They do not run `npm` commands for daily use.

On open, the desktop app must:

1. Start local core (API + jobs + static UI) if down  
2. Show the floating widget (not Chrome)  
3. Start PC capture  
4. Offer tray quit  

Terminal scripts (`npm run dev:*`, `npm start`) are **dev-only**.

See also: [`.cursor/rules/one-click-desktop.mdc`](.cursor/rules/one-click-desktop.mdc)

## Architecture (short)

| Piece | Role |
|-------|------|
| `apps/desktop` | Tauri: tray, floating widget, capture, **spawns core** |
| `packages/worker` | Core daemon: HTTP API, SPA static files, cron |
| `apps/web` | SPA; `/widget` is the floating surface |

Data:

- Windows: `%LOCALAPPDATA%\second-brain\`
- macOS: `~/Library/Application Support/second-brain/`

Primary UI route for the shell: `http://127.0.0.1:3000/widget`

## Packaging

```bash
npm run package:app   # build web + tauri installer / .exe / .app
npm run shortcut      # Windows: pin launcher to Desktop (exe-first)
# macOS: drag Second Brain.app to /Applications
```

See [scripts/macos-signing.md](scripts/macos-signing.md) for Gatekeeper / Accessibility notes.

## Local stack notes

- LLM: Ollama on `127.0.0.1:11434` (not OpenRouter)
- Capture: window titles + browser history + on-screen text → spool JSONL
  - Windows: Win32 + WinRT OCR
  - macOS: Accessibility (AX) text — no screenshots; requires Accessibility permission
- Open loops: detect/auto-close in agents via local Ollama
