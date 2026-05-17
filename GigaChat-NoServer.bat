@echo off
REM ============================================================================
REM Запуск GigaChat БЕЗ HTTP-сервера — через Chromium-флаг.
REM
REM Альтернатива GigaChat-Start.bat (с Caddy). Открывает дашборд напрямую
REM через file:// в браузере с флагом --allow-file-access-from-files. Этот
REM флаг разрешает fetch() к локальным файлам, без которого Pyodide
REM (math-agent) не загрузился бы.
REM
REM Что делает:
REM   1. Ищет Yandex Browser (приоритет — для офиса), потом Chrome
REM   2. Запускает в ИЗОЛИРОВАННОМ профиле (своя папка GigaChatBrowserProfile
REM      в %USERPROFILE%) — это критично для security: флаг
REM      --allow-file-access-from-files не применится к обычным вкладкам
REM      браузера, только к этому окну
REM   3. Открывает дашборд GigaChat-Platform.html
REM
REM ВАЖНО: в этом окне НЕ открывай посторонние сайты — security ослаблена
REM внутри этого профиля (флаг разрешает доступ к локальным файлам со всех
REM file:// страниц). Используй только для GigaChat.
REM
REM Закрытие окна = выход. Никакой сервер не остался работать в фоне.
REM ============================================================================

cd /d "%~dp0"

set "BROWSER="

REM Yandex Browser - предпочтительно для офиса
if exist "%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=%LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe" set "BROWSER=C:\Program Files (x86)\Yandex\YandexBrowser\Application\browser.exe"

REM Chrome - fallback
if not defined BROWSER if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

REM Edge - последний fallback (тоже Chromium, тот же флаг работает)
if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
    echo.
    echo ERROR: Chromium-based browser not found.
    echo Install Yandex Browser, Google Chrome, or Microsoft Edge.
    echo Checked locations:
    echo   %LOCALAPPDATA%\Yandex\YandexBrowser\Application\browser.exe
    echo   C:\Program Files ^(x86^)\Yandex\YandexBrowser\Application\browser.exe
    echo   C:\Program Files\Google\Chrome\Application\chrome.exe
    echo   C:\Program Files ^(x86^)\Google\Chrome\Application\chrome.exe
    echo   %LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
    echo   C:\Program Files ^(x86^)\Microsoft\Edge\Application\msedge.exe
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

echo Browser: %BROWSER%
echo Profile: %USERPROFILE%\GigaChatBrowserProfile (isolated from your main browser)
echo URL: file:///%~dp0GigaChat-Platform.html
echo.
echo Opening...

start "" "%BROWSER%" --allow-file-access-from-files --user-data-dir="%USERPROFILE%\GigaChatBrowserProfile" "file:///%~dp0GigaChat-Platform.html"
