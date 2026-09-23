@echo off
rem Double-click to install / update claude-deepseek-bridge. Extra args pass through (e.g. -Uninstall).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
