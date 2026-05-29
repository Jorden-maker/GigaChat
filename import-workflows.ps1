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
#                     .\import-workflows.ps1 -Filter sql-agent   # только sql-agent.json
#                     .\import-workflows.ps1 -ResetCreds         # см. ниже
#
# ФЛАГ -ResetCreds:
#   Снести credentials-cache.local.json ПЕРЕД импортом. Полезно когда:
#   - После удаления workflow вручную credentials в нодах помечены как
#     «битые» (не подтягиваются, не выбираются из dropdown в UI).
#   - Кеш протух: ID в кеше указывает на удалённый credential, скрипт
#     слепо берёт ID из кеша, n8n импортирует workflow с битой ссылкой.
#   После -ResetCreds: скрипт делает name-matching/autoCreate заново
#   и сохраняет свежий кеш. Безопасно — кеш в .gitignore, не аффектит коллег.
# =============================================================================
param(
    [string]$Filter,
    [switch]$ResetCreds
)

# ---- НАСТРОЙКИ ----
$folder = "C:\Users\Lenovo\Desktop\GigaChat\Workflow"   # путь к папке с .json
$n8n    = "http://localhost:5678"                       # URL n8n БЕЗ слеша на конце
$apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMWQzMzQ3Ny05MjdlLTQxMGEtYjNiMC0wMWNmOTY2ODgwYmYiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZmY5ZGFiYTctZWZjNi00YjE3LTgxOGUtNDA2ZmYwMjQxOWMwIiwiaWF0IjoxNzc4NzU4ODgxLCJleHAiOjE3ODEzMjMyMDB9.SI7GAu_3y5neIzbam3iYnwDxkF0TMwf3fvixBvOZmls"                                            # вставь сюда API-ключ из n8n
$prefix = "[GigaChat] "                                 # префикс имени, "" чтобы отключить

# ---- CREDENTIAL MAPPING ----
# В .json-файлах workflow прописаны ID credentials с РАЗРАБОТЧЕСКОЙ машины.
# На другой машине таких ID нет, поэтому n8n показывает «битый credential».
# Скрипт сам подменяет ID в каждом узле перед импортом — на ID credential с
# нужным именем и типом из текущей n8n.
#
# Откуда берётся ID:
#   1. Если у поля .id ниже стоит непустая строка — используется она.
#   2. Иначе скрипт проверяет локальный кеш credentials-cache.local.json
#      (рядом со скриптом, в .gitignore).
#   3. Иначе и autoCreate = $true → создаём credential через POST /api/v1/credentials
#      и сохраняем новый ID в кеш.
#   4. Иначе → предупреждение, узлы остаются с битым credential.
#
# ВАЖНО про Postgres: автосоздание выключено, потому что пароль БД не должен
# жить в скрипте в git. На офисной машине Postgres credential нужно создать
# вручную ОДИН РАЗ через UI n8n (имя «Postgres»), а скрипт найдёт его ID
# при попытке создания (n8n вернёт 400 с текстом ошибки) — либо просто
# впиши $credentialMapping.postgres.id ниже.
$credentialMapping = @{
    openAiApi = @{
        # Имя credential типа OpenAI в офисной n8n.
        # Если на твоей машине credential называется иначе — поправь имя.
        name       = "GigaChatLite10b"
        id         = ""
        # autoCreate: если в n8n ещё нет credential с этим именем — скрипт создаст.
        # Если уже есть (например в офисе) — API вернёт 400 и сработает fallback
        # на name-matching: n8n при импорте сам найдёт credential по имени.
        autoCreate = $true
        data       = @{
            # GigaChat (локальный) не требует Authorization — apiKey любой непустой.
            apiKey      = "no-auth"
            url         = "http://130.100.95.104:8810/v1"
            # n8n openAiApi credential под капотом — это HTTP-Header-Auth, который
            # шлёт `Authorization: Bearer <apiKey>`. UI подставляет эти поля сам, но
            # через POST API их нужно указывать явно, иначе валидация падает с 400.
            headerName  = "Authorization"
            headerValue = "Bearer no-auth"
        }
    }
    postgres = @{
        name       = "Postgres"
        id         = ""
        autoCreate = $false   # пароль не хранится в скрипте; credential создаётся вручную через UI n8n
        data       = @{}
    }
}
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

# Применение -Filter <substring>: оставляем только .json у которых имя
# содержит указанную подстроку. Пример: -Filter sql-agent → только sql-agent.json.
if (-not [string]::IsNullOrWhiteSpace($Filter)) {
    $before = $jsonFiles.Count
    $jsonFiles = $jsonFiles | Where-Object { $_.Name -like "*$Filter*" }
    Write-Host ("Фильтр '-Filter {0}': {1} из {2} файлов." -f $Filter, $jsonFiles.Count, $before) -ForegroundColor Cyan
    if ($jsonFiles.Count -eq 0) {
        Write-Host "Ни один .json не совпал с фильтром. Выхожу." -ForegroundColor Yellow
        exit 0
    }
}

$headers = @{ "X-N8N-API-KEY" = $apiKey }

# ============================================================================
# Резолвинг credentials (см. блок $credentialMapping выше)
# ============================================================================

# Файл с уже резолвленными ID — лежит рядом со скриптом и в .gitignore.
$credCachePath = Join-Path $PSScriptRoot "credentials-cache.local.json"

# Применение -ResetCreds: сносим кеш перед началом. n8n public API не даёт
# проверить «жив ли credential по ID», поэтому при удалении credentials
# вручную в UI кеш протухает молча. Скрипт продолжает использовать мёртвый
# ID → workflow импортируются с битыми ссылками, в UI «Missing credential»
# и dropdown не предлагает существующие.
# Через -ResetCreds кеш чистится, скрипт делает name-matching/autoCreate
# заново и сохраняет свежий кеш. Это идемпотентно — следующие запуски
# без -ResetCreds работают как обычно.
if ($ResetCreds) {
    Write-Host "==> Флаг -ResetCreds: сношу credentials-cache.local.json" -ForegroundColor Yellow
    if (Test-Path $credCachePath) {
        Remove-Item $credCachePath -Force
        Write-Host "    Удалён. Резолвлю credentials с нуля." -ForegroundColor Yellow
    } else {
        Write-Host "    Кеша и не было — ничего удалять." -ForegroundColor DarkYellow
    }
}

function Get-CredentialCache {
    if (-not (Test-Path $credCachePath)) { return @{} }
    try {
        $raw = Get-Content $credCachePath -Raw -Encoding UTF8
        $obj = $raw | ConvertFrom-Json
        $h = @{}
        foreach ($p in $obj.PSObject.Properties) {
            $h[$p.Name] = @{ id = $p.Value.id; name = $p.Value.name }
        }
        return $h
    } catch {
        Write-Host "  Не удалось прочитать $credCachePath — игнорирую кеш." -ForegroundColor DarkYellow
        return @{}
    }
}

function Save-CredentialCache($cache) {
    try {
        # Подготовка к ConvertTo-Json: чистая хеш-таблица
        $clean = [ordered]@{}
        foreach ($k in $cache.Keys) {
            $clean[$k] = [ordered]@{
                id   = $cache[$k].id
                name = $cache[$k].name
            }
        }
        $clean | ConvertTo-Json -Depth 5 | Set-Content $credCachePath -Encoding UTF8
    } catch {
        Write-Host "  Не удалось сохранить $credCachePath : $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

function Resolve-CredentialId {
    param(
        [string]$type,
        [hashtable]$config,
        [hashtable]$cache
    )

    # 1. Явно прописанный ID в скрипте — приоритетнее всего.
    if (-not [string]::IsNullOrWhiteSpace($config.id)) {
        $cache[$type] = @{ id = $config.id; name = $config.name }
        return $config.id
    }

    # 2. Кеш.
    if ($cache.ContainsKey($type) -and -not [string]::IsNullOrWhiteSpace($cache[$type].id)) {
        return $cache[$type].id
    }

    # 3. Авто-создание через POST /api/v1/credentials.
    if ($config.autoCreate) {
        Write-Host "  Создаю credential '$($config.name)' (тип $type) в n8n..." -ForegroundColor Cyan
        $createBody = @{
            name = $config.name
            type = $type
            data = $config.data
        } | ConvertTo-Json -Depth 10 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($createBody)
        try {
            $resp = Invoke-RestMethod -Method POST `
                -Uri "$n8n/api/v1/credentials" `
                -Headers $headers `
                -ContentType "application/json; charset=utf-8" `
                -Body $bytes
            if ($resp.id) {
                Write-Host "    OK: создан, id = $($resp.id)" -ForegroundColor Green
                $cache[$type] = @{ id = $resp.id; name = $config.name }
                return $resp.id
            }
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
            Write-Host "    Не удалось создать: $($_.Exception.Message)" -ForegroundColor Yellow
            if ($errBody) { Write-Host "    Сервер: $errBody" -ForegroundColor DarkYellow }
            Write-Host "    Возможно, credential с именем '$($config.name)' уже существует." -ForegroundColor DarkYellow
            Write-Host "    Открой UI n8n -> Credentials -> '$($config.name)', скопируй ID из URL" -ForegroundColor DarkYellow
            Write-Host "    и впиши в `$credentialMapping.$type.id в начале скрипта." -ForegroundColor DarkYellow
        }
    } else {
        Write-Host "  Credential '$($config.name)' (тип $type): autoCreate выключен." -ForegroundColor Yellow
        Write-Host "    Создай credential вручную в UI n8n, затем впиши ID в" -ForegroundColor DarkYellow
        Write-Host "    `$credentialMapping.$type.id в начале скрипта." -ForegroundColor DarkYellow
    }

    return $null
}

function Apply-CredentialMapping {
    param(
        $workflowObj,
        [hashtable]$resolved,
        [hashtable]$mapping
    )

    if (-not $workflowObj.nodes) { return $workflowObj }

    foreach ($node in $workflowObj.nodes) {
        if (-not $node.credentials) { continue }
        $credProps = $node.credentials.PSObject.Properties
        foreach ($prop in $credProps) {
            $credType = $prop.Name
            if ($resolved.ContainsKey($credType) -and $resolved[$credType].id) {
                # Полная подмена: и id, и name. Самый надёжный путь.
                $prop.Value = [PSCustomObject]@{
                    id   = $resolved[$credType].id
                    name = $resolved[$credType].name
                }
            } elseif ($mapping.ContainsKey($credType) -and $mapping[$credType].name) {
                # ID не зарезолвлен, но имя из $credentialMapping мы знаем.
                # Подменяем только name — n8n при импорте через PUT/POST умеет
                # делать name-matching: если ID не найден, ищет credential по имени.
                # (Так у пользователя Postgres подтягивается автоматически.)
                $prop.Value = [PSCustomObject]@{
                    id   = ""
                    name = $mapping[$credType].name
                }
            }
        }
    }
    return $workflowObj
}

# Резолвим credentials заранее — один раз для всех workflow.
Write-Host "==> Резолвлю credentials..." -ForegroundColor Cyan
$credCache = Get-CredentialCache
$resolvedCreds = @{}
foreach ($type in $credentialMapping.Keys) {
    $cfg = $credentialMapping[$type]
    $id = Resolve-CredentialId -type $type -config $cfg -cache $credCache
    if ($id) {
        $resolvedCreds[$type] = @{ id = $id; name = $cfg.name }
        Write-Host "    $type -> id: $id, name: $($cfg.name)" -ForegroundColor DarkGray
    } else {
        # Fallback: ID не получили, но имя знаем. Apply-CredentialMapping подменит
        # в каждом узле credentials.<type>.name на это имя (id оставит пустым).
        # n8n при импорте делает name-matching — если в его credentials есть
        # запись с этим именем, она привяжется автоматически.
        Write-Host "    $type -> ID не получен, применю name-matching по имени '$($cfg.name)'" -ForegroundColor DarkGray
    }
}
Save-CredentialCache $credCache
Write-Host ""

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

        # Подменяем credential id/name в узлах на актуальные для текущей n8n.
        # - Если ID зарезолвлен (через autoCreate или явно вписан) — пишем id + name.
        # - Если ID нет, но в $credentialMapping есть имя — пишем только name,
        #   и n8n при импорте сделает name-matching (как с Postgres у пользователя).
        Apply-CredentialMapping -workflowObj $clean -resolved $resolvedCreds -mapping $credentialMapping | Out-Null

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

# R7 #1: post-import patch для plane-agent — подключаем Switch fallback output.
# n8n Public API при импорте обрезает connections.main до rules.length,
# поэтому fallback connection теряется.
#
# R7.95: ВСТРОЕННЫЙ PowerShell-нативный фикс (не требует node.exe).
# Раньше использовали отдельный post-import-fallback.js — на офисе нет
# Node.js, поэтому он молча скипался. Теперь работает на чистом PS.
function Invoke-PlaneSwitchFallbackPatch {
    param(
        [string]$N8nHost,
        [string]$ApiKey,
        [string]$WfNameHint = 'Plane-агент',
        [string]$SwitchNode = 'Switch action',
        [string]$FallbackTarget = 'Формат ответа'
    )
    $h = @{ 'X-N8N-API-KEY' = $ApiKey; 'Content-Type' = 'application/json; charset=utf-8' }
    Write-Host "  Хост n8n: $N8nHost" -ForegroundColor DarkGray
    # 1) Список workflow
    try {
        $list = Invoke-RestMethod -Method GET -Uri "$N8nHost/api/v1/workflows?limit=250" -Headers $h
    } catch {
        throw "Не удалось получить список workflow: $($_.Exception.Message)"
    }
    $items = if ($list.data) { $list.data } else { $list }
    # 2) Фильтр по имени + не архивные
    $matching = @($items | Where-Object { $_.name -like "*$WfNameHint*" })
    if (-not $matching.Count) {
        throw "Не нашёл workflow с «$WfNameHint» в имени. Запусти сначала import-workflows."
    }
    $live = @($matching | Where-Object { -not $_.isArchived })
    if (-not $live.Count) {
        throw "Все workflow с «$WfNameHint» в имени — архивные. Разархивируй один."
    }
    if ($matching.Count -gt $live.Count) {
        Write-Host "  Игнорирую $($matching.Count - $live.Count) архивных Plane-agent workflow" -ForegroundColor DarkGray
    }
    # Берём активный или первый из живых
    $active = @($live | Where-Object { $_.active })
    $chosen = if ($active.Count) { $active[0] } else { $live[0] }
    if ($live.Count -gt 1) {
        Write-Host "  Найдено $($live.Count) живых Plane-agent workflow. Беру: $($chosen.name) [id=$($chosen.id)]" -ForegroundColor DarkGray
    }
    $wfId = $chosen.id
    Write-Host "  Plane workflow ID: $wfId" -ForegroundColor DarkGray
    # 3) Получить детали
    $wf = Invoke-RestMethod -Method GET -Uri "$N8nHost/api/v1/workflows/$wfId" -Headers $h
    if (-not $wf.connections.$SwitchNode) {
        throw "У workflow нет node «$SwitchNode» в connections"
    }
    $conn = $wf.connections.$SwitchNode.main
    $switchNd = @($wf.nodes | Where-Object { $_.name -eq $SwitchNode })[0]
    if (-not $switchNd.parameters.rules.values) {
        throw "У «$SwitchNode» нет parameters.rules.values"
    }
    $rules = @($switchNd.parameters.rules.values).Count
    $connCount = @($conn).Count
    Write-Host "  Switch.rules: $rules, connections.main.length: $connCount" -ForegroundColor DarkGray
    # 4) Проверка нужен ли патч
    if ($connCount -gt $rules) {
        $last = $conn[$connCount - 1]
        $lastNodes = @($last | ForEach-Object { $_.node })
        if ($lastNodes -contains $FallbackTarget) {
            Write-Host "  OK: fallback уже подключён к «$FallbackTarget» (idx=$($connCount - 1)). Ничего не делаю." -ForegroundColor Green
            return $true
        }
        Write-Host "  Fallback есть, но указывает не на «$FallbackTarget». Перезаписываю." -ForegroundColor Yellow
        $conn[$connCount - 1] = @(@{ node = $FallbackTarget; type = 'main'; index = 0 })
    } else {
        # Дополним пустыми массивами до rules длины, потом добавим fallback
        while (@($conn).Count -lt $rules) {
            $conn = @($conn) + ,@()
        }
        $conn = @($conn) + ,@(@{ node = $FallbackTarget; type = 'main'; index = 0 })
        Write-Host "  Добавляю fallback connection на index=$(@($conn).Count - 1)" -ForegroundColor DarkGray
    }
    $wf.connections.$SwitchNode.main = $conn
    # 5) PUT — Public API строго фильтрует settings (только executionOrder)
    $cleanSettings = @{}
    if ($wf.settings -and $wf.settings.executionOrder) {
        $cleanSettings.executionOrder = $wf.settings.executionOrder
    }
    $payload = @{
        name = $wf.name
        nodes = $wf.nodes
        connections = $wf.connections
        settings = $cleanSettings
    }
    $body = $payload | ConvertTo-Json -Depth 100 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    Invoke-RestMethod -Method PUT -Uri "$N8nHost/api/v1/workflows/$wfId" `
        -Headers @{ 'X-N8N-API-KEY' = $ApiKey } `
        -ContentType "application/json; charset=utf-8" `
        -Body $bytes | Out-Null
    # 6) VERIFY
    $after = Invoke-RestMethod -Method GET -Uri "$N8nHost/api/v1/workflows/$wfId" -Headers $h
    $afterConn = $after.connections.$SwitchNode.main
    $afterCount = @($afterConn).Count
    if ($afterCount -gt $rules) {
        $afterLast = $afterConn[$afterCount - 1]
        $afterNodes = @($afterLast | ForEach-Object { $_.node })
        if ($afterNodes -contains $FallbackTarget) {
            Write-Host "  ВЕРИФИКАЦИЯ: fallback сохранён в n8n. connections.length=$afterCount, target=«$FallbackTarget»." -ForegroundColor Green
            return $true
        }
    }
    throw "ВЕРИФИКАЦИЯ FAILED: после PUT connections.length=$afterCount, rules=$rules. n8n отверг изменения."
}

$patchOk = $false
Write-Host ""
Write-Host "==> Post-import patch: Switch fallback для plane-agent..." -ForegroundColor Cyan
try {
    $patchOk = Invoke-PlaneSwitchFallbackPatch -N8nHost $n8n -ApiKey $apiKey
} catch {
    Write-Host ""
    Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Fallback-connection в Switch action НЕ подключена." -ForegroundColor Red
    Write-Host "  Открой workflow «Plane-агент. Поток» в n8n UI и подключи" -ForegroundColor Red
    Write-Host "  последний выход узла 'Switch action' к узлу 'Формат ответа'." -ForegroundColor Red
}

# ============================================================================
# Post-import VERIFY: проверяем что credentials в реальных импортированных
# workflow совпадают с резолвленными. Если нет — значит кеш протух (credential
# с таким ID не существует в n8n) и подсказываем -ResetCreds.
# n8n public API не даёт `GET /credentials/<id>` (405), поэтому проверяем
# косвенно: тянем workflow обратно через GET и считаем сколько разных ID
# используется. Если ID в workflow совпадают с резолвленными — OK.
# Если в workflow прописаны ID которых не было в нашем mapping — это ID
# который остался ОТ ПРЕДЫДУЩЕЙ привязки в n8n (credentials сохранились
# при обновлении). Это норма. Бьём тревогу только когда нашему резолв-ID
# нет ни в одном импортированном workflow — значит ID мёртв или мы его
# криво подсунули.
$credIssues = @()
try {
    # ВАЖНО: prefix содержит "[GigaChat] " — квадратные скобки в PowerShell -like
    # это spec-символы (символьный класс). Нельзя использовать -like "*$prefix*".
    # Делаем .Contains() — буквальное сравнение.
    $checkWfs = (Invoke-RestMethod -Uri "$n8n/api/v1/workflows?limit=250" -Headers $headers).data |
                Where-Object { (-not $_.isArchived) -and ($_.name.Contains($prefix)) }
    $idsInUse = @{}
    foreach ($wf in $checkWfs) {
        $full = Invoke-RestMethod -Uri "$n8n/api/v1/workflows/$($wf.id)" -Headers $headers
        foreach ($node in $full.nodes) {
            if (-not $node.credentials) { continue }
            foreach ($prop in $node.credentials.PSObject.Properties) {
                $key = "$($prop.Name)|$($prop.Value.id)"
                if (-not $idsInUse.ContainsKey($key)) { $idsInUse[$key] = 0 }
                $idsInUse[$key]++
            }
        }
    }
    # Сверка: каждый резолвленный credential должен встречаться хотя бы в одном workflow
    foreach ($type in $resolvedCreds.Keys) {
        $rid = $resolvedCreds[$type].id
        if (-not $rid) { continue }
        $key = "$type|$rid"
        if (-not $idsInUse.ContainsKey($key)) {
            $credIssues += "Резолвленный $type id=$rid (name=$($resolvedCreds[$type].name)) НЕ найден ни в одном импортированном workflow. Возможно протух."
        }
    }
} catch {
    # Не критично, просто пропустим verify
    $credIssues += "Не удалось верифицировать credentials: $($_.Exception.Message)"
}

Write-Host "=============================================================" -ForegroundColor Green
Write-Host " ИТОГ:" -ForegroundColor Green
Write-Host "   создано:           $created" -ForegroundColor Green
Write-Host "   обновлено:         $updated" -ForegroundColor Yellow
if ($renamed -gt 0) {
    Write-Host "   переименовано:     $renamed   (старый workflow без префикса дополнен префиксом)" -ForegroundColor Magenta
}
Write-Host "   ошибок:            $failed" -ForegroundColor $(if ($failed) { 'Red' } else { 'DarkGray' })
if ($patchOk) {
    Write-Host "   Switch fallback:   OK" -ForegroundColor Green
} else {
    Write-Host "   Switch fallback:   FAILED — подключи вручную в UI n8n" -ForegroundColor Red
}
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " ЧТО ДАЛЬШЕ:"
Write-Host " 1. Обнови страницу n8n (F5)."
Write-Host " 2. Для НОВЫХ workflow привяжи credentials в узлах и активируй."
Write-Host "    Для ОБНОВЛЁННЫХ / ПЕРЕИМЕНОВАННЫХ — credentials остались,"
Write-Host "    ничего делать не надо."
if (-not $patchOk) {
    Write-Host " 3. Для Plane-агента: в узле 'Switch action' соедини ПОСЛЕДНИЙ" -ForegroundColor Yellow
    Write-Host "    (fallback) выход с узлом 'Формат ответа'." -ForegroundColor Yellow
}
if ($credIssues.Count -gt 0) {
    Write-Host ""
    Write-Host " ⚠️  ПРОБЛЕМЫ С CREDENTIALS:" -ForegroundColor Red
    foreach ($issue in $credIssues) {
        Write-Host "    - $issue" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "    Скорее всего credentials-cache.local.json протух (credential" -ForegroundColor Yellow
    Write-Host "    удалён в n8n UI вручную). Запусти заново с -ResetCreds:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "       .\import-workflows.ps1 -ResetCreds" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    Это снесёт кеш, скрипт сделает name-matching/autoCreate" -ForegroundColor Yellow
    Write-Host "    заново и сохранит свежие ID." -ForegroundColor Yellow
}
Write-Host "=============================================================" -ForegroundColor Green
