@echo off
rem ============================================================
rem Запуск embedding-сервера в одно нажатие.
rem Двойной клик по start.bat -- открывает окно с логами сервера.
rem Закрытие окна -- останавливает сервер.
rem
rem Что нужно перед запуском:
rem   1. install-offline.ps1 уже выполнен (есть папка venv рядом).
rem   2. Модель лежит по пути EMBED_MODEL ниже (поправь если другой).
rem ============================================================

cd /d "%~dp0"

if not exist "venv\Scripts\activate.bat" (
    echo.
    echo OSHIBKA: papka venv ne najdena.
    echo Snachala vypolni install-offline.ps1 v etoj papke.
    echo.
    pause
    exit /b 1
)

call venv\Scripts\activate.bat

rem -- Put' k modeli. Esli model' lezhit v drugom meste -- popravi stroku nizhe.
set EMBED_MODEL=C:\models\multilingual-e5-large

if not exist "%EMBED_MODEL%" (
    echo.
    echo OSHIBKA: model' ne najdena po puti %EMBED_MODEL%
    echo Polozhi papku multilingual-e5-large po etomu puti
    echo ili popravi peremennuyu EMBED_MODEL v etom fajle.
    echo.
    pause
    exit /b 1
)

echo.
echo === Zapusk embedding-servera ===
echo Model:  %EMBED_MODEL%
echo Port:   8001
echo Stop:   Ctrl+C ili zakroj eto okno
echo ===============================
echo.

python server.py

rem Esli server upal -- okno ne zakryvaetsya srazu, vidno oshibku.
pause
