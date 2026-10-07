@echo off
chcp 65001 >nul
title RR Cadastral Bot - проверка запуска

echo ==========================================
echo   Проверка окружения RR Cadastral Bot
echo ==========================================
echo.

echo [1/5] Проверяю Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo ОШИБКА: Node.js не найден.
  echo Установите Node.js LTS: https://nodejs.org/
  goto END
)
node --version
echo.

echo [2/5] Проверяю npm...
where npm >nul 2>nul
if errorlevel 1 (
  echo ОШИБКА: npm не найден. Обычно он ставится вместе с Node.js.
  goto END
)
npm --version
echo.

echo [3/5] Проверяю зависимости...
if exist node_modules\playwright-core (
  echo OK: playwright-core найден локально.
) else (
  echo ВНИМАНИЕ: node_modules\playwright-core не найден.
  echo Пробую установить зависимости через npm install...
  call npm.cmd install
  if errorlevel 1 (
    echo ОШИБКА: npm install не прошел.
    goto END
  )
)
echo.

echo [4/5] Проверяю Chrome remote debugging порт 9222...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3; if ($r.StatusCode -eq 200) { Write-Host 'OK: Chrome отвечает на 9222.'; exit 0 } else { Write-Host 'ОШИБКА: Chrome ответил не 200.'; exit 1 } } catch { Write-Host 'ОШИБКА: Chrome не отвечает на 9222.'; Write-Host 'Запустите Chrome так:'; Write-Host '\"C:\Program Files\Google\Chrome\Application\chrome.exe\" --remote-debugging-port=9222 --user-data-dir=\"C:\chrome-remote\"'; exit 1 }"
if errorlevel 1 goto END
echo.

echo [5/5] Проверяю синтаксис бота...
node --check start.js
if errorlevel 1 (
  echo ОШИБКА: start.js не проходит проверку.
  goto END
)
echo.

echo ==========================================
echo   Все проверки прошли успешно.
echo   Можно запускать запуск-бота.bat
echo ==========================================

:END
echo.
pause
