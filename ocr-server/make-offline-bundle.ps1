# =============================================================================
# Готовит оффлайн-бандл для установки OCR-сервера на ПК без интернета.
#
# КОГДА запускать: на ДОМАШНЕМ ПК (или любом ПК с интернетом).
# ЧТО делает:
#   1. Скачивает все Python-пакеты в подпапку ./wheels (~700 MB с CPU-torch).
#   2. Скачивает модели EasyOCR (~150 MB) в подпапку ./easyocr_models.
# КУДА везти: всю папку ocr-server (вместе с подпапками wheels и easyocr_models)
#             скопировать на флешку → офисный ПК.
#
# Требования: Python 3.10-3.12 в PATH.
# =============================================================================

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

Write-Host "==> Проверка Python..."
$pythonVersion = python --version 2>&1
Write-Host "    $pythonVersion"

Write-Host ""
Write-Host "==> Создание папки wheels..."
New-Item -ItemType Directory -Force -Path "wheels" | Out-Null

Write-Host ""
Write-Host "==> Обновление pip..."
python -m pip install --upgrade pip

Write-Host ""
Write-Host "==> Скачивание Python-пакетов в ./wheels (~700 MB)..."
Write-Host "    Это займёт 5-15 минут в зависимости от интернета."
Write-Host ""

# Используем CPU-вариант torch — он работает на любом ПК.
# CUDA на 1.5 GB больше и без видеокарты бесполезен.
python -m pip download `
    -r requirements.txt `
    -d wheels `
    --extra-index-url https://download.pytorch.org/whl/cpu

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ОШИБКА: не удалось скачать Python-пакеты." -ForegroundColor Red
    exit 1
}

$wheelCount = (Get-ChildItem -Path "wheels" -Filter "*.whl").Count + (Get-ChildItem -Path "wheels" -Filter "*.tar.gz").Count
$wheelsSize = "{0:N1}" -f ((Get-ChildItem -Path "wheels" -Recurse | Measure-Object -Property Length -Sum).Sum / 1GB)
Write-Host ""
Write-Host "    wheels: $wheelCount файлов, $wheelsSize GB"

# ----- Модели EasyOCR -----
Write-Host ""
Write-Host "==> Скачивание моделей EasyOCR (~150 MB)..."
Write-Host "    Модели нужны для распознавания сканов PDF и картинок."

# Создаём временный venv и ставим easyocr туда, чтобы вытащить модели.
# Это нужно потому что EasyOCR качает модели только при первой инициализации,
# и API позволяет указать целевую папку только через model_storage_directory.
$tmpVenv = Join-Path $scriptDir "_tmp_venv"
if (Test-Path $tmpVenv) { Remove-Item -Recurse -Force $tmpVenv }

python -m venv $tmpVenv
& "$tmpVenv\Scripts\Activate.ps1"

# Ставим из локального бандла, чтобы версии совпадали с тем, что поедет в офис
python -m pip install --no-index --find-links=wheels easyocr | Out-Null

New-Item -ItemType Directory -Force -Path "easyocr_models" | Out-Null

# Этот скрипт скачает модели в easyocr_models и закроется
$prefetch = @"
import easyocr, sys
print('Downloading EasyOCR models to easyocr_models/ ...')
r = easyocr.Reader(['ru', 'en'], gpu=False, model_storage_directory='easyocr_models', download_enabled=True, verbose=True)
print('Done.')
"@
$prefetch | python -

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ОШИБКА: не удалось скачать модели EasyOCR." -ForegroundColor Red
    deactivate
    exit 1
}

deactivate
Remove-Item -Recurse -Force $tmpVenv

$modelsSize = "{0:N1}" -f ((Get-ChildItem -Path "easyocr_models" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB)
$modelsCount = (Get-ChildItem -Path "easyocr_models" -Recurse -File).Count
Write-Host "    easyocr_models: $modelsCount файлов, $modelsSize MB"

# ----- Паковка в zip-ы для GitHub Release -----
Write-Host ""
Write-Host "==> Паковка zip-ов для GitHub Release..."

if (Test-Path "ocr-wheels.zip")          { Remove-Item "ocr-wheels.zip" -Force }
if (Test-Path "ocr-easyocr-models.zip")  { Remove-Item "ocr-easyocr-models.zip" -Force }

Compress-Archive -Path "wheels"         -DestinationPath "ocr-wheels.zip"         -CompressionLevel Optimal
Compress-Archive -Path "easyocr_models" -DestinationPath "ocr-easyocr-models.zip" -CompressionLevel NoCompression
# easyocr_models — .pth уже сжатые, повторное сжатие бесполезно и долго

$wheelsZipSize = "{0:N1}" -f ((Get-Item "ocr-wheels.zip").Length / 1MB)
$modelsZipSize = "{0:N1}" -f ((Get-Item "ocr-easyocr-models.zip").Length / 1MB)
Write-Host "    ocr-wheels.zip:         $wheelsZipSize MB"
Write-Host "    ocr-easyocr-models.zip: $modelsZipSize MB"

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ГОТОВО" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " ВАРИАНТ A — выложить как GitHub Release (рекомендуется):"
Write-Host ""
Write-Host "   gh release create v-ocr-N \`" -ForegroundColor Cyan
Write-Host "     ocr-wheels.zip \`" -ForegroundColor Cyan
Write-Host "     ocr-easyocr-models.zip \`" -ForegroundColor Cyan
Write-Host "     --title `"OCR bundle vN`" \`" -ForegroundColor Cyan
Write-Host "     --notes `"Python 3.12, win-x64`"" -ForegroundColor Cyan
Write-Host ""
Write-Host "   Дальше в офисе скачиваешь zip-ы из Releases и кладёшь рядом"
Write-Host "   с install-offline.ps1 — он сам распакует."
Write-Host ""
Write-Host " ВАРИАНТ B — на флешку напрямую:"
Write-Host ""
Write-Host "   Скопируй ocr-wheels.zip и ocr-easyocr-models.zip на флешку"
Write-Host "   вместе с папкой ocr-server. На офисном ПК положи zip-ы рядом"
Write-Host "   с install-offline.ps1 и запусти его — он сам распакует."
Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
