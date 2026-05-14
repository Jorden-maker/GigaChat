# =============================================================================
# Готовит оффлайн-бандл для установки table-merger на ПК без интернета.
#
# КОГДА запускать: на ДОМАШНЕМ ПК (или любом ПК с интернетом).
# ЧТО делает: скачивает все нужные Python-пакеты (~15 MB) в подпапку ./wheels,
#             затем упаковывает в wheels.zip для удобного переноса.
# КУДА везти: после успешного завершения возьми всю папку table-merger (с
#             wheels.zip или с подпапкой wheels) на флешку → офисный ПК.
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
Write-Host "==> Скачивание всех зависимостей в ./wheels (~15 MB)..."
Write-Host "    Это займёт 1-3 минуты в зависимости от интернета."
Write-Host ""

python -m pip download `
    -r requirements.txt `
    -d wheels

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ОШИБКА: не удалось скачать зависимости." -ForegroundColor Red
    Write-Host "Проверь интернет и попробуй заново."
    exit 1
}

$wheelCount = (Get-ChildItem -Path "wheels" -Filter "*.whl").Count + (Get-ChildItem -Path "wheels" -Filter "*.tar.gz").Count
$wheelsSize = "{0:N1}" -f ((Get-ChildItem -Path "wheels" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB)

Write-Host ""
Write-Host "==> Упаковка wheels в wheels.zip для переноса..."
if (Test-Path "wheels.zip") { Remove-Item "wheels.zip" -Force }
# Упаковываем САМУ папку wheels (а не её содержимое через wheels\*),
# чтобы при Expand-Archive на офисном ПК внутри zip была папка wheels\
# со всеми .whl внутри. Иначе install-offline.ps1 не найдёт папку и упадёт.
Compress-Archive -Path "wheels" -DestinationPath "wheels.zip"
$zipSize = "{0:N1}" -f ((Get-Item "wheels.zip").Length / 1MB)

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ГОТОВО" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " Скачано пакетов: $wheelCount"
Write-Host " Размер папки wheels: $wheelsSize MB"
Write-Host " Размер wheels.zip:   $zipSize MB"
Write-Host ""
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host " 1. Скопируй на флешку всю папку table-merger (вместе с"
Write-Host "    wheels.zip — папку wheels можно не брать)."
Write-Host " 2. На офисном ПК запусти install-offline.ps1 из этой папки."
Write-Host "    install-offline.ps1 сам распакует wheels.zip и поставит зависимости."
Write-Host "============================================================="  -ForegroundColor Green
