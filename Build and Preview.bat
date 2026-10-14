@echo off
title Social Dashboard - production build
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Is Node.js installed?
    pause
    exit /b 1
  )
)

echo Building production bundle (typecheck + vite build)...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed. See errors above.
  pause
  exit /b 1
)

echo.
echo Build OK. Note: the preview server has no /api routes, so all platforms show mock data.

rem Stop a previous preview so the new build is what gets served.
powershell -NoProfile -Command "$pids = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($id in $pids) { taskkill /PID $id /T /F | Out-Null }"
taskkill /FI "WINDOWTITLE eq Social Dashboard - preview*" /T /F >nul 2>&1

echo Starting preview on http://localhost:4173 ...
start "Social Dashboard - preview" cmd /k npm run preview -- --port 4173 --strictPort

set /a tries=0
:waitloop
set /a tries+=1
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('localhost',4173)).Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 goto ready
if %tries% geq 30 (
  echo Preview server did not start within 30 seconds.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitloop

:ready
start "" "http://localhost:4173/social-dashboard/"
echo Preview opened. Run "Stop Dashboard.bat" to stop it.
ping -n 4 127.0.0.1 >nul
