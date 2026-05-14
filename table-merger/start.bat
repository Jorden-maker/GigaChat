@echo off
rem ============================================================
rem Запуск table-merger в одно нажатие.
rem Двойной клик по start.bat -- открывает окно с логами сервиса.
rem Закрытие окна -- останавливает сервис.
rem
rem Что нужно перед запуском:
rem   1. install-offline.ps1 уже выполнен (есть папка venv рядом).
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

rem -- Port. Po umolchaniyu 8082. Pomenyaj esli zanyat.
set MERGER_PORT=8082

echo.
echo === Zapusk table-merger ===
echo Port:   %MERGER_PORT%
echo Stop:   Ctrl+C ili zakroj eto okno
echo ==========================
echo.

python server.py

rem Esli servis upal -- okno ne zakryvaetsya srazu, vidno oshibku.
pause
