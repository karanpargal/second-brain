# Contributing

Thanks for helping. Second Brain is a local-first Windows desktop agent. Please keep that product law intact. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Product law

**Opening the desktop app is the full product.** Users must not need `npm start`, extra terminals, or a browser for daily use. If a feature requires “first start the API in another window,” the design is wrong — fix the Tauri shell so it owns core lifecycle.

See [CLAUDE.md](CLAUDE.md) and [`.cursor/rules/one-click-desktop.mdc`](.cursor/rules/one-click-desktop.mdc).

## Setup

Follow [GETTING_STARTED.md](GETTING_STARTED.md). You need Node 22+, Ollama, and (for desktop builds) Rust.

```powershell
npm install
npm run typecheck
npm test
```

## How we work

1. Small, reviewable PRs. One concern per PR when you can.
2. Never commit `.env`, `master.key`, `api-token`, `secrets.enc.json`, `*.db`, or capture spool.
3. Do not add personal mailboxes, real Stripe account IDs, home directory paths, or live credentials to fixtures. Use `example.com` / `alice` / `acct_example`.
4. New UI belongs in the widget (`/widget`) and/or the SPA served by core — not a separate website as the primary UX.
5. Background work runs in the core scheduler the desktop process starts.

## Tests

```powershell
npm test                 # evals / vitest
npm run typecheck
```

If you change loop extraction or Ask voice helpers, extend `packages/evals`.

## Code style

- TypeScript for app logic; Rust only in `apps/desktop/src-tauri`
- Match existing naming (`lastRunAt`, `valueJson`, `metaJson`)
- No drive-by refactors in unrelated files

## Pull requests

- Describe **why**, not a file list
- Include a short test plan (widget path, not only the dashboard)
- If you touch capture, loops, or Ask, say what you verified locally (Ollama up, health `apiVersion`, etc.)

## License

By contributing you agree your work is licensed under the [MIT License](LICENSE).
