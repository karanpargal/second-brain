# Desktop always-on notes

The Tauri app (`apps/desktop`) registers Windows autostart via
`tauri-plugin-autostart` on first launch.

## Recommended process layout

1. **Ollama** — already a Windows service/background app.
2. **Node core** — `npm run dev:worker` (API on `127.0.0.1:3847` + cron).
3. **Vite UI** — `npm run dev:web` during development, or `npm run preview -w @second-brain/web` after build.
4. **Desktop tray** — `npm run dev:desktop` (capture + tray + window).

## Production-ish single logon

Task Scheduler → At log on:

```
cmd /c "cd /d C:\path\to\second-brain && npm run brain -- daemon"
cmd /c "cd /d C:\path\to\second-brain && npm run preview -w @second-brain/web"
```

Then run the packaged Tauri binary (or `npm run tauri dev -w @second-brain/desktop`) for capture.

Single-instance is enforced by `tauri-plugin-single-instance`.
Backups run daily via the worker cron (`schedule.backup`).
