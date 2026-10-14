@echo off
title Social Dashboard - stop
cd /d "%~dp0"

rem Stops the dev server (port 5173) and the production preview (port 4173),
rem whichever is running, and closes the console windows they were started in.
rem Safe to run when nothing is running.

set STOPPED=0

call :stopport 5173 "dev server"
call :stopport 4173 "production preview"

rem Close the leftover "cmd /k" windows opened by Start Dashboard.bat / Build and Preview.bat.
taskkill /FI "WINDOWTITLE eq Social Dashboard - vite*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Social Dashboard - preview*" /T /F >nul 2>&1

echo.
if %STOPPED%==0 (
  echo Nothing was running on ports 5173 or 4173.
) else (
  echo Dashboard hosting stopped.
)
ping -n 4 127.0.0.1 >nul
exit /b 0

:stopport
rem %1 = port, %2 = label. Finds the process listening on the port, walks up through
rem the npm/node/cmd chain that launched it (stopping before any unrelated window),
rem and kills that whole tree so the "cmd /k npm run ..." window closes too.
powershell -NoProfile -Command "$ErrorActionPreference = 'SilentlyContinue'; $pids = Get-NetTCPConnection -LocalPort %1 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique; if (-not $pids) { exit 3 }; foreach ($id in $pids) { $top = $id; $cur = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); while ($cur) { $par = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cur.ParentProcessId); if ($par -and $par.ProcessId -ne $cur.ProcessId -and ($par.Name -eq 'cmd.exe' -or $par.Name -eq 'node.exe') -and $par.CommandLine -match 'npm|vite') { $top = $par.ProcessId; $cur = $par } else { break } }; taskkill /PID $top /T /F | Out-Null }; exit 0"
if errorlevel 3 (
  echo Port %1: no %~2 running.
) else if errorlevel 1 (
  echo Port %1: could not stop the %~2. Close its window manually.
) else (
  echo Port %1: %~2 stopped.
  set STOPPED=1
)
exit /b 0
