@echo off
title Social Dashboard - connect Pinterest
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)

echo.
echo This links the Serfis Pinterest business account to the dashboard and saves the refresh token to .env.local.
echo Make sure PINTEREST_APP_ID and PINTEREST_APP_SECRET are filled in first.
echo.
call npm run pinterest:auth
echo.
echo Done. Run "Restart Dashboard.bat" to load the new token.
pause
