@echo off
title Social Dashboard - connect Pinterest
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)

echo.
echo Pinterest refresh tokens last 60 days. The dashboard warns 14 days before expiry.
echo.
echo   1  Connect (first time, or the token already expired)
echo   2  Rotate the current token for another 60 days (while it still works)
echo.
choice /C 12 /N /M "Choose 1 or 2: "
if errorlevel 2 goto rotate

echo.
echo This links the Serfis Pinterest business account and saves the refresh token
echo and its expiry date to .env.local.
echo Make sure PINTEREST_APP_ID and PINTEREST_APP_SECRET are filled in first.
echo.
call npm run pinterest:auth
goto done

:rotate
call npm run pinterest:auth -- --refresh

:done
echo.
echo Done. Run "Restart Dashboard.bat" to load the new token, and copy
echo PINTEREST_REFRESH_TOKEN and PINTEREST_REFRESH_TOKEN_EXPIRES_AT into Vercel.
pause
