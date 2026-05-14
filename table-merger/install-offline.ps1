# =============================================================================
# Устанавливает сервис объединения таблиц на офисном ПК БЕЗ ИНТЕРНЕТА
# из локальных wheel-файлов.
#
# КОГДА запускать: на ОФИСНОМ ПК.
# ЧТО нужно: рядом со скриптом должны лежать requirements.txt, server.py
#            и ЛИБО папка wheels с .whl-файлами, ЛИБО файл wheels.zip
#            (см. make-offline-bundle.ps1 или скачай wheels.zip из GitHub Releases).
# ЧТО делает: при необходимости распаковывает wheels.zip, создаёт venv,
#             ставит все зависимости из ./wheels БЕЗ интернета.
#
# Требования: Python 3.10-3.12 в PATH.
# =============================================================================

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

Write-Host "==> Проверка Python..."
$pythonVersion = python --version 2>&1
Write-Host "    $pythonVersion"

# Если есть wheels.zip и нет папки wheels — автоматически распаковываем
if ((Test-Path "wheels.zip") -and (-not (Test-Path "wheels"))) {
    Write-Host ""
    Write-Host "==> Найден wheels.zip — распаковываю в папку wheels..."
    Expand-Archive -Path "wheels.zip" -DestinationPath . -Force
    if (Test-Path "wheels") {
        Write-Host "    Распаковка завершена."
    } else {
        Write-Host "ОШИБКА: распаковка не создала папку wheels." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "==> Проверка файлов бандла..."
$missing = @()
if (-not (Test-Path "requirements.txt")) { $missing += "requirements.txt" }
if (-not (Test-Path "server.py"))        { $missing += "server.py" }
if (-not (Test-Path "wheels"))           { $missing += "wheels/ (папка с .whl-файлами) ИЛИ wheels.zip" }

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "ОШИБКА: в текущей папке не хватает файлов:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  - $m" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Скопируй всю папку table-merger (с wheels.zip или с подпапкой wheels) с флешки целиком."
    exit 1
}

$wheelCount = (Get-ChildItem -Path "wheels" -Filter "*.whl").Count
Write-Host "    requirements.txt: OK"
Write-Host "    server.py:        OK"
Write-Host "    wheels:           $wheelCount .whl файлов"

if ($wheelCount -lt 6) {
    Write-Host ""
    Write-Host "ВНИМАНИЕ: в wheels всего $wheelCount пакетов — обычно их 15+." -ForegroundColor Yellow
    Write-Host "Возможно, бандл не до конца собрался дома. Продолжаю на свой риск..."
}

if (Test-Path "venv") {
    Write-Host ""
    Write-Host "Виртуальное окружение уже существует. Удаляю и создаю заново..."
    Remove-Item -Recurse -Force "venv"
}

Write-Host ""
Write-Host "==> Создание виртуального окружения..."
python -m venv venv

Write-Host ""
Write-Host "==> Активация..."
& ".\venv\Scripts\Activate.ps1"

Write-Host ""
Write-Host "==> Установка зависимостей из локальных wheels (без интернета)..."
python -m pip install --no-index --find-links=wheels --upgrade pip
python -m pip install --no-index --find-links=wheels -r requirements.txt

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ОШИБКА установки. Возможные причины:" -ForegroundColor Red
    Write-Host "  - в wheels не хватает какого-то пакета" -ForegroundColor Red
    Write-Host "  - версия Python на этой машине отличается от той, где собирался бандл" -ForegroundColor Red
    Write-Host "  - архитектура отличается (например, бандл собирался на ARM, а тут x86)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " УСТАНОВКА УСПЕШНА" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host ""
Write-Host " 1. Запусти сервис двойным кликом по start.bat" -ForegroundColor Cyan
Write-Host "    либо командой:"
Write-Host "      python server.py" -ForegroundColor Cyan
Write-Host ""
Write-Host " 2. В новом окне PowerShell проверь что отвечает:"
Write-Host "      curl http://localhost:8082/health" -ForegroundColor Cyan
Write-Host "============================================================="  -ForegroundColor Green
