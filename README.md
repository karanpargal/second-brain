# Second Brain

Local-first ambient memory for Windows. The desktop app captures what you work on (windows, browser history, on-screen OCR), finds **open loops**, and keeps context searchable — mostly on-device via [Ollama](https://ollama.com/). Optional Gmail / Calendar / GitHub are **read-only**. Optional cloud models apply only to **Ask**, if you turn them on.

**Propose-only** — nothing is sent or modified in external accounts unless you explicitly connect that provider. Detected loops wait for you (or auto-close when evidence says they’re done).

[Getting started](GETTING_STARTED.md) · [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) · [License (MIT)](LICENSE)

## Use the app (one click)

**Daily use: open Second Brain.** Do not run npm commands every morning.

```powershell
npm install
npm run package:app    # build the desktop .exe
npm run shortcut       # Desktop icon → that .exe
```

The app starts local core, the floating widget, and capture by itself.

Full walkthrough (Ollama, Google, voice, cloud Ask): **[GETTING_STARTED.md](GETTING_STARTED.md)**.

## Architecture

| Package | Role |
|---------|------|
| `packages/core` | Config, AES-GCM secrets, SQLite + Drizzle schema, jobs, backups |
| `packages/connectors` | Gmail, Calendar, GitHub (read-only), MCP **client** |
| `packages/capture` | Ingest JSONL spool from the desktop capture engine |
| `packages/enrich` | Local embeddings (Ollama / transformers.js) + retrieval scoring |
| `packages/agents` | Ollama (and optional hosted Ask): loops, digests, advisor, voice I/O |
| `packages/worker` | Scheduler + HTTP API + static UI |
| `packages/mcp` | Optional stdio MCP **server** for Cursor |
| `apps/web` | Vite + React SPA (`/widget` is the floating surface) |
| `apps/desktop` | Tauri tray app + Rust capture engine |

**Runtime data (not in git):** `%LOCALAPPDATA%\second-brain\` — `brain.db`, spool, encrypted secrets.

## Developer terminals

These are for engineering only — never the documented user path.

```powershell
npm run dev:worker   # API only
npm run dev:web      # Vite HMR
npm run dev:desktop  # Tauri
npm test
npm run typecheck
```

UI once core is up: `http://127.0.0.1:3000/widget`

### CLI

```powershell
npm run brain -- help
npm run brain -- ingest
npm run brain -- capture
npm run brain -- enrich
npm run brain -- loops
npm run brain -- status
```

## Privacy

- Capture gate: exe blocklist, domain blocklist, idle suppression, tray pause
- OCR bitmaps are never written to disk; OCR text is purged after 30 days (configurable)
- Secrets encrypted with a per-install master key (AES-256-GCM)
- API binds to `127.0.0.1` only
- Enabling a **hosted Ask model** sends Ask context (including open-loop titles) to that provider — leave it off to stay fully local

## License

[MIT](LICENSE)
