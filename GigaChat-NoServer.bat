@echo off
REM ============================================================================
REM Запуск GigaChat БЕЗ HTTP-сервера — через Chromium-флаг.
REM
REM Альтернатива GigaChat-Start.bat (с Caddy). Открывает дашборд напрямую
REM через file:// в браузере с флагом --allow-file-access-from-files. Этот
REM флаг разрешает fetch() к локальным файлам, без которого Pyodide
REM (math-agent) не загрузился бы.
REM
REM ПРИОРИТЕТ браузеров (изменён 2026-05-26):
REM   1) Yandex Browser  — рекомендован для офиса, надёжный с file://
REM   2) Microsoft Edge  — уже предустановлен, Chromium-новее старого Chrome
REM   3) Google Chrome   — fallback. Старые корпоративные Chrome (<90) могут
REM      падать на file:// — для них РЕКОМЕНДУЕТСЯ GigaChat-Start.bat (Caddy).
REM
REM Запускает в ИЗОЛИРОВАННОМ профиле (своя папка GigaChatBrowserProfile
REM в %USERPROFILE%) — это критично для security: флаг
REM --allow-file-access-from-files не применится к обычным вкладкам.
REM
REM ВАЖНО: в этом окне НЕ открывай посторонние сайты — security ослаблена.
REM ============================================================================

cd /d "%~dp0"
setlocal EnableDelayedExpansion

set "BROWSER="
set "BROWSER_NAME="

REM ========== 1. Yandex Browser ==========
if exist "%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe" (
    set "BROWSER=%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe"
    set "BROWSER_NAME=Yandex"
)
if not defined BROWSER if exist "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe" (
    set "BROWSER=C:\Program Files\Yandex\YandexBrowser\Application\browser.exe"
    set "BROWSER_NAME=Yandex"
)
if not defined BROWSER if exist "C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe" (
    set "BROWSER=C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe"
    set "BROWSER_NAME=Yandex"
)
if not defined BROWSER if exist "C:\Program Files\Application\browser.exe" (
    set "BROWSER=C:\Program Files\Application\browser.exe"
    set "BROWSER_NAME=Yandex"
)

REM ========== 2. Edge (Chromium, стабильнее на корпоративных Windows) ==========
if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Edge"
)
if not defined BROWSER if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Edge"
)

REM ========== 3. Chrome — fallback ==========
if not defined BROWSER if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Chrome"
)
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Chrome"
)
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Chrome"
)
REM Реестровый поиск Chrome — некоторые корпоративные установки кладут exe
REM в нестандартный путь (например через Chocolatey/SCCM).
if not defined BROWSER (
    for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| findstr /i REG_SZ') do (
        if exist "%%B" (
            set "BROWSER=%%B"
            set "BROWSER_NAME=Chrome"
        )
    )
)
if not defined BROWSER (
    for /f "tokens=2,*" %%A in ('reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| findstr /i REG_SZ') do (
        if exist "%%B" (
            set "BROWSER=%%B"
            set "BROWSER_NAME=Chrome"
        )
    )
)

if not defined BROWSER (
    echo.
    echo ERROR: Chromium-based browser not found.
    echo.
    echo Install one of:
    echo   - Yandex Browser (recommended for offline office use)
    echo   - Microsoft Edge (already preinstalled on Windows 10/11)
    echo   - Google Chrome
    echo.
    echo Or use GigaChat-Start.bat for HTTP-server mode ^(works with any browser^).
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0GigaChat-Platform.html" (
    echo.
    echo ERROR: GigaChat-Platform.html not found in %~dp0
    echo This .bat must be in the project root next to GigaChat-Platform.html
    echo.
    pause
    exit /b 1
)

REM Доп. флаги для старых Chrome: снимаем CORS для file:// и блокировку
REM запросов к локальному API (n8n на 5678, Pyodide и т.п.).
set "EXTRA_FLAGS="
if "%BROWSER_NAME%"=="Chrome" (
    set "EXTRA_FLAGS=--disable-features=BlockInsecurePrivateNetworkRequests --disable-site-isolation-trials"
)

echo ============================================
echo  Browser: %BROWSER_NAME%
echo  Path:    %BROWSER%
echo  Profile: %USERPROFILE%\GigaChatBrowserProfile (isolated)
echo  URL:     file:///%~dp0GigaChat-Platform.html
echo ============================================
echo.
if "%BROWSER_NAME%"=="Chrome" (
    echo NOTE: Если страница не открылась или пуста, закрой это окно
    echo       и запусти GigaChat-Start.bat ^(HTTP-сервер Caddy^) — он
    echo       надёжнее на старых корпоративных Chrome.
    echo.
)
echo Opening...

start "" "%BROWSER%" --allow-file-access-from-files --user-data-dir="%USERPROFILE%\GigaChatBrowserProfile" --no-first-run --no-default-browser-check %EXTRA_FLAGS% "file:///%~dp0GigaChat-Platform.html"

endlocal
