# Тестирование GigaChat Plane в офисе — полная инструкция (v2)

Документ обновлён под версию **14 actions + канбан-доска + шаблоны + smart-dates + bulk**.

Считается что в офисе уже работают:
- **n8n** (Docker, web UI доступен)
- **PostgreSQL** (Docker, `planner_users`/`planner_sessions`/`agent_sessions`)
- **Plane** (Docker, web UI доступен)
- **Хотя бы один зарегистрированный юзер** (через `/login.html` GigaChat)

---

## Содержание

1. [Шаг 1 — Синхронизация кода](#шаг-1)
2. [Шаг 2 — Импорт workflow в офисную n8n](#шаг-2)
3. [Шаг 3 — Параметры Plane API](#шаг-3)
4. [Шаг 4 — Подбор Plane URL для n8n](#шаг-4)
5. [Шаг 5 — Конфигурация GigaChat Plane](#шаг-5)
6. [Шаг 6 — Direct-test (без LLM): 14 actions](#шаг-6)
7. [Шаг 7 — Канбан-доска](#шаг-7)
8. [Шаг 8 — Чат через LLM (NL-режим)](#шаг-8)
9. [Шаг 9 — Шаблоны задач](#шаг-9)
10. [Шаг 10 — Smart-даты](#шаг-10)
11. [Шаг 11 — Bulk-операции](#шаг-11)
12. [Troubleshooting](#troubleshooting)

---

## Шаг 1

На офисном ПК:
```powershell
cd C:\Users\Lenovo\Desktop\GigaChat
git pull origin main
```

Должны прийти (минимум):
- `Workflow/plane-agent.json` — workflow (28+ узлов, включая enrich states, action router, resolve extended)
- `Agents/plane-agent.html` — UI (header «Доска / Plane-настройки / Тест без LLM», kanban-overlay, templates tab)
- `Agents/_shared.js` — auth + sessions sync
- `Workflow/sso.json`, `Workflow/sessions-sync.json` — единая авторизация
- `login.html` — отдельная страница входа
- `Plane/OFFICE-TESTING.md` — этот документ

Проверка:
```powershell
git log --oneline -10
```
Должны быть свежие коммиты `feat(plane)` / `fix(plane)`.

---

## Шаг 2

В n8n импортнуть свежий `Workflow/plane-agent.json`:
1. В n8n UI: **Workflows → Import from File → выбрать `plane-agent.json`** → подтвердить replace.
2. В импортированном workflow найти узлы Postgres (например `SQL: Verify token`) → проверить что credential **«Postgres»** привязан (если нет — выбрать в выпадающем).
3. Сохранить → **Activate** (toggle справа сверху).

Альтернатива из консоли (если есть JWT в `import-workflows.ps1`):
```powershell
cd C:\Users\Lenovo\Desktop\GigaChat
powershell -ExecutionPolicy Bypass -File import-workflows.ps1
powershell -ExecutionPolicy Bypass -File activate-workflows.ps1 -Force
```

---

## Шаг 3

В Plane (web UI):
1. **Workspace settings → API tokens → Add API token** → имя «GigaChat», бессрочный.
2. Скопировать значение `plane_api_xxxxxxxxx...` (видно один раз).
3. В URL Plane запомнить slug workspace (например `office` в `http://server:8000/office/projects`).
4. Создать тестовый проект с любым именем (например **«Рабочие задачи»**) — для тестов будем им пользоваться.

---

## Шаг 4

n8n в Docker, Plane в Docker — `localhost:8000` из контейнера n8n **не** идёт в контейнер Plane. Правильный URL:

| Сценарий | URL |
|---|---|
| n8n и Plane в одной `docker-compose.yml` (одна сеть) | `http://plane-proxy:80` (имя сервиса) |
| Разные `docker-compose.yml`, один Docker daemon | `http://host.docker.internal:8000` |
| Plane на другом сервере | `http://<IP_сервера>:8000` |

Если непонятно — попробовать `host.docker.internal:8000` первым (это default в Direct test placeholder).

Проверка из n8n shell:
```bash
docker exec n8n curl -s http://host.docker.internal:8000/api/v1/workspaces/ \
  -H "X-API-Key: plane_api_xxxxxx" | head -c 200
```
Должен прийти JSON со списком workspaces.

---

## Шаг 5

В браузере (на офисном ПК где гоняешь GigaChat):
1. Открыть `login.html` → войти своим логином/паролем
2. Открыть **GigaChat-Platform.html** (дашборд) → клик карточки **GigaChat Plane** (третья в первой строке)
3. В правом верхнем углу — **«Plane-настройки»** → откроется модалка с 2 вкладками:
   - **Подключение**: вставить Plane URL, workspace slug, API token → «Сохранить»
   - **Шаблоны**: посмотреть какие шаблоны доступны (Bug/Feature/Tech debt — hardcoded в LLM prompt)
4. Сохранить → если креды правильные, модалка закроется

---

## Шаг 6

**14 actions** через кнопку **«Тест без LLM»** (правый верх). Открывается модалка с 14 карточками. Каждая шлёт прямой запрос (LLM пропускается).

### Базовый смок-test (5 минут)
| # | Карточка | Поля | Ожидаемое |
|---|---|---|---|
| 1 | Список проектов | — | data.projects = [{name: «Рабочие задачи», ...}] |
| 3 | Создать задачу | project=«Рабочие задачи», name=«Купить молоко», priority=high | data.issue.sequence_id = NN |
| 7 | Получить задачу | project + name | data.issue с полным объектом |
| 4 | Обновить задачу | project + name + priority=urgent | response: «Задача обновлена» |
| 5 | Удалить задачу | project + name | response: «Задача удалена» |

### Полный test всех 14 actions
| # | Action | Когда применять |
|---|---|---|
| 1 | `list_projects` | Проверить что workspace + token работают |
| 2 | `list_issues` | Проверить что project_name резолвится |
| 3 | `create_issue` | Создание + priority |
| 4 | `update_issue` | Изменение name/priority/description |
| 5 | `delete_issue` | Удаление |
| 6 | `search_issues` | Фильтр по подстроке в name |
| **7** | **`get_issue`** | Детали (полный объект, для отладки) |
| **8** | **`change_status`** | state: `todo`/`in_progress`/`done`/`cancelled`/`backlog` |
| **9** | **`set_deadline`** | target_date через date picker → YYYY-MM-DD |
| **10** | **`assign_issue`** | assignees: comma-separated user_id из Plane Members |
| **11** | **`add_label`** | labels: comma-separated label_id (из Plane → Project → Labels) |
| **12** | **`remove_label`** | оставшиеся labels (те что НЕ удаляются) |
| **13** | **`add_comment`** | text комментария — добавится в task → Comments |
| **14** | **`bulk`** | JSON массив sub-actions. Пример: `[{"action":"delete_issue","params":{"project_name":"Рабочие задачи","issue_name":"X"}}]` |

После каждого выполнения — JSON-ответ под карточкой. Если что-то красное (error) — см. [Troubleshooting](#troubleshooting).

---

## Шаг 7

В header кнопка **«Доска»** — переключает на канбан-overlay.

### Что должно работать:
1. **Загрузка проектов**: select сверху с проектами (если один — авто-выбран)
2. **Распределение задач по 4 колонкам**: Задачи / В работе / Готово / Отменено — по полю `state_detail.group` (backlog+unstarted=Задачи, started=В работе, completed=Готово, cancelled=Отменено)
3. **Карточки**: показывают имя, `#sequence_id`, приоритет (цветной chip), дедлайн (📅 + красный если просрочен)
4. **Счётчики**: в заголовке каждой колонки — число задач
5. **Drag-and-drop**: схватить карточку → перетащить в другую колонку → автоматически меняется статус в Plane
6. **Оптимистичный move**: карточка переезжает мгновенно (без задержки на сервер); если запрос упал — откатывается обратно с понятной ошибкой
7. **Кнопка «Обновить»** — перезагрузить задачи (нужна если изменения сделаны в самом Plane UI)
8. **Кнопка «Чат»** (вместо «Доска» когда открыта) — вернуться к чату

### Что НЕ работает (ограничения MVP):
- Создание задачи прямо с доски (только через чат или Direct Test)
- Inline-редактирование (только статус через drag)
- Фильтры по приоритету / исполнителю
- Multi-select drag

### Проверка корректности:
1. В Plane web UI: переключить статус 2-3 задач (Todo → In Progress)
2. В GigaChat Plane: открыть доску, нажать «Обновить»
3. Распределение по колонкам должно совпасть с Plane

---

## Шаг 8

В чат-режиме (по умолчанию) — пишешь на естественном языке, LLM генерит action+params.

### Базовые запросы
| Запрос | LLM action | Что произойдёт |
|---|---|---|
| «покажи мои проекты» | list_projects | Список проектов карточками |
| «что в Рабочих задачах?» | list_issues | Список задач проекта |
| «создай задачу 'Позвонить клиенту' в Рабочих задачах с высоким приоритетом» | create_issue | Новая задача |
| «найди задачи со словом купить» | search_issues | Фильтр по подстроке |
| «передвинь Купить молоко в работу» | change_status | state=in_progress |
| «срок Купить молоко — к пятнице» | set_deadline | LLM сам конвертирует «пятница» → YYYY-MM-DD |
| «прокомментируй задачу Купить молоко: переговорил, ждём поставку» | add_comment | Комментарий |
| «удали задачу Купить молоко» | delete_issue | Удаление |
| «детали задачи Купить молоко» | get_issue | Полная карточка |

### Что НЕ работает в LLM режиме
- **`assign_issue` / `add_label`** — LLM не знает user_id и label_id (это UUID). Если попросишь «назначь Иванову» — ответит chat-ом «нужен user_id из Plane Members».

---

## Шаг 9

LLM понимает 3 hardcoded шаблона (видно в Plane-настройки → Шаблоны):

| Триггер в чате | Что создаст |
|---|---|
| **багфикс** Кнопка не работает | `Bug: Кнопка не работает`, priority=high |
| **фича** Экспорт в Excel | `Feature: Экспорт в Excel`, priority=medium |
| **техдолг** Переписать SQL | `Tech debt: Переписать SQL`, priority=low |

### Тест:
1. Чат: «создай багфикс в Рабочих задачах: модалка не закрывается»
2. Ожидание: создаётся задача `Bug: модалка не закрывается` с priority=high

---

## Шаг 10

LLM конвертирует естественные даты в `YYYY-MM-DD` для `set_deadline` или `create_issue.target_date`. Сегодняшняя дата подставляется в system prompt.

| Запрос | LLM конвертирует в |
|---|---|
| «к пятнице» | ближайшая пятница |
| «через 3 дня» | today + 3 |
| «послезавтра» | today + 2 |
| «25 декабря» | текущий год (если уже прошло — следующий) |
| «25.12.2026» | как есть |

### Тест:
1. Чат: «срок Купить молоко — через неделю»
2. В Plane UI задача должна получить target_date = today + 7 дней
3. На канбан-доске карточка покажет `📅 YYYY-MM-DD`

---

## Шаг 11

LLM при запросах «удали все X», «передвинь всё Y» возвращает `action=bulk` с массивом sub-actions. Сейчас backend это **заглушка** — возвращает summary, реальной итерации нет (на будущее через `SplitInBatches`).

### Что работает сейчас:
1. Чат: «удали все Done задачи»
2. LLM ответит chat-ом с preview списка + предложит подтвердить
3. После «да» → `action=bulk` → backend вернёт «Bulk-операция получена (N sub-actions). Реальная итерация — в следующей версии»

### Что НЕ работает:
- Реальное удаление через bulk (одиночные actions работают)
- Можно делать через Direct Test → action 14 «Bulk» вручную (JSON-массив), но та же заглушка

---

## Troubleshooting

| Симптом | Что проверить |
|---|---|
| «Plane не настроен» при первом запросе | Открыть Plane-настройки → заполнить все 3 поля (URL/slug/token) |
| 401/403 в Direct Test | Token недействителен / истёк → создать новый в Plane → Settings → API tokens |
| 404 «task not found» в Direct Test | Опечатка в issue_name (case-sensitive!) или задача в другом проекте |
| 404 «Page not found» | Plane URL неправильный — попробовать `host.docker.internal:8000` или IP сервера |
| **429 «Plane перегружен запросами»** | Rate limit Plane. Подождать 5-10 сек. При rapid drag-and-drop — это нормально, drag оптимистичный и откатится |
| Все 4 задачи в одной колонке «Задачи» | Старый кеш / устаревший workflow. Импортнуть свежий `plane-agent.json`, нажать «Обновить» в доске |
| «Failed to execute json on Response» | Workflow упал — открыть n8n UI → Executions → последний failed → найти ноду с ошибкой |
| Канбан пустой («Нет проектов») | API token не имеет доступа к workspace, или wrong slug — проверить в Plane URL |
| LLM отвечает «не нашёл проект» | Имя в чате не совпадает с реальным (например «Office» vs «office») — точное имя |
| Drag не работает на тач-устройстве | HTML5 DnD на mobile не поддерживается. Использовать чат-режим |
| «session_id содержит недопустимые символы» | session_id должен быть 3-64 символа `[a-zA-Z0-9_-]` |

### Полная диагностика
1. **n8n UI → Executions** — найти последнее выполнение workflow `[GigaChat] Plane-агент. Поток`
2. Кликнуть → видны все узлы и input/output каждого
3. Красный узел = ошибка. Output ноды содержит детали
4. Особенно полезно посмотреть `Контекст: проекты` (загрузка projects), `Direct resolve` / `Parse LLM` (резолв params), `resolve: extended` (поиск issue + state), и финальный HTTP узел (PATCH/GET/POST)

### Логи Plane
Если в n8n всё ок, но Plane возвращает странное:
```bash
docker logs plane-api 2>&1 | tail -50
docker logs plane-worker 2>&1 | tail -50
```

---

## Сводка по чек-листу

После полного прохождения должны работать:
- ✅ Все 14 actions через Direct Test
- ✅ Канбан-доска: 4 колонки + drag-drop
- ✅ Чат: 9 LLM-actions (всё кроме assign/labels/bulk)
- ✅ Шаблоны: 3 hardcoded префикса
- ✅ Smart-даты в естественной речи
- ⚠️ Bulk: только preview, реальное выполнение TODO
- ⚠️ Assign/labels: только Direct Test (LLM не знает UUID)

Если есть пункты с ❌ — присылать в виде:
1. Screenshot ошибки
2. n8n Executions → найти upstream node ошибки → копировать JSON-output
3. Сообщить в формате: «Action X, шаг N, было Y, ожидалось Z»
