' lasso hidden launcher: run server without any console window, wait until
' ready, then open the browser. Double-click this file to start lasso.
' NOTE: keep this file ASCII-only -- cscript reads ANSI and UTF-8 comments
' can break string parsing on Chinese Windows.
Option Explicit

Const PORT = 8765

Dim sh, fso, base, logPath, started, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lasso\server.log"

Function ServerUp()
  On Error Resume Next
  Dim http
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.open "GET", "http://127.0.0.1:" & PORT & "/api/ping", False
  http.send
  If Err.Number = 0 And http.status = 200 Then
    ServerUp = True
  Else
    ServerUp = False
  End If
  On Error Goto 0
End Function

If Not ServerUp() Then
  ' hidden window (0 = hidden), log to ~/.lasso/server.log
  sh.Run "cmd /c node """ & base & "\server.mjs"" >> """ & logPath & """ 2>&1", 0, False

  started = False
  For i = 1 To 60  ' up to 30 seconds
    WScript.Sleep 500
    If ServerUp() Then
      started = True
      Exit For
    End If
  Next

  If Not started Then
    MsgBox "lasso failed to start." & vbCrLf & _
           "Common cause: Node.js is not installed (https://nodejs.org)." & vbCrLf & _
           "See log for details: " & logPath, 16, "lasso start failed"
    WScript.Quit 1
  End If
End If

' server is ready -- open the UI
sh.Run "http://127.0.0.1:" & PORT & "/"
