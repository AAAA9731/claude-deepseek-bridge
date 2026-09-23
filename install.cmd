@echo off
setlocal
rem Double-click to choose one host. Explicit arguments pass through unchanged.
if not "%~1"=="" goto with_args
echo Install / update skills for:
echo   1. Claude Code
echo   2. Codex
choice /C 12 /N /M "Select [1/2]: "
if errorlevel 3 goto done
if errorlevel 2 (
    set "bridgeTarget=Codex"
) else (
    if errorlevel 1 (set "bridgeTarget=Claude") else (goto done)
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -Target %bridgeTarget%
goto done
:with_args
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
:done
echo.
pause
