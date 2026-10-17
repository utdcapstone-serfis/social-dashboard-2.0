@echo off
title Social Dashboard - connect LinkedIn
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)

echo.
echo This links the Serfis LinkedIn Company Page (Community Management API) and
echo saves the refresh token and page id to .env.local.
echo Sign in as an ADMINISTRATOR of the page. LINKEDIN_CLIENT_ID and
echo LINKEDIN_CLIENT_SECRET must be filled in first.
echo LinkedIn refresh tokens last 365 days; the dashboard warns 14 days before.
echo.
call npm run linkedin:auth

echo.
echo Done. Run "Restart Dashboard.bat" to load the new token, and copy the
echo LINKEDIN_* values into Vercel.
pause
