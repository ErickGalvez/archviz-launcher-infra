' Runs the .bat file passed as the first argument with no visible console
' window, and waits for it to exit. Used by Task Scheduler so the ArchViz
' listener and tunnel can run in the background with nothing on screen.
Set objShell = CreateObject("WScript.Shell")
objShell.Run Chr(34) & WScript.Arguments(0) & Chr(34), 0, True
