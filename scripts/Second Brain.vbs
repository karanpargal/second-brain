' One-click launch: start Second Brain desktop app only.
' The .exe starts core + widget + capture. No npm, no browser.
Option Explicit

Dim sh, fso, dir, root, exeRelease, exeDebug, cmd, script

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(dir)

exeRelease = root & "\apps\desktop\src-tauri\target\release\second-brain-desktop.exe"
exeDebug = root & "\apps\desktop\src-tauri\target\debug\second-brain-desktop.exe"

If fso.FileExists(exeRelease) Then
  sh.Run """" & exeRelease & """", 1, False
  WScript.Quit 0
End If

If fso.FileExists(exeDebug) Then
  sh.Run """" & exeDebug & """", 1, False
  WScript.Quit 0
End If

' Dev fallback: cargo-built missing — still start core + try cargo run of desktop (hidden helper)
script = fso.BuildPath(dir, "start-app.mjs")
cmd = "cmd /c cd /d """ & root & """ && node """ & script & """"
sh.Run cmd, 0, False
