@echo off
cd /d "%~dp0"

rem Open in VS Code if it is installed, otherwise in File Explorer.
where code >nul 2>&1
if not errorlevel 1 (
  start "" code .
) else (
  start "" explorer .
)
