@echo off
title Social Dashboard - connect Snapchat
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)

echo.
echo This links the Serfis Snapchat ad account (Marketing API) and saves the
echo refresh token to .env.local.
echo Make sure SNAPCHAT_CLIENT_ID, SNAPCHAT_CLIENT_SECRET and SNAPCHAT_AD_ACCOUNT_ID
echo are filled in first.
echo.
call npm run snapchat:auth

echo.
echo Done. Run "Restart Dashboard.bat" to load the new token, and copy the
echo SNAPCHAT_* values into Vercel.
pause
