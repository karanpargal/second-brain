# Agent instructions

Follow [CLAUDE.md](./CLAUDE.md) and [`.cursor/rules/one-click-desktop.mdc`](.cursor/rules/one-click-desktop.mdc).

**Always treat the Tauri desktop app as the only end-user entrypoint** (Windows `.exe` or macOS `.app`). Never leave the product in a state where the user must start multiple npm processes.
