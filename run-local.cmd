@echo off
REM GISEC Arena - Windows launcher.
REM Double-click this, or run it from cmd / PowerShell. It is a thin wrapper:
REM all the logic is in start.mjs, which is the same file Linux and macOS run.
setlocal

REM UTF-8, so the box-drawing characters and the arrows in the launcher output
REM are readable rather than mojibake - and so a redirected log opens correctly
REM in Notepad. Silent if the console does not support it.
chcp 65001 >nul 2>nul

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or not on PATH.
  echo   Get it from https://nodejs.org  ^(version 18 or newer^), then run this again.
  echo.
  pause
  exit /b 1
)

node start.mjs %*

REM Capture the exit code BEFORE pause. `pause` succeeds, so it used to
REM overwrite ERRORLEVEL and this script reported success whatever happened -
REM including a bad --port, a port already in use, or a Node that is too old.
REM Anything running this from a Scheduled Task or a wrapper saw a clean 0.
set "rc=%errorlevel%"
if not "%rc%"=="0" (
  echo.
  echo   The launcher exited with code %rc%.
  pause
)
exit /b %rc%
