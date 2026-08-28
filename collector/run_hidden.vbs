' Launches run_local.ps1 with no console window at all.
' PowerShell's -WindowStyle Hidden still flashes a console for an instant;
' every 15 minutes that flash is worth avoiding. The scheduled task points
' at this file rather than at powershell.exe directly.

Dim shell, fso, here, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\run_local.ps1"""

' 0 = hidden window, False = do not wait for it to finish
shell.Run command, 0, False
