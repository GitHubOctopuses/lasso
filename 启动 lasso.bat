@echo off
rem Recommended entry: double-click the .vbs launcher (fully hidden, no console window).
rem This .bat is the visible-log fallback: it runs the server in a minimized window.
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org
  pause
  exit /b 1
)

curl -s -m 2 -o nul http://127.0.0.1:8765/api/ping
if errorlevel 1 goto startserver
goto open

:startserver
start "lasso" /min node "%~dp0server.mjs"

set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
curl -s -m 2 -o nul http://127.0.0.1:8765/api/ping
if not errorlevel 1 goto open
set /a tries+=1
if %tries% lss 20 goto waitloop

echo [ERROR] Server did not start within 20 seconds. Check the log in your .lasso folder.
pause
exit /b 1

:open
start "" http://127.0.0.1:8765/
endlocal
exit /b 0
