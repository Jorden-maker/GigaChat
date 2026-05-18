# =============================================================================
# Устанавливает OCR-сервер на офисном ПК БЕЗ ИНТЕРНЕТА из локальных wheel-файлов.
#
# КОГДА запускать: на ОФИСНОМ ПК.
# ЧТО нужно: рядом со скриптом должны лежать:
#            - requirements.txt
#            - server.py
#            - папка wheels/ (с .whl-файлами) или wheels.zip
#            - папка easyocr_models/ (модели для EasyOCR ~150 MB)
# ЧТО делает:
#   1. При необходимости распаковывает wheels.zip.
#   2. Создаёт venv, ставит зависимости из ./wheels БЕЗ интернета.
#   3. Копирует модели EasyOCR в C:\models\easyocr (или OCR_EASYOCR_DIR).
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
    Write-Host "==> Найден wheels.zip — распаковываю..."
    Expand-Archive -Path "wheels.zip" -DestinationPath . -Force

    if (-not (Test-Path "wheels")) {
        $looseWhls = Get-ChildItem -Filter "*.whl" -File
        if ($looseWhls.Count -gt 0) {
            New-Item -ItemType Directory -Force -Path "wheels" | Out-Null
            foreach ($f in $looseWhls) {
                Move-Item -Path $f.FullName -Destination "wheels\" -Force
            }
        }
    }
}

Write-Host ""
Write-Host "==> Проверка файлов бандла..."
$missing = @()
if (-not (Test-Path "requirements.txt"))   { $missing += "requirements.txt" }
if (-not (Test-Path "server.py"))           { $missing += "server.py" }
if (-not (Test-Path "wheels"))              { $missing += "wheels/ (папка с .whl-файлами) ИЛИ wheels.zip" }
if (-not (Test-Path "easyocr_models"))      { $missing += "easyocr_models/ (модели EasyOCR)" }

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "ОШИБКА: в текущей папке не хватает файлов:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  - $m" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Скопируй всю папку ocr-server (с wheels.zip и easyocr_models) с флешки целиком."
    exit 1
}

$wheelCount = (Get-ChildItem -Path "wheels" -Filter "*.whl").Count
Write-Host "    requirements.txt: OK"
Write-Host "    server.py:        OK"
Write-Host "    wheels:           $wheelCount .whl файлов"
Write-Host "    easyocr_models:   OK"

if ($wheelCount -lt 10) {
    Write-Host ""
    Write-Host "ВНИМАНИЕ: в wheels всего $wheelCount пакетов — обычно их 30+." -ForegroundColor Yellow
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
    Write-Host "  - в wheels не хватает пакета" -ForegroundColor Red
    Write-Host "  - версия Python не совпадает с той, где собирался бандл" -ForegroundColor Red
    Write-Host "  - архитектура отличается (например, ARM vs x86)" -ForegroundColor Red
    exit 1
}

# Копируем модели EasyOCR в стандартное место (C:\models\easyocr).
# Если папка уже существует — не трогаем, чтобы не затирать пользовательские настройки.
$targetModelDir = "C:\models\easyocr"
Write-Host ""
Write-Host "==> Копирование моделей EasyOCR в $targetModelDir..."
if (Test-Path $targetModelDir) {
    $existingFiles = (Get-ChildItem $targetModelDir -Recurse -File).Count
    Write-Host "    Папка уже существует ($existingFiles файлов) — пропускаю."
    Write-Host "    Если нужно переустановить — удали $targetModelDir и запусти заново."
} else {
    New-Item -ItemType Directory -Force -Path $targetModelDir | Out-Null
    Copy-Item -Path "easyocr_models\*" -Destination $targetModelDir -Recurse -Force
    $copiedFiles = (Get-ChildItem $targetModelDir -Recurse -File).Count
    Write-Host "    Скопировано $copiedFiles файлов."
}

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " УСТАНОВКА УСПЕШНА" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host ""
Write-Host " 1. Запусти сервер двойным кликом по:"
Write-Host "      start.bat" -ForegroundColor Cyan
Write-Host ""
Write-Host " 2. В новом окне PowerShell проверь, что отвечает:"
Write-Host "      curl http://localhost:8055/status" -ForegroundColor Cyan
Write-Host ""
Write-Host " 3. Тест извлечения текста из PDF:"
Write-Host "      curl -X POST -F `"file=@some.pdf`" http://localhost:8055/extract" -ForegroundColor Cyan
Write-Host "=============================================================" -ForegroundColor Green
