@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Desktop runtime is not installed. See README.md.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" "."
