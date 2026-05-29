# =============================================================================
# Массовая активация всех workflow с префиксом [GigaChat] в n8n.
#
# Запускается ПОСЛЕ import-workflows.ps1. Импорт сам по себе не активирует
# workflow — тумблер «Active» в n8n остаётся OFF. Этот скрипт включает его
# для всех workflow с указанным префиксом.
#
# Идемпотентный: уже активные workflow пропускаются (n8n всё равно возвращает
# 200, но скрипт это покажет как «уже активен» без шума).
#
# Использование:
#   1. Поправь $apiKey и $n8n ниже, если отличаются от import-workflows.ps1.
#   2. Обычный режим:
#        .\activate-workflows.ps1
#      Активирует все НЕактивные. Уже активные — пропускает.
#   3. Force-reactivate (после import-workflows.ps1 для подхвата изменений):
#        .\activate-workflows.ps1 -Force
#      Делает deactivate → activate цикл для активных. Нужно когда обновил
#      workflow (URL, webhook path, структуру нод) — иначе n8n может
#      продолжать работать через старый webhook routes в памяти runtime.
#   4. Массовое выключение (для отладки):
#        .\activate-workflows.ps1 -Deactivate
#
# Требования:
#   - PowerShell 5.1+ или PowerShell 7
#   - HTTP-доступ к n8n
#   - API-ключ из n8n (тот же, что у import-workflows.ps1)
# =============================================================================

param(
    [switch]$Deactivate = $false,  # .\activate-workflows.ps1 -Deactivate — массово выключить
    [switch]$Force = $false        # .\activate-workflows.ps1 -Force — перезагрузить активные
                                   # (deactivate → activate цикл). Нужно после import-workflows.ps1,
                                   # чтобы webhook routes гарантированно перерегистрировались.
)

# ---- НАСТРОЙКИ ----
$n8n    = "http://localhost:5678"                       # URL n8n БЕЗ слеша на конце
$apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMWQzMzQ3Ny05MjdlLTQxMGEtYjNiMC0wMWNmOTY2ODgwYmYiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZmY5ZGFiYTctZWZjNi00YjE3LTgxOGUtNDA2ZmYwMjQxOWMwIiwiaWF0IjoxNzc4NzU4ODgxLCJleHAiOjE3ODEzMjMyMDB9.SI7GAu_3y5neIzbam3iYnwDxkF0TMwf3fvixBvOZmls"                                            # вставь API-ключ или возьмёт из credentials-cache.local.json
$prefix = "[GigaChat] "                                 # только workflow с этим префиксом
# -------------------

# ---- OVERRIDE токена/URL из локального кеша (R8.44) ----
# Идентично import-workflows.ps1. Проблема: $apiKey/$n8n захардкожены под
# ДОМАШНЮЮ среду. При git pull в офисе они затирают офисные значения → скрипт
# бьётся в чужой n8n / с протухшим токеном. Решение: офис кладёт свои
# _apiKey/_n8nHost в credentials-cache.local.json (он в .gitignore, pull его
# не трогает), и они ПЕРЕБИВАЮТ хардкод. Дома файла нет/без этих полей →
# берётся хардкод. ВАЖНО: override, а НЕ «заполнить если пусто» — иначе в
# офисе сработает захардкоженный домашний токен и активация упадёт с 401.
$__cachePathEarly = Join-Path $PSScriptRoot "credentials-cache.local.json"
if (Test-Path $__cachePathEarly) {
    try {
        $__c = Get-Content $__cachePathEarly -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($__c._apiKey)  { $apiKey = $__c._apiKey;  Write-Host "API-ключ взят из credentials-cache.local.json (_apiKey)" -ForegroundColor DarkGray }
        if ($__c._n8nHost) { $n8n    = $__c._n8nHost; Write-Host "n8n URL взят из credentials-cache.local.json (_n8nHost): $n8n" -ForegroundColor DarkGray }
    } catch {}
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "ОШИБКА: переменная `$apiKey пустая." -ForegroundColor Red
    Write-Host "Вставь API-ключ из n8n в строку `"`$apiKey = ...`" этого скрипта" -ForegroundColor Yellow
    Write-Host "ИЛИ скопируй его из import-workflows.ps1 (там он уже есть)." -ForegroundColor Yellow
    exit 1
}

$headers = @{ "X-N8N-API-KEY" = $apiKey }

$verb = if ($Deactivate) { "deactivate" } else { "activate" }
$verbRu = if ($Deactivate) { "Деактивация" } else { "Активация" }
$targetState = if ($Deactivate) { $false } else { $true }

Write-Host ""
Write-Host "==> $verbRu workflow с префиксом `"$prefix`" в n8n ($n8n)" -ForegroundColor Cyan
Write-Host ""

# Получаем список всех workflow
try {
    $list = Invoke-RestMethod -Uri "$n8n/api/v1/workflows?limit=250" -Headers $headers
} catch {
    Write-Host "ОШИБКА: не удалось получить список workflow." -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Проверь `$n8n URL и `$apiKey." -ForegroundColor Yellow
    exit 1
}

# Фильтруем по префиксу
$targets = @()
foreach ($wf in $list.data) {
    if ($wf.isArchived) { continue }
    if ($prefix -and -not $wf.name.StartsWith($prefix)) { continue }
    $targets += $wf
}

if ($targets.Count -eq 0) {
    Write-Host "Не найдено ни одного workflow с префиксом `"$prefix`"." -ForegroundColor Yellow
    Write-Host "Сначала запусти import-workflows.ps1 для импорта." -ForegroundColor DarkYellow
    exit 0
}

Write-Host "Найдено $($targets.Count) workflow для обработки." -ForegroundColor Cyan
Write-Host ""

$activated = 0
$reloaded = 0
$alreadyOk = 0
$failed = 0

foreach ($wf in $targets) {
    $name = $wf.name
    $id = $wf.id
    $isActive = [bool]$wf.active

    # Если -Force: всегда переактивируем (deactivate → activate цикл)
    # Это нужно после import-workflows.ps1, чтобы webhook routes
    # n8n гарантированно перерегистрировались — иначе обновлённый workflow
    # может работать через старый webhook в памяти runtime.
    if ($Force -and -not $Deactivate -and $isActive) {
        Write-Host "  - $name ... (reload)" -NoNewline
        try {
            Invoke-RestMethod -Method POST `
                -Uri "$n8n/api/v1/workflows/$id/deactivate" `
                -Headers $headers `
                -ContentType "application/json; charset=utf-8" | Out-Null
            Start-Sleep -Milliseconds 200
            Invoke-RestMethod -Method POST `
                -Uri "$n8n/api/v1/workflows/$id/activate" `
                -Headers $headers `
                -ContentType "application/json; charset=utf-8" | Out-Null
            Write-Host " ПЕРЕЗАГРУЖЕН" -ForegroundColor Cyan
            $reloaded++
            continue
        } catch {
            Write-Host " FAILED (reload)" -ForegroundColor Red
            Write-Host "      $($_.Exception.Message)" -ForegroundColor Yellow
            $failed++
            continue
        }
    }

    # Уже в нужном состоянии — пропускаем (без -Force)
    if ($isActive -eq $targetState) {
        $statusWord = if ($targetState) { "уже активен" } else { "уже выключен" }
        Write-Host "  - $name : $statusWord" -ForegroundColor DarkGray
        $alreadyOk++
        continue
    }

    Write-Host "  - $name ..." -NoNewline
    try {
        $response = Invoke-RestMethod -Method POST `
            -Uri "$n8n/api/v1/workflows/$id/$verb" `
            -Headers $headers `
            -ContentType "application/json; charset=utf-8"
        $okWord = if ($targetState) { "АКТИВИРОВАН" } else { "ВЫКЛЮЧЕН" }
        Write-Host " $okWord" -ForegroundColor Green
        $activated++
    } catch {
        $errBody = ""
        if ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $stream.Position = 0
                $reader = New-Object System.IO.StreamReader($stream)
                $errBody = $reader.ReadToEnd()
            } catch {}
        }
        Write-Host " FAILED" -ForegroundColor Red
        Write-Host "      $($_.Exception.Message)" -ForegroundColor Yellow
        if ($errBody) {
            # Подсказки по типовым ошибкам активации
            if ($errBody -match "credential") {
                Write-Host "      Подсказка: проверь привязку credentials в узлах workflow." -ForegroundColor DarkYellow
            } elseif ($errBody -match "trigger|webhook") {
                Write-Host "      Подсказка: проверь что есть валидный trigger/webhook узел." -ForegroundColor DarkYellow
            }
            Write-Host "      Сервер: $errBody" -ForegroundColor DarkGray
        }
        $failed++
    }
}

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ИТОГ:" -ForegroundColor Green
$actLabel = if ($targetState) { "активировано" } else { "выключено" }
$okLabel  = if ($targetState) { "уже активных" } else { "уже выключенных" }
Write-Host "   $actLabel`:`t$activated" -ForegroundColor Green
if ($reloaded -gt 0) {
    Write-Host "   перезагружено:`t$reloaded" -ForegroundColor Cyan
}
Write-Host "   $okLabel`:`t$alreadyOk" -ForegroundColor DarkGray
Write-Host "   ошибок:`t`t$failed" -ForegroundColor $(if ($failed) { 'Red' } else { 'DarkGray' })
Write-Host "=============================================================" -ForegroundColor Green

if ($failed -gt 0) {
    Write-Host ""
    Write-Host "Если есть ошибки — открой workflow в UI n8n и проверь:" -ForegroundColor Yellow
    Write-Host "  1. Все credentials привязаны (нет красных нод)." -ForegroundColor Yellow
    Write-Host "  2. URL HTTP-нод подставлены (нет `<OCR_HOST>` / `<EMBEDDING_HOST>`)." -ForegroundColor Yellow
    Write-Host "  3. Все Postgres-ноды видят credential 'Postgres'." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "После исправления — запусти .\activate-workflows.ps1 снова," -ForegroundColor Yellow
    Write-Host "уже активные workflow будут пропущены автоматически." -ForegroundColor Yellow
}

if (-not $Deactivate -and $activated -gt 0) {
    Write-Host ""
    Write-Host "Все активированные workflow теперь принимают POST-запросы." -ForegroundColor Cyan
    Write-Host "Проверь, например:  curl -X POST http://localhost:5678/webhook/router -d '{`"ping`":`"1`"}'" -ForegroundColor DarkCyan
}
