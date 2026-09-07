#!/usr/bin/env bash
# Linux dev fallback: run the Tauri shell against the workspace (mirrors run-desktop.cmd).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run tauri dev -w @second-brain/desktop
