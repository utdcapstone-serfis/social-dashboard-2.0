@echo off
title Social Dashboard - set X account
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)

echo.
echo This looks up the numeric id of the X / Twitter account to track and saves it
echo to .env.local as X_USER_ID. X_BEARER_TOKEN must already be filled in.
echo.
set /p XHANDLE=X handle to track (without the @): 
if "%XHANDLE%"=="" (
  echo No handle entered.
  pause
  exit /b 1
)
call npm run x:id -- %XHANDLE%
echo.
echo Done. Run "Restart Dashboard.bat" to load it, and add X_USER_ID to Vercel too.
pause
