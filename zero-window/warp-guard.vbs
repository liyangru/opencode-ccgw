' warp-guard.vbs -- run warp-guard.ps1 with no console window (no flash every 10 min).
' Registered by zero-window\setup.ps1 as the ccgw-warp-guard scheduled task.
' Logs: zero-window\warp-guard.log
Set fso = CreateObject("Scripting.FileSystemObject")
zw = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & zw & "\warp-guard.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, False
