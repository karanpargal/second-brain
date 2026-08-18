@echo off
cd /d "%~dp0.."
call npm run tauri dev -w @second-brain/desktop
