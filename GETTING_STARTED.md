# Getting started

Second Brain is a **local-first** desktop agent for **Windows, macOS, and Linux**. You install it once; day-to-day you only open the app. Your capture data and secrets stay on this machine.

| OS | Runtime data |
|----|----------------|
| Windows | `%LOCALAPPDATA%\second-brain\` |
| macOS | `~/Library/Application Support/second-brain/` |
| Linux | `~/.local/share/second-brain/` |

## What you need

- Windows 10/11, macOS 12+, **or** any modern Linux distro (incl. NixOS via `nix develop`)
- [Node.js 22–25](https://nodejs.org/) (the desktop shell refuses newer majors: native modules break)
- [Ollama](https://ollama.com/) with at least one chat model
- To build the Tauri app yourself: [Rust](https://rustup.rs/) (+ Visual Studio C++ tools on Windows, Xcode CLT on Mac, webkit2gtk + friends on Linux — see below)

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

**Linux** (any distro):

```bash
# System deps for the Tauri webview + tray (pick your family):
# Debian/Ubuntu:
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev at-spi2-core
# Fedora:
sudo dnf install webkit2gtk4.1-devel openssl-devel libayatana-appindicator-gtk3-devel \
  librsvg2-devel curl wget file gcc at-spi2-core
# Arch:
sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl libayatana-appindicator librsvg at-spi2-core
# Compositor window titles need what you already have:
# Hyprland: hyprctl · Sway: swaymsg · X11: xprop (+ xprintidle for idle time)

npm run package:app       # bundles under apps/desktop/src-tauri/target/release/bundle/
npm run shortcut:linux    # app-menu entry → that bundle; add --autostart to launch at login
```

Packaging per distro (`scripts/build-desktop.mjs` picks automatically):
- Debian/Ubuntu/Fedora/openSUSE: `.deb` + `.rpm` + `.AppImage`.
- Arch-based: `.deb` + `.rpm` only — linuxdeploy's bundled `strip` cannot
  parse Arch's DT_RELR binaries and its GTK plugin assumes gdk-pixbuf
  loaders Arch no longer ships, so the AppImage target always fails there.
  Install natively instead: `makepkg -si` in `packaging/arch/`
  (`second-brain-git`, source build), or run `npm run dev:desktop`.
- The `.AppImage` is built on Ubuntu (see `.github/workflows/linux.yml`,
  which also runs `nix flake check` for the NixOS dev shell).

NixOS cannot install the `.deb`; use the dev shell instead:

```bash
nix develop               # webkitgtk, Node 22, Rust, capture helpers
npm install
npm run db:migrate && npm run db:seed
npm run dev:desktop       # Tauri shell; core + widget + capture start themselves
```

Linux capture notes: foreground window titles work on Hyprland (`hyprctl`), Sway (`swaymsg`), and X11 (`xprop`); browser history covers Chromium-family + Firefox/Zen. On-screen text comes from the AT-SPI accessibility tree (the Linux counterpart to macOS Accessibility) — no screenshots, pixels never touch disk. At startup the app enables the `toolkit-accessibility` key and publishes `org.a11y.Status` (`IsEnabled` + `ScreenReaderEnabled`, released on quit) so GTK/Qt expose their trees; restart apps you want captured after first launch. If the session bus is missing it starts `at-spi-bus-launcher` (also found at `/usr/lib` / `/usr/libexec` outside `PATH`); if the bus name is owned but its socket is dead, it restarts the stale same-user launcher instead of failing open, and re-checks the bus whenever a poll finds no tree. Per-toolkit extras: Chromium/Electron need `--force-renderer-accessibility`, Qt needs `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`. When the focused app exposes no tree, the diagnosed reason is logged once per app to `desktop.log` in the data dir. Fullscreen state is reported on Hyprland/Sway/X11. Titles additionally work on niri (`niri msg`) and stock GNOME (Shell `Eval`); other Wayland compositors fall back to browser history only. The widget menu carries pause/resume/quit, so no tray host is needed. Idle time uses the native source per session: XScreenSaver on X11, Mutter IdleMonitor on GNOME/Cinnamon, ext-idle-notify on wlroots/KDE Wayland. Tray icon needs an AppIndicator extension on Wayland; the widget works without it. `Ctrl+Shift+Space` binds over X11 plus the GlobalShortcuts portal where a backend exists. Where neither reaches (e.g. Hyprland), bind the compositor to the toggle helper instead — it signals the running app, or starts it if it isn't running:

```ini
# Hyprland (hyprland.conf)
bind = CTRL SHIFT, SPACE, exec, second-brain-desktop --toggle
# Sway (config)
bindsym Ctrl+Shift+space exec second-brain-desktop --toggle
```

```kdl
// niri (config.kdl)
binds {
    "Ctrl+Shift+Space" { spawn "second-brain-desktop" "--toggle"; }
}
```

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
