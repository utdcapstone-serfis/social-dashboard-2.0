@echo off
title Social Dashboard - restart
cd /d "%~dp0"

rem Stops any running dev server and starts a fresh one. Use this after editing
rem .env.local, because the server only reads that file when it starts.

echo Stopping...
call "%~dp0Stop Dashboard.bat"
echo.
echo Starting...
call "%~dp0Start Dashboard.bat"
