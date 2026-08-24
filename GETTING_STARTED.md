# Getting started

Second Brain is a **local-first** desktop agent for **Windows and macOS**. You install it once; day-to-day you only open the app. Your capture data and secrets stay on this machine.

| OS | Runtime data |
|----|----------------|
| Windows | `%LOCALAPPDATA%\second-brain\` |
| macOS | `~/Library/Application Support/second-brain/` |

## What you need

- Windows 10/11 **or** macOS 12+
- [Node.js 22+](https://nodejs.org/)
- [Ollama](https://ollama.com/) with at least one chat model
- Optional: [Rust](https://rustup.rs/) (+ Visual Studio C++ tools on Windows, Xcode CLT on Mac) if you build the Tauri app yourself

## 1. Clone and install

```bash
git clone https://github.com/karanpargal/second-brain.git
cd second-brain
cp .env.example .env   # Windows: copy .env.example .env
npm install
```

Do **not** commit `.env`. Leave `BRAIN_MASTER_KEY` empty unless you know you need one — the desktop app generates a per-install key under the data directory (`master.key`).

Pull a local model (either is fine):

```bash
ollama pull qwen2.5:14b
ollama pull gpt-oss:20b   # optional
ollama pull nomic-embed-text
```

Ollama should already be running (`ollama serve`). If port `11434` is in use, another Ollama process is already up — that is OK.

## 2. Database

```bash
npm run db:migrate
npm run db:seed
```

## 3. Run it (pick one)

### Daily use (recommended)

**Windows:**

```powershell
npm run package:app
npm run shortcut
```

Open **Second Brain** from the Desktop shortcut.

**macOS** (build on a Mac):

```bash
npm run package:app
# Optional: generate full icon set including .icns
# npm run tauri icon path/to/icon-1024.png -w @second-brain/desktop
```

Open `Second Brain.app` (drag to `/Applications` if you like). Grant **Accessibility** when prompted so window titles and on-screen text capture work. See [scripts/macos-signing.md](scripts/macos-signing.md) if Gatekeeper blocks the app.

The app starts the local core, floating widget, and PC capture. You should not need extra terminals.

### Engineers iterating on the UI

```bash
npm start
```

This starts core (API + static UI) for development. The product path is still the desktop app.

## 4. Optional connections

All of these are **read-only**. Tokens never leave this machine except to the provider you chose.

| Connection | Where |
|------------|--------|
| Gmail / Calendar | Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, then connect from the widget menu |
| GitHub | Fine-grained PAT with read-only scopes, or Settings |
| Voice (Cartesia) | Settings → Voice — STT/TTS only; answers stay local unless you enable a cloud Ask model |
| Cloud Ask model | Settings → Ask model — OpenAI / Groq / OpenRouter compatible. Loops still run on Ollama |
| MCP tools | Settings → MCP servers — third-party servers the advisor can call **read-only** |

Google OAuth redirect must be `http://127.0.0.1:3456/oauth/callback`.

## 5. Check it is healthy

With the app (or core) running:

- Widget: `http://127.0.0.1:3000/widget`
- Full dashboard: `http://127.0.0.1:3000/`
- Health: `http://127.0.0.1:3000/api/health` (needs the local API token the core writes)

`ollama.ok` should be true and list your pulled models.

## Privacy notes

- Runtime DB, spool, and `secrets.enc.json` live under the OS data directory above, never in this git repo
- Windows: OCR bitmaps are not saved. macOS: Accessibility text (no screenshots). Text is purged after 30 days by default
- The HTTP API binds to `127.0.0.1` only

## Next

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to send a change
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards
- [SECURITY.md](SECURITY.md) — how to report a vulnerability
- [README.md](README.md) — architecture map
- [scripts/macos-signing.md](scripts/macos-signing.md) — macOS signing / Accessibility
