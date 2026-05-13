# =============================================================================
# Массовый импорт всех workflow из папки Workflow/ в n8n через Public API.
#
# КОГДА запускать: на любом ПК, имеющем HTTP-доступ к n8n.
# ЧТО делает: читает все .json из папки $folder, фильтрует тело до
#             разрешённых API полей (name, nodes, connections, settings)
#             и POST-ит каждый workflow в n8n. Имена workflow берутся из
#             поля "name" внутри JSON.
#
# Требования:
#   - PowerShell 5.1+ (стандартный на Windows 10/11) или PowerShell 7
#   - HTTP-доступ к n8n
#   - API-ключ из n8n: Settings -> API -> Create an API key
#
# Использование:
#   1. Поправь три переменные ниже под свою среду.
#   2. Из PowerShell:  .\import-workflows.ps1
# =============================================================================

# ---- НАСТРОЙКИ ----
$folder = "C:\Users\Lenovo\Desktop\GigaChat\Workflow"   # путь к папке с .json
$n8n    = "http://localhost:5678"                       # URL n8n БЕЗ слеша на конце
$apiKey = ""                                            # вставь сюда API-ключ из n8n
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

Write-Host "==> Импорт $($jsonFiles.Count) workflow в $n8n" -ForegroundColor Cyan
Write-Host ""

$allowed = @('name', 'nodes', 'connections', 'settings')
$ok = 0
$failed = 0

foreach ($file in $jsonFiles) {
    Write-Host "Importing: $($file.Name)" -ForegroundColor Cyan
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
        # settings обязательно, даже если в исходнике пусто
        if (-not $clean.Contains('settings')) {
            $clean['settings'] = @{}
        }

        $body = $clean | ConvertTo-Json -Depth 100 -Compress
        # Конвертим в UTF-8 байты, чтобы кириллица в названиях долетела без искажений
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

        $response = Invoke-RestMethod -Method POST `
            -Uri "$n8n/api/v1/workflows" `
            -Headers @{ "X-N8N-API-KEY" = $apiKey } `
            -ContentType "application/json; charset=utf-8" `
            -Body $bytes

        Write-Host "  OK -> id: $($response.id), name: $($response.name)" -ForegroundColor Green
        $ok++
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
Write-Host " ИТОГ: успешно $ok из $($jsonFiles.Count), ошибок $failed" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host " 1. Обнови страницу n8n (F5) - workflow появятся в списке."
Write-Host " 2. В каждом workflow привяжи credentials (Postgres, GigaChat)"
Write-Host "    к узлам с предупреждением, сохрани и активируй."
Write-Host "=============================================================" -ForegroundColor Green
