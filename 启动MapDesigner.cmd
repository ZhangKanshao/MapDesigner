@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-windows.ps1"
if not errorlevel 1 exit /b 0
pause
exit /b 1
