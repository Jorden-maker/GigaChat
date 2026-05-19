@echo off
REM ============================================================================
REM Start GigaChat local HTTP server (Caddy).
REM
REM Double-click this file:
REM   - Window with Caddy logs opens (listens on http://localhost:8765)
REM   - Open the dashboard in any browser: http://localhost:8765/
REM
REM To stop the server - just close this window (or press Ctrl+C).
REM No separate Stop.bat needed - the window IS the running indicator.
REM
REM NOTE 1: This file is ASCII-only on purpose. Windows cmd.exe reads .bat in
REM default OEM codepage (cp866 in RU locale). Cyrillic text in UTF-8 .bat
REM gets mangled into garbage commands before chcp 65001 takes effect.
REM
REM NOTE 2: Caddy and Caddyfile are referenced via %~dp0 (full path) because
REM on some Windows installs the current-directory-in-PATH lookup is disabled
REM for security, and "caddy.exe" alone wouldn't be found even after cd.
REM ============================================================================

cd /d "%~dp0"
title GigaChat Server

if not exist "%~dp0caddy.exe" (
    echo.
    echo ERROR: caddy.exe not found in %~dp0
    echo Download fresh ZIP from GitHub - caddy.exe must be next to this .bat
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0Caddyfile" (
    echo.
    echo ERROR: Caddyfile not found in %~dp0
    echo.
    pause
    exit /b 1
)

echo ============================================
echo  GigaChat Server
echo  ----
echo  URL:  http://localhost:8765/
echo  ----
echo  Open this URL in your browser manually.
echo  Close this window to stop the server.
echo ============================================
echo.

REM Run Caddy with explicit full paths. Logs stream to this window.
"%~dp0caddy.exe" run --config "%~dp0Caddyfile"

echo.
echo Caddy stopped.
pause
