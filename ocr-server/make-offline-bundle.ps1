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

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ГОТОВО" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host " 1. Скопируй на флешку всю папку ocr-server целиком"
Write-Host "    (с подпапками wheels/ и easyocr_models/)."
Write-Host " 2. На офисном ПК запусти install-offline.ps1 из этой же папки."
Write-Host "=============================================================" -ForegroundColor Green
