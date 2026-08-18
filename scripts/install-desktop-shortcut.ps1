# Creates a Desktop shortcut that opens Second Brain as a desktop app (one click).
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Desktop = [Environment]::GetFolderPath("Desktop")
$LnkPath = Join-Path $Desktop "Second Brain.lnk"
$Icon = Join-Path $Root "apps\desktop\src-tauri\icons\icon.ico"

$ExeRelease = Join-Path $Root "apps\desktop\src-tauri\target\release\second-brain-desktop.exe"
$ExeDebug = Join-Path $Root "apps\desktop\src-tauri\target\debug\second-brain-desktop.exe"
$Vbs = Join-Path $PSScriptRoot "Second Brain.vbs"

$Wsh = New-Object -ComObject WScript.Shell
$Lnk = $Wsh.CreateShortcut($LnkPath)

if (Test-Path $ExeRelease) {
  $Lnk.TargetPath = $ExeRelease
  $Lnk.WorkingDirectory = (Split-Path $ExeRelease)
  $Lnk.Arguments = ""
  Write-Host "Shortcut points at RELEASE exe"
}
elseif (Test-Path $ExeDebug) {
  $Lnk.TargetPath = $ExeDebug
  $Lnk.WorkingDirectory = (Split-Path $ExeDebug)
  $Lnk.Arguments = ""
  Write-Host "Shortcut points at DEBUG exe"
}
else {
  $Lnk.TargetPath = "wscript.exe"
  $Lnk.Arguments = "`"$Vbs`""
  $Lnk.WorkingDirectory = $Root
  Write-Host "No .exe yet - shortcut uses Second Brain.vbs"
  Write-Host "Build with: npm run package:app"
}

$Lnk.WindowStyle = 7
$Lnk.Description = "Second Brain - one-click local memory widget"
if (Test-Path $Icon) {
  $Lnk.IconLocation = "$Icon,0"
}
$Lnk.Save()

Write-Host "Desktop shortcut:"
Write-Host "  $LnkPath"
Write-Host "Double-click Second Brain - no npm commands required."
