@echo off
REM ============================================================================
REM Start GigaChat local HTTP server (Caddy) + auto-open browser.
REM
REM Double-click:
REM   - Caddy listens on http://localhost:8765
REM   - Browser auto-opens (priority: Yandex > Edge > Chrome > system default)
REM   - Use this .bat if NoServer.bat didn't work — actual for old corporate
REM     Chrome where file:// is restricted.
REM
REM To stop: close this window (or Ctrl+C). No separate Stop.bat needed.
REM
REM ASCII-only (cmd cp866 in RU locale breaks Cyrillic in .bat).
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

REM ========== Find browser for auto-open ==========
REM Priority: Yandex > Edge > Chrome > system default.
REM HTTP-mode works with ANY browser, no flags needed.
set "BROWSER="

if exist "%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER if exist "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=C:\Program Files\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe"

if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

echo ============================================
echo  GigaChat Server
echo  ----
echo  URL:  http://localhost:8765/
if defined BROWSER (
    echo  Auto-open: %BROWSER%
) else (
    echo  Auto-open: system default browser
)
echo  ----
echo  Close this window to stop the server.
echo ============================================
echo.

REM Auto-open browser after 2 sec (caddy will be listening by then).
REM Use schtasks-style delayed start via a backgrounded cmd.
if defined BROWSER (
    start "" /b cmd /c "timeout /t 2 /nobreak >nul && start \"\" \"%BROWSER%\" \"http://localhost:8765/\""
) else (
    start "" /b cmd /c "timeout /t 2 /nobreak >nul && start \"\" \"http://localhost:8765/\""
)

REM Run Caddy with explicit full paths. Logs stream to this window.
"%~dp0caddy.exe" run --config "%~dp0Caddyfile"

echo.
echo Caddy stopped.
pause
