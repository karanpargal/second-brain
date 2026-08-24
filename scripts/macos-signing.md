# macOS packaging & signing

## One-click product path

Build on a Mac (Tauri cannot cross-compile from Windows):

```bash
npm install
npm run package:app
```

Open `apps/desktop/src-tauri/target/release/bundle/macos/Second Brain.app` (or the `.dmg` beside it). Drag the `.app` to `/Applications`. Day-to-day: open **Second Brain** — no npm terminals.

## Icons

If the build complains about missing `.icns`, generate the full icon set from a 1024×1024 PNG:

```bash
npm run tauri icon path/to/icon-1024.png -w @second-brain/desktop
```

That writes `icons/icon.icns`, `32x32.png`, `128x128.png`, etc. under `apps/desktop/src-tauri/icons/`. Then add `"icons/icon.icns"` to the `bundle.icon` array in `tauri.conf.json`.

## Accessibility

On first launch the app prompts for **Accessibility**. Without it, window titles and on-screen text capture stay off (browser history still works). Grant in:

**System Settings → Privacy & Security → Accessibility → Second Brain**

Re-signing the app with a different identity resets that grant (macOS keys the permission to the code signature).

## Ad-hoc signing (personal / unsigned builds)

Gatekeeper blocks unsigned apps. For local use:

```bash
codesign --force --deep --sign - "Second Brain.app"
xattr -cr "Second Brain.app"   # clear quarantine if right-click Open still fails
```

Or right-click the `.app` → **Open** the first time.

For distribution, use an Apple Developer ID certificate and notarization.

## Data directory

Runtime data lives at:

`~/Library/Application Support/second-brain/`

(`brain.db`, spool, `api-token`, `master.key`, encrypted secrets.)
