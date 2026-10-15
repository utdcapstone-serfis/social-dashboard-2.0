@echo off
title Social Dashboard - dev server
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Is Node.js installed?
    pause
    exit /b 1
  )
)

if not exist .env.local (
  echo.
  echo WARNING: .env.local not found. Every platform will show demo data.
  echo Copy .env.example to .env.local and fill in the META_*, YOUTUBE_*, TIKTOK_*, X_*, PINTEREST_* and BLUESKY_* values.
  echo.
) else (
  findstr /R /C:"^META_ACCESS_TOKEN=." .env.local >nul || echo WARNING: META_ACCESS_TOKEN is empty in .env.local - Instagram/Facebook will show mock data.
  findstr /R /C:"^YOUTUBE_REFRESH_TOKEN=." .env.local >nul || echo WARNING: YOUTUBE_REFRESH_TOKEN is empty in .env.local - YouTube will show mock data.
  findstr /R /C:"^TIKTOK_REFRESH_TOKEN=." .env.local >nul || echo WARNING: TIKTOK_REFRESH_TOKEN is empty in .env.local - TikTok will show mock data. Run: npm run tiktok:auth
  findstr /R /C:"^X_BEARER_TOKEN=." .env.local >nul || echo WARNING: X_BEARER_TOKEN is empty in .env.local - Twitter/X will show mock data.
  findstr /R /C:"^X_USER_ID=." /C:"^X_USERNAME=." .env.local >nul || echo WARNING: X_USER_ID is empty in .env.local - Twitter/X will show mock data. Run "Set X Account.bat".
  findstr /R /C:"^PINTEREST_REFRESH_TOKEN=." .env.local >nul || echo WARNING: PINTEREST_REFRESH_TOKEN is empty in .env.local - Pinterest will show mock data. Run "Connect Pinterest.bat".
  findstr /R /C:"^BLUESKY_HANDLE=." .env.local >nul || echo WARNING: BLUESKY_HANDLE is empty in .env.local - Bluesky will show mock data.
  echo Expired or expiring keys show up in the dashboard's API connections panel, or run "Check API Keys.bat".
)

rem If a server is already listening on 5173, just open the browser instead of failing on --strictPort.
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('localhost',5173)).Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo A server is already running on http://localhost:5173 - opening it.
  echo Run "Restart Dashboard.bat" if you changed .env.local, or "Stop Dashboard.bat" to stop it.
  goto ready
)

echo Starting the dev server on http://localhost:5173 ...
start "Social Dashboard - vite" cmd /k npm run dev -- --port 5173 --strictPort

rem Wait until the server answers, then open the browser.
set /a tries=0
:waitloop
set /a tries+=1
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('localhost',5173)).Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 goto ready
if %tries% geq 30 (
  echo Server did not start within 30 seconds. Check the other window for errors.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitloop

:ready
start "" "http://localhost:5173/social-dashboard/"
echo Dashboard opened. Run "Stop Dashboard.bat" to stop hosting, or "Restart Dashboard.bat" after editing .env.local.
ping -n 4 127.0.0.1 >nul
