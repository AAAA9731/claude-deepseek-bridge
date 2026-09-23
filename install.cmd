@echo off
rem Install / update skills for Claude Code and Codex, plus shared dsb / dsv commands.
rem Extra args pass through (e.g. -Target Codex, -Uninstall).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
