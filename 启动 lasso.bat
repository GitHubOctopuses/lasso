@echo off
setlocal
cd /d "%~dp0"

rem lasso launcher - ASCII-only content to avoid codepage issues.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org
  pause
  exit /b 1
)

rem If the server is already running, just open the browser again.
curl -s -m 2 -o nul http://127.0.0.1:8765/api/ping
if errorlevel 1 goto startserver
goto open

:startserver
title lasso
start "lasso" /min node "%~dp0server.mjs"

set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
curl -s -m 2 -o nul http://127.0.0.1:8765/api/ping
if not errorlevel 1 goto open
set /a tries+=1
if %tries% lss 20 goto waitloop

echo [ERROR] Server did not start within 20 seconds. Check whether port 8765 is already in use.
pause
exit /b 1

:open
start "" http://127.0.0.1:8765/
endlocal
exit /b 0
