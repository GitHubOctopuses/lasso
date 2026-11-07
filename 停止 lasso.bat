@echo off
rem Stop the lasso server listening on port 8765.
setlocal

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8765 ^| findstr LISTENING') do (
  taskkill /PID %%p /T /F >nul 2>&1
  set FOUND=1
)

if %FOUND%==1 (
  echo lasso stopped.
) else (
  echo lasso is not running.
)
timeout /t 2 /nobreak >nul
endlocal
