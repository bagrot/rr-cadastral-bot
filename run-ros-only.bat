@echo off
title RR Cadastral Bot - Rosreestr only

echo ==========================================
echo   RR Cadastral Bot - Rosreestr only
echo   Chrome must be running on port 9222
echo ==========================================
echo.
echo Chrome command:
echo "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-remote"
echo.

set /p START_ROW=Enter Google Sheets start row for Rosreestr, for example 176: 

if "%START_ROW%"=="" (
  echo ERROR: start row is empty.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js was not found.
  echo Install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules\playwright-core (
  echo.
  echo Local dependencies were not found. Running npm install...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Running: node start.js %START_ROW% --ros-only
echo.
node start.js %START_ROW% --ros-only

echo.
echo ===== Finished =====
pause
