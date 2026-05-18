@echo off
REM ============================================================================
REM Start GigaChat local HTTP server (Caddy) and open dashboard in browser.
REM
REM Double-click this file:
REM   1. Window with Caddy logs opens (listens on http://localhost:8765)
REM   2. After 3 seconds the browser opens with the dashboard
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

REM Detect Yandex Browser preferentially (user can't set it as system default
REM via group policy, but we open it explicitly here). Falls back to default
REM browser if Yandex not found.
set "BROWSER="
if exist "%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER if exist "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=C:\Program Files\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER if exist "C:\Program Files\Application\browser.exe" set "BROWSER=C:\Program Files\Application\browser.exe"

REM Open browser in parallel after 3 sec - Caddy will be up by then.
if defined BROWSER (
    start "" /b cmd /c "timeout /t 3 /nobreak >nul && start """" ""%BROWSER%"" ""http://localhost:8765/"""
) else (
    start "" /b cmd /c "timeout /t 3 /nobreak >nul && start """" ""http://localhost:8765/"""
)

echo ============================================
echo  GigaChat Server
echo  URL: http://localhost:8765/
if defined BROWSER (
    echo  Browser: %BROWSER%
) else (
    echo  Browser: default ^(Yandex not detected^)
)
echo  Close this window to stop the server.
echo ============================================
echo.

REM Run Caddy with explicit full paths. Logs stream to this window.
"%~dp0caddy.exe" run --config "%~dp0Caddyfile"

echo.
echo Caddy stopped.
pause
