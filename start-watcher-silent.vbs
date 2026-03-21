Dim objShell, scriptDir
Set objShell = WScript.CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
objShell.Run "node """ & scriptDir & "auto-rename.js""", 0, False
Set objShell = Nothing
