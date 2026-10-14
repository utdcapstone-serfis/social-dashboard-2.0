@echo off
title Social Dashboard - connect TikTok
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)

echo.
echo This links the Serfis TikTok account to the dashboard and saves the refresh token to .env.local.
echo Make sure TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are filled in first.
echo.
call npm run tiktok:auth
echo.
echo Done. Run "Restart Dashboard.bat" to load the new token.
pause
