# =============================================================================
# Массовый импорт / обновление всех workflow из папки Workflow/ в n8n.
#
# Скрипт идемпотентный — можно запускать сколько угодно раз:
#   - workflow с таким же именем уже есть в n8n -> обновляется (PUT)
#   - workflow с таким именем нет               -> создаётся (POST)
# Дубликатов не будет. Привязанные в UI credentials сохраняются при обновлении.
#
# Префикс: все workflow получают одинаковый префикс в имени (например [GigaChat]),
# чтобы визуально группироваться в списке n8n. Если префикс пустая строка ""
# — префиксование отключено.
#
# Если ранее workflow был импортирован без префикса (старая версия скрипта),
# при следующем запуске он будет переименован с добавлением префикса
# (без создания дубля).
#
# КОГДА запускать: после любого изменения .json в папке Workflow/,
#                  чтобы синхронизировать n8n с локальными файлами.
#
# Требования:
#   - PowerShell 5.1+ или PowerShell 7
#   - HTTP-доступ к n8n
#   - API-ключ из n8n: Settings -> API -> Create an API key
#
# Использование:
#   1. Поправь переменные в блоке "НАСТРОЙКИ" ниже под свою среду.
#   2. Из PowerShell:  .\import-workflows.ps1
# =============================================================================

# ---- НАСТРОЙКИ ----
$folder = "C:\Users\Lenovo\Desktop\GigaChat\Workflow"   # путь к папке с .json
$n8n    = "http://localhost:5678"                       # URL n8n БЕЗ слеша на конце
$apiKey = ""                                            # вставь сюда API-ключ из n8n
$prefix = "[GigaChat] "                                 # префикс имени, "" чтобы отключить
# -------------------

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "ОШИБКА: переменная `$apiKey пустая." -ForegroundColor Red
    Write-Host "Создай ключ в n8n: Settings -> API -> Create an API key,"
    Write-Host "вставь его в скрипт в строку `"`$apiKey = ...`"."
    exit 1
}

if (-not (Test-Path $folder)) {
    Write-Host "ОШИБКА: папка не найдена: $folder" -ForegroundColor Red
    exit 1
}

$jsonFiles = Get-ChildItem $folder -Filter "*.json"
if ($jsonFiles.Count -eq 0) {
    Write-Host "ОШИБКА: в папке $folder нет .json файлов" -ForegroundColor Red
    exit 1
}

$headers = @{ "X-N8N-API-KEY" = $apiKey }

# Шаг 1. Получаем список существующих workflow из n8n.
# Нужно для решения «создавать или обновлять»: матчим по полю name.
Write-Host "==> Получаю текущий список workflow из n8n..." -ForegroundColor Cyan
try {
    $list = Invoke-RestMethod -Uri "$n8n/api/v1/workflows?limit=250" -Headers $headers
} catch {
    Write-Host "ОШИБКА: не удалось получить список workflow." -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Проверь `$n8n URL и `$apiKey."
    exit 1
}

# Карта «имя -> id» для уже существующих
# Карта «имя -> id» только для активных workflow.
# Архивированные нельзя обновлять через PUT, поэтому их в карту не кладём —
# скрипт создаст новые active workflow рядом с архивами.
$existing = @{}
$archivedSkipped = 0
foreach ($wf in $list.data) {
    if ($wf.isArchived) {
        $archivedSkipped++
        continue
    }
    $existing[$wf.name] = $wf.id
}
Write-Host "    Найдено активных workflow в n8n: $($existing.Count)"
if ($archivedSkipped -gt 0) {
    Write-Host "    Архивированных (игнорируются): $archivedSkipped" -ForegroundColor DarkGray
}
if ($prefix) {
    Write-Host "    Префикс имени: `"$prefix`""
}
Write-Host ""

Write-Host "==> Синхронизация $($jsonFiles.Count) .json файлов с n8n" -ForegroundColor Cyan
Write-Host ""

$allowed = @('name', 'nodes', 'connections', 'settings')
$created = 0
$updated = 0
$renamed = 0
$failed = 0

foreach ($file in $jsonFiles) {
    Write-Host "Processing: $($file.Name)" -ForegroundColor Cyan
    try {
        $raw = Get-Content $file.FullName -Raw -Encoding UTF8
        $obj = $raw | ConvertFrom-Json

        # Оставляем только разрешённые API поля.
        # Остальные (id, meta, versionId, tags, pinData, active) n8n API отвергает.
        $clean = [ordered]@{}
        foreach ($key in $allowed) {
            if ($obj.PSObject.Properties.Name -contains $key) {
                $clean[$key] = $obj.$key
            }
        }
        if (-not $clean.Contains('settings')) {
            $clean['settings'] = @{}
        }

        # Имя из JSON. Чистим возможный старый префикс, потом добавляем актуальный.
        # Так script идемпотентен: повторный запуск не приведёт к "[GigaChat] [GigaChat] ...".
        $baseName = [string]$clean['name']
        if ($prefix -and $baseName.StartsWith($prefix)) {
            $baseName = $baseName.Substring($prefix.Length)
        }
        $desiredName = if ($prefix) { $prefix + $baseName } else { $baseName }
        $clean['name'] = $desiredName

        $body = $clean | ConvertTo-Json -Depth 100 -Compress
        # Кириллицу — в UTF-8 байты явно, иначе Invoke-RestMethod может побить
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

        # Решение «создавать или обновлять»:
        # 1) Сначала ищем по «желаемому» имени (с префиксом).
        # 2) Если не нашли — ищем по голому имени (без префикса) — это случай миграции
        #    со старой версии скрипта без префикса. Найденный workflow PUT-ится
        #    с новым именем (с префиксом).
        $targetId = $null
        $isRename = $false
        if ($existing.ContainsKey($desiredName)) {
            $targetId = $existing[$desiredName]
        } elseif ($prefix -and $existing.ContainsKey($baseName)) {
            $targetId = $existing[$baseName]
            $isRename = $true
        }

        if ($targetId) {
            $response = Invoke-RestMethod -Method PUT `
                -Uri "$n8n/api/v1/workflows/$targetId" `
                -Headers $headers `
                -ContentType "application/json; charset=utf-8" `
                -Body $bytes
            if ($isRename) {
                Write-Host "  RENAMED -> id: $($response.id), name: $($response.name)" -ForegroundColor Magenta
                $renamed++
            } else {
                Write-Host "  UPDATED -> id: $($response.id), name: $($response.name)" -ForegroundColor Yellow
                $updated++
            }
        } else {
            $response = Invoke-RestMethod -Method POST `
                -Uri "$n8n/api/v1/workflows" `
                -Headers $headers `
                -ContentType "application/json; charset=utf-8" `
                -Body $bytes
            Write-Host "  CREATED -> id: $($response.id), name: $($response.name)" -ForegroundColor Green
            $created++
        }
    } catch {
        Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $stream.Position = 0
                $reader = New-Object System.IO.StreamReader($stream)
                $errBody = $reader.ReadToEnd()
                if ($errBody) { Write-Host "  Server: $errBody" -ForegroundColor Yellow }
            } catch {}
        }
        $failed++
    }
}

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ИТОГ:" -ForegroundColor Green
Write-Host "   создано:           $created" -ForegroundColor Green
Write-Host "   обновлено:         $updated" -ForegroundColor Yellow
if ($renamed -gt 0) {
    Write-Host "   переименовано:     $renamed   (старый workflow без префикса дополнен префиксом)" -ForegroundColor Magenta
}
Write-Host "   ошибок:            $failed" -ForegroundColor $(if ($failed) { 'Red' } else { 'DarkGray' })
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host " 1. Обнови страницу n8n (F5)."
Write-Host " 2. Для НОВЫХ workflow привяжи credentials в узлах и активируй."
Write-Host "    Для ОБНОВЛЁННЫХ / ПЕРЕИМЕНОВАННЫХ — credentials остались,"
Write-Host "    ничего делать не надо."
Write-Host "=============================================================" -ForegroundColor Green
