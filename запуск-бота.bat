@echo off
chcp 65001 >nul
title RR Cadastral Bot

echo ==========================================
echo   RR Cadastral Bot
echo   Chrome must be running on port 9222
echo ==========================================
echo.
echo Example Chrome command:
echo "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-remote"
echo.

set /p START_ROW=Введите номер строки Google Sheets, с которой продолжить (например 2): 

if "%START_ROW%"=="" (
  echo Ошибка: номер строки не введен.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не найден. Установите Node.js LTS: https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo Локальные зависимости не найдены. Устанавливаю...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo npm install не прошел.
    pause
    exit /b 1
  )
)

echo.
echo Запуск: node start.js %START_ROW%
echo.
node start.js %START_ROW%

echo.
echo ===== Работа завершена =====
pause
