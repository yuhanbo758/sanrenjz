Option Explicit
Dim shell, fso, folder, helper, settingsFile, text, json, expression, matches, pythonExe, command, pythonMode, pathField
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
helper = folder & "\standalone_launcher.py"
settingsFile = shell.ExpandEnvironmentStrings("%APPDATA%") & "\sanrenjz\settings.json"
If Not fso.FileExists(helper) Or Not fso.FileExists(settingsFile) Then
    MsgBox "Open Sanrenjz and configure Python first.", vbCritical, "Launch failed"
    WScript.Quit 1
End If
Set text = CreateObject("ADODB.Stream")
text.Type = 2
text.Charset = "utf-8"
text.Open
text.LoadFromFile settingsFile
json = text.ReadText
text.Close
' Select only the configured mode; an old interpreter must never replace it.
Set expression = New RegExp
expression.Pattern = """pythonMode""\s*:\s*""(custom|managed)"""
expression.Global = False
Set matches = expression.Execute(json)
If matches.Count = 0 Then
    MsgBox "Open Sanrenjz and select a Python environment first.", vbCritical, "Launch failed"
    WScript.Quit 1
End If
pythonMode = matches(0).SubMatches(0)
If pythonMode = "managed" Then
    pathField = "managedPythonPath"
Else
    pathField = "customPythonPath"
End If
expression.Pattern = """" & pathField & """\s*:\s*""((\\.|[^""\\])*)"""
Set matches = expression.Execute(json)
If matches.Count = 0 Then
    MsgBox "The selected Python path is missing. Open Sanrenjz settings.", vbCritical, "Launch failed"
    WScript.Quit 1
End If
pythonExe = Replace(Replace(matches(0).SubMatches(0), "\\", "\"), "\/", "/")
If pythonExe = "" Or Not fso.FileExists(pythonExe) Then
    MsgBox "The saved Python is unavailable. Open Sanrenjz settings.", vbCritical, "Launch failed"
    WScript.Quit 1
End If
helper = folder & "\standalone_launcher.py"
command = Chr(34) & pythonExe & Chr(34) & " -E " & Chr(34) & helper & Chr(34)
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
    MsgBox "Unable to start Python: " & Err.Description, vbCritical, "Launch failed"
    WScript.Quit 1
End If
