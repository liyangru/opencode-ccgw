' net-guard.vbs -- start net-guard.ps1 with no console window (no flash at logon).
' Used by the ccgw-netguard Run key / scheduled task. Logs: net-guard.log
Set fso = CreateObject("Scripting.FileSystemObject")
zw = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & zw & "\net-guard.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, False
