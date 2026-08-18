# Second Brain — Minimi for Windows

Local-first ambient memory for your PC. Captures what you work on (windows, browser history, on-screen text via Windows OCR), finds **open loops**, and keeps context searchable — all on-device via **Ollama**. Nothing cloud-hosted except the optional Gmail / Calendar / GitHub reads you connect.

**Propose-only** — nothing is sent or modified in external accounts. Detected loops wait for you (or auto-close when evidence says they’re done).

## Architecture

| Package | Role |
|---------|------|
| `packages/core` | Config, AES-GCM secrets, SQLite + Drizzle schema, jobs, backups |
| `packages/connectors` | Gmail, Calendar, GitHub (read-only) + Google OAuth |
| `packages/capture` | Ingest JSONL spool from the desktop capture engine |
| `packages/enrich` | Local embeddings (Ollama / transformers.js) + retrieval scoring |
| `packages/agents` | Ollama LLM: tagging, open-loop detect/close, digests, Ask |
| `packages/worker` | `node-cron` scheduler + `brain` CLI + HTTP API |
| `packages/mcp` | stdio MCP server for Cursor / Claude |
| `apps/web` | Vite + React SPA (dark, keyboard-first) |
| `apps/desktop` | Tauri tray app + Rust capture engine |

**Database:** `%LOCALAPPDATA%\second-brain\brain.db` (never inside OneDrive).  
**Spool:** `%LOCALAPPDATA%\second-brain\spool\obs-YYYY-MM-DD.jsonl`

## Prerequisites

- Node.js **22+**
- [Ollama](https://ollama.com/) with chat + embed models
- Optional: Rust + MSVC for `apps/desktop` (Tauri)
- Optional: Google OAuth Desktop client (Gmail / Calendar readonly)
- Optional: GitHub fine-grained PAT (read)

```bash
ollama pull qwen2.5:14b
ollama pull nomic-embed-text
```

## Setup

```bash
copy .env.example .env
# edit .env — set BRAIN_MASTER_KEY

npm install
npm run db:migrate
npm run db:seed
```

### Google (read-only)

1. OAuth client redirect: `http://127.0.0.1:3456/oauth/callback`
2. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
3. `npm run brain -- auth google`

Scopes: `gmail.readonly`, `calendar.readonly`.

## Use the app (one click)

**Daily use: double-click Second Brain** — do not run npm commands.

```powershell
# One-time setup for engineers
npm install
npm run package:app    # build the desktop .exe
npm run shortcut       # Desktop icon → that .exe
```

Then only open the **Second Brain** icon. The app starts core, widget, and capture by itself.

### Developer terminals (optional)

```bash
npm run dev:worker   # API only
npm run dev:web      # Vite HMR
npm run dev:desktop  # Tauri
npm run start:widget # tauri dev for floating widget
```

These are for development — never the product path.

UI is also at `http://127.0.0.1:3000/widget` once core is running (started by the desktop app).

### CLI

```bash
npm run brain -- help
npm run brain -- ingest          # gmail gcal github
npm run brain -- capture         # spool → observations
npm run brain -- enrich
npm run brain -- loops           # detect + auto-close open loops
npm run brain -- digest
npm run brain -- purge
npm run brain -- backup
npm run brain -- status
```

## Dashboard (SPA)

| Route | View |
|-------|------|
| `/` | Now — open loops + resume cards |
| `/timeline` | Today’s activity blocks |
| `/loops` | All loops + evidence |
| `/ask` | Chat over local memory |
| `/settings` | Capture toggles, blocklists, retention |
| `/health` | Sources, jobs, Ollama, spool |

## Privacy

- Capture gate: exe blocklist (password managers), domain blocklist, idle suppression, tray pause
- OCR bitmaps are never written to disk; OCR text is purged after 30 days (configurable)
- Secrets encrypted with `BRAIN_MASTER_KEY` (AES-256-GCM)
- API binds to `127.0.0.1` only

## MCP (Cursor)

`packages/mcp` exposes `search_memory`, `timeline`, `open_loops`, `what_did_i_do`, `where_did_i_leave_off`, `find_artifact`.

Add to Cursor MCP config:

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/index.ts"],
      "cwd": "C:/path/to/second-brain"
    }
  }
}
```

## License

Private personal use.
