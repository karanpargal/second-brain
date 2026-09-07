#!/usr/bin/env bash
# One-click Linux launcher: install a .desktop entry for Second Brain.
# Points at the built bundle/binary (exe-first, like install-desktop-shortcut.ps1).
# Usage: bash scripts/install-desktop-shortcut.sh [--autostart]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/apps/desktop/src-tauri/target/release"
ICON="$ROOT/apps/desktop/src-tauri/icons/icon.png"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
AUTOSTART=0
[[ "${1:-}" == "--autostart" ]] && AUTOSTART=1

pick_target() {
  local img
  img="$(ls -t "$TARGET"/bundle/appimage/*.AppImage 2>/dev/null | head -n 1 || true)"
  if [[ -n "$img" ]]; then
    printf 'appimage\t%s\n' "$img"
  elif [[ -x "$TARGET/second-brain-desktop" ]]; then
    printf 'bin\t%s\n' "$TARGET/second-brain-desktop"
  elif [[ -x "$ROOT/apps/desktop/src-tauri/target/debug/second-brain-desktop" ]]; then
    printf 'bin\t%s\n' "$ROOT/apps/desktop/src-tauri/target/debug/second-brain-desktop"
  else
    printf 'dev\t%s\n' "$ROOT/scripts/run-desktop.sh"
  fi
}

IFS=$'\t' read -r kind target < <(pick_target)

mkdir -p "$APP_DIR"
DESKTOP="$APP_DIR/second-brain.desktop"
if [[ "$kind" == "dev" ]]; then
  echo "No bundle yet - launcher runs the dev shell until you build (npm run package:app)."
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Second Brain
Comment=Local-first ambient memory widget
Exec=bash "$target"
Icon=$ICON
Terminal=true
Categories=Utility;
StartupWMClass=second-brain-desktop
EOF
else
  echo "Launcher points at: $target"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Second Brain
Comment=Local-first ambient memory widget
Exec="$target"
Icon=$ICON
Terminal=false
Categories=Utility;
StartupWMClass=second-brain-desktop
EOF
fi
chmod +x "$DESKTOP"

if [[ "$AUTOSTART" == 1 ]]; then
  mkdir -p "$AUTOSTART_DIR"
  cp -f "$DESKTOP" "$AUTOSTART_DIR/second-brain.desktop"
  echo "Autostart enabled."
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" || true

echo "Installed: $DESKTOP"
echo "Launch Second Brain from your app menu - no npm commands required."
echo "Note (Wayland): tray icon needs an AppIndicator extension; the widget works without it."
