# =============================================================================
# Готовит оффлайн-бандл для установки сервера эмбеддингов на ПК без интернета.
#
# КОГДА запускать: на ДОМАШНЕМ ПК (или любом ПК с интернетом).
# ЧТО делает: скачивает все нужные Python-пакеты (~3 GB) в подпапку ./wheels.
# КУДА везти: после успешного завершения всю папку embedding-server вместе
#             с подпапкой wheels скопировать на флешку → офисный ПК.
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
Write-Host "==> Скачивание всех зависимостей в ./wheels (~3 GB)..."
Write-Host "    Это займёт 5-15 минут в зависимости от интернета."
Write-Host ""

# Используем CPU-вариант torch — он работает на любом ПК (с GPU или без),
# CUDA-вариант на 1.5 GB больше и без видеокарты бесполезен.
python -m pip download `
    -r requirements.txt `
    -d wheels `
    --extra-index-url https://download.pytorch.org/whl/cpu

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ОШИБКА: не удалось скачать зависимости." -ForegroundColor Red
    Write-Host "Проверь интернет и попробуй заново."
    exit 1
}

$wheelCount = (Get-ChildItem -Path "wheels" -Filter "*.whl").Count + (Get-ChildItem -Path "wheels" -Filter "*.tar.gz").Count
$wheelsSize = "{0:N1}" -f ((Get-ChildItem -Path "wheels" -Recurse | Measure-Object -Property Length -Sum).Sum / 1GB)

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ГОТОВО" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " Скачано пакетов: $wheelCount"
Write-Host " Размер папки wheels: $wheelsSize GB"
Write-Host ""
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host " 1. Скопируй на флешку всю папку embedding-server (вместе"
Write-Host "    с подпапкой wheels) — это и есть оффлайн-бандл."
Write-Host " 2. Также возьми с собой папку с моделью multilingual-e5-large"
Write-Host "    (~9 GB), если её ещё нет на офисном ПК."
Write-Host " 3. На офисном ПК запусти install-offline.ps1 из этой же папки."
Write-Host "=============================================================" -ForegroundColor Green
