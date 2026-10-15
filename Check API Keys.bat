@echo off
title Social Dashboard - check API keys
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)

rem Same check as the dashboard's "API connections" panel: which keys work,
rem which are missing or expired, and how many days each has left.
call npm run --silent keys:check
echo.
echo After fixing a key in .env.local, run "Restart Dashboard.bat", and copy the
echo same value into Vercel - Settings - Environment Variables for the live site.
pause
