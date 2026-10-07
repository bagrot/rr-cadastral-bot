@echo off
title RR Cadastral Bot - check

echo ==========================================
echo   RR Cadastral Bot - environment check
echo ==========================================
echo.

echo [1/5] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  echo Install Node.js LTS from https://nodejs.org/
  goto END
)
node --version
echo.

echo [2/5] Checking npm...
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. It usually comes with Node.js.
  goto END
)
npm --version
echo.

echo [3/5] Checking dependencies...
if exist node_modules\playwright-core (
  echo OK: playwright-core found.
) else (
  echo Dependencies not found. Running npm install...
  call npm.cmd install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    goto END
  )
)
echo.

echo [4/5] Checking Chrome remote debugging port 9222...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3; if ($r.StatusCode -eq 200) { Write-Host 'OK: Chrome is responding on 9222.'; exit 0 } else { Write-Host 'ERROR: Chrome returned non-200.'; exit 1 } } catch { Write-Host 'ERROR: Chrome is not responding on 9222.'; Write-Host 'Start Chrome with:'; Write-Host '\"C:\Program Files\Google\Chrome\Application\chrome.exe\" --remote-debugging-port=9222 --user-data-dir=\"C:\chrome-remote\"'; exit 1 }"
if errorlevel 1 goto END
echo.

echo [5/5] Checking bot syntax...
node --check start.js
if errorlevel 1 (
  echo ERROR: start.js syntax check failed.
  goto END
)
echo.

echo ==========================================
echo   All checks passed.
echo   You can run run-full.bat
echo ==========================================

:END
echo.
pause
