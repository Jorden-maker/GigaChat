@echo off
rem ============================================================
rem Запуск OCR-сервера в одно нажатие.
rem Двойной клик по start.bat -- открывает окно с логами сервера.
rem Закрытие окна -- останавливает сервер.
rem
rem Что нужно перед запуском:
rem   1. install-offline.ps1 уже выполнен (есть папка venv рядом).
rem   2. Модели EasyOCR лежат по пути OCR_EASYOCR_DIR ниже
rem      (либо их можно не указывать -- тогда возьмётся ~/.EasyOCR).
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

rem -- Put' k modeljam EasyOCR (~150 MB).
rem    Esli ostav'sja pustoj -- voz'mjotsja ~/.EasyOCR/model/
set OCR_EASYOCR_DIR=C:\models\easyocr

rem -- Jazyki dlja raspoznavanija (cherez zapjatuju, bez probelov)
set OCR_LANGS=ru,en

rem -- Port servera (zashit v workflow http://localhost:8055/extract)
set OCR_PORT=8055

if not "%OCR_EASYOCR_DIR%"=="" if not exist "%OCR_EASYOCR_DIR%" (
    echo.
    echo PREDUPREZHDENIE: papka modelej EasyOCR ne najdena po puti %OCR_EASYOCR_DIR%
    echo Skachaj modeli, polozhi tuda, ili pomeniaj peremennuyu OCR_EASYOCR_DIR
    echo v etom fajle. PDF s tekstom budet rabotat' bez modelej, no skany --
    echo upadut s 503 oshibkoj.
    echo.
)

echo.
echo === Zapusk OCR-servera ===
echo Port:        %OCR_PORT%
echo Langs:       %OCR_LANGS%
echo EasyOCR dir: %OCR_EASYOCR_DIR%
echo Endpoint:    http://localhost:%OCR_PORT%/extract
echo Image-only:  http://localhost:%OCR_PORT%/extract/image
echo Status:      http://localhost:%OCR_PORT%/status
echo Stop:        Ctrl+C ili zakroj eto okno
echo ===========================
echo.

python server.py

rem Esli server upal -- okno ne zakryvaetsya srazu, vidno oshibku.
pause
