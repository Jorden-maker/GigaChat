# Планировщик — инструкция

Инструмент GigaChat-платформы для ведения списка задач + AI-помощника для
планирования. Архитектурно делится на три слоя: HTML-страница →
n8n workflow → PostgreSQL.

## Оглавление

- [Что это и зачем](#что-это-и-зачем)
- [Архитектура](#архитектура)
- [Настройка БД](#настройка-бд)
- [Как работает workflow](#как-работает-workflow)
- [Как работает HTML-страница](#как-работает-html-страница)
- [Что можно настраивать](#что-можно-настраивать)
- [Диагностика](#диагностика)

---

## Что это и зачем

Юзер пишет задачи (название, описание, приоритет, срок). Видит активные,
отмечает выполненные, удаляет, редактирует. Дополнительно может спросить
GigaChat-LLM:

- «План на неделю» — AI распределит активные задачи по дням
- «Что просрочено» — отметит задачи с дедлайном в прошлом
- «Топ-3 на сегодня» — выберет самое срочное по приоритету+дедлайну

История AI-диалога живёт в `chat_memory` (общая таблица с остальными
чат-агентами), задачи — в отдельной таблице `planner_tasks`.

## Архитектура

```
Браузер
  ↓ http://server:8765/Agents/planner.html
HTML-страница (Agents/planner.html)
  ├── Сайдбар сессий (= списков задач)
  ├── Панель задач (CRUD: добавить/отметить/изменить/удалить)
  └── AI-чат для запросов о планировании
  ↓ POST /webhook/planner {action, session_id, ...}
n8n workflow (Workflow/planner.json)
  ├── Валидация → IF valid? → Switch(action)
  │     ├── list   → SELECT
  │     ├── create → INSERT
  │     ├── update → UPDATE
  │     ├── delete → DELETE
  │     └── query  → SELECT active + LLM + сохранить в chat_memory
  └── respondToWebhook → JSON ответ
  ↓
PostgreSQL
  ├── planner_tasks  (id, session_id, title, description, priority, deadline, status, completed_at, created_at)
  └── chat_memory    (общая с остальными агентами — для истории AI-диалога)
```

Сессии = разные списки задач: «Личные», «Работа», «Проект Х». Каждая
сессия независимая, `session_id` — это первичный ключ группировки.

## Настройка БД

База PostgreSQL — общая с остальными агентами GigaChat (`ai_agent` по
умолчанию). Таблица `planner_tasks` нужна только этому инструменту.

### Если БД уже работает (n8n использует chat_memory и др.)

Достаточно прогнать одну миграцию — добавить таблицу планировщика:

**Если сервер на Linux + PostgreSQL в Docker:**
```bash
# Перенести planner-schema.sql на сервер (scp/rsync через флэшку,
# см. Linux/README.md общий поток обновлений).
# Имя контейнера Postgres подставь своё (узнать: `docker ps`).
cat planner-schema.sql | docker exec -i <postgres-container> psql -U postgres -d ai_agent
```

**Если PostgreSQL на Windows напрямую (без Docker):**
```powershell
psql -U postgres -d ai_agent -f planner-schema.sql
```

После выполнения должна вывестись строка `planner_tasks готов.`

### Если БД ещё не создана

Сначала пройди по [PostgreSQL-Guide.md](../PostgreSQL-Guide.md) — там
описано создание БД `ai_agent`, всех остальных таблиц + индексов.
Таблица `planner_tasks` уже включена в основной CREATE-блок гайда
(раздел 8 в SQL), так что отдельная миграция не нужна. Файл
`planner-schema.sql` остаётся в этой папке как самостоятельный модуль —
полезен если планировщик ставится отдельно или как docs.

### Схема таблицы

```sql
CREATE TABLE planner_tasks (
    id          SERIAL PRIMARY KEY,
    session_id  VARCHAR(255) NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    priority    VARCHAR(10) DEFAULT 'medium'
                CHECK (priority IN ('low','medium','high')),
    deadline    DATE,
    status      VARCHAR(20) DEFAULT 'active'
                CHECK (status IN ('active','completed')),
    completed_at TIMESTAMP,
    created_at   TIMESTAMP DEFAULT NOW()
);
```

Два индекса под основные запросы:
- `(session_id, status, created_at DESC)` — основной (фильтр Активные/Выполненные)
- `(session_id, deadline) WHERE deadline IS NOT NULL` — для запросов про просрочку

## Как работает workflow

Файл: `Workflow/planner.json`. **21 нода, 19 connections.**

### Точка входа

Один webhook `POST /webhook/planner`. В body ожидается JSON:

```json
{
  "action": "list" | "create" | "update" | "delete" | "query",
  "session_id": "planner_XXXX",
  ...поля по action
}
```

### Валидация (node «Валидация»)

Code-node проверяет:
- `session_id` обязателен, формат `^[a-zA-Z0-9_-]+$` (защита от SQL-инъекции
  на уровне формата)
- `action` ∈ {list, create, update, delete, query}; если не указан, но
  есть `message` — дефолтится в `query` (chat-agent на странице через
  `createChatAgent` шлёт `{message, session_id}`)
- Поля per-action:
  - `create`: `title` обязателен, ≤500 симв; `description` ≤5000;
    `priority` ∈ {low,medium,high}; `deadline` формат YYYY-MM-DD
  - `update`: `id` обязателен; остальные поля опциональны — что передал,
    то и обновится через COALESCE
  - `delete`: `id` обязателен
  - `query`: `message` обязателен, ≤5000 симв
  - `list`: `filter` ∈ {active, completed, all}, дефолт active
- Ping (`message=ping` или `action=ping`) — возвращает `{response:'pong'}`,
  без обращения к БД. Нужно для индикатора статуса на дашборде платформы.

Невалидный запрос → ветка «Ответ: ошибка» с JSON `{response, action}`.

### Switch + 5 веток

#### list — SELECT задач
```sql
SELECT id, title, description, priority, deadline, status, completed_at, created_at
FROM planner_tasks
WHERE session_id = $1 AND ($2 = 'all' OR status = $2)
ORDER BY status ASC,
         (CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END),
         COALESCE(deadline, '9999-12-31'::date) ASC,
         created_at DESC
```
Сортировка: сначала активные, затем по приоритету, затем по дедлайну
(NULL в конец), затем по дате создания. Code-node «Собрать tasks»
оборачивает в `{response:'ok', tasks:[...]}`.

#### create — INSERT
```sql
INSERT INTO planner_tasks (session_id, title, description, priority, deadline)
VALUES ($1, $2, NULLIF($3,''), $4, NULLIF($5,'')::date)
RETURNING ...
```
`NULLIF` нужен потому что фронт шлёт пустые строки, а в БД должны быть
NULL. Возврат: `{response:'ok', task:{...}}`.

#### update — UPDATE с COALESCE для частичного обновления
```sql
UPDATE planner_tasks SET
  title       = COALESCE($3, title),
  description = COALESCE($4, description),
  priority    = COALESCE($5, priority),
  deadline    = CASE WHEN $6::boolean THEN deadline ELSE NULLIF($7,'')::date END,
  status      = COALESCE($8, status),
  completed_at = CASE
    WHEN COALESCE($8, status) = 'completed' AND completed_at IS NULL THEN NOW()
    WHEN COALESCE($8, status) = 'active' THEN NULL
    ELSE completed_at
  END
WHERE id = $1 AND session_id = $2
RETURNING ...
```

Особенности:
- `COALESCE` — если поле не передано (null), оставить старое значение
- `deadline` обрабатывается отдельно: фронт шлёт `'__keep__'` если поле
  не редактировалось, либо новую дату/null. Boolean `_keep_deadline`
  передаётся в SQL.
- `completed_at` автоматически проставляется в NOW() при переводе
  active→completed и сбрасывается в NULL при completed→active.
- `WHERE session_id = $2` — защита от случайного редактирования задачи
  чужой сессии.

#### delete — DELETE
```sql
DELETE FROM planner_tasks WHERE id = $1 AND session_id = $2 RETURNING id
```
Тот же session_id-guard. Если задача не принадлежит сессии (или не
существует), `RETURNING id` пустой → ответ `{response:'not_found'}`.

#### query — AI-планирование
1. SELECT все активные задачи сессии (LIMIT 100)
2. Code-node форматирует список в текст для промпта:
   ```
   1. [Приоритет: высокий (до 2026-05-23)] Доклад по проекту X
      Описание: обсуждение архитектуры
   2. [Приоритет: средний] Купить продукты
   ...
   ```
3. Собирается системный промпт с правилами:
   - Сегодня: дата сервера
   - Список активных задач
   - Правила: уважать приоритеты, дедлайны, подсвечивать просроченное,
     не выдумывать задачи которых нет в списке
4. LLM-нода (GigaChat) с temperature=0.3
5. Сохранение в `chat_memory`: одной транзакцией INSERT user + assistant
   с `pg_advisory_xact_lock(hashtext(session_id))` чтобы избежать
   race condition'ов с параллельными запросами в той же сессии.
6. Возврат `{response: text}`.

### Финальный Respond

Все 5 веток сходятся в единственный node «Ответ: OK» (`respondToWebhook`)
с responseBody `={{ JSON.stringify($json) }}`. CORS-заголовки:
`Access-Control-Allow-Origin: *`.

## Как работает HTML-страница

Файл: `Agents/planner.html`. **~50 КБ.**

### Структура DOM

- `.sidebar` — слева, сессии (используется общий `_shared.js`
  через `createChatAgent`, поэтому идентично остальным чат-агентам)
- `.main` — основная область:
  - `header` — заголовок + статус-индикатор + Экспорт
  - `#tasks-panel` — панель задач: фильтры (Активные/Выполненные/Все),
    кнопка «+ Задача», список карточек задач
  - `#chat` — AI-диалог (history-loaded из chat_memory через `/webhook/history`)
  - `.bottom-area` — textarea для AI-запросов + send-кнопка
- `#taskModal` — модалка добавления/редактирования (overlay + центрированная карточка)

### Жизненный цикл

1. **Загрузка страницы.** `_shared.js` инициализирует sessionStore из
   localStorage (префикс `planner_`). Если сессии есть — активирует
   последнюю; если нет — пустое состояние.

2. **При переключении сессии** (`onSwitchExtra` колбэк):
   - Обновляется `currentSessionId`
   - Запускается `loadTasks()` → `POST /webhook/planner {action:'list', session_id, filter}`
   - История AI-диалога подгружается через стандартный `/webhook/history`
     (как в остальных чат-агентах)

3. **Добавление задачи** (клик «+ Задача»):
   - Открывается модалка (`openTaskModal()`)
   - При первом открытии инициализируются custom dropdown (`initPrioritySelect`)
     и custom datepicker (`initDatepicker`)
   - При сохранении (`saveTask`) → `POST /webhook/planner {action:'create', ...}`
   - Перезагрузка списка задач

4. **Редактирование** (клик на тело задачи):
   - Та же модалка с заголовком «Изменить задачу»
   - Поля заполняются текущими значениями
   - `editingTaskId` хранит id редактируемой задачи
   - На save → `action:'update', id:<editingTaskId>`

5. **Отметить выполненной** (клик на чекбокс):
   - Оптимистично меняем `status` в локальном `currentTasks` + перерендериваем
   - `POST /webhook/planner {action:'update', id, status:'completed'/'active'}`
   - При ошибке откатываем + alert

6. **Удаление** (клик на ×):
   - confirm()
   - `POST /webhook/planner {action:'delete', id}`
   - Перезагрузка списка

7. **AI-запрос** (textarea внизу):
   - Использует стандартный `createChatAgent` из `_shared.js`
   - Шлёт `POST /webhook/planner {message, session_id}` (без action — workflow дефолтит в query)
   - Ответ отображается в чат-области + сохраняется в `chat_memory`

### Кастомные UI-компоненты

Всё на странице кастомизировано — нативные элементы заменены своими:

- **`.gc-select`** (приоритет) — кастомный dropdown на div'ах вместо
  `<select>`. Своя стрелка, hover, selected, плавная анимация. Click
  toggle, outside-click close, Esc close.

- **`.gc-datepicker`** (срок выполнения) — полный кастомный календарь
  вместо `<input type="date">`. Внутреннее значение YYYY-MM-DD,
  отображение DD.MM.YYYY. Popup открывается ВВЕРХ (date — последнее
  поле модалки). Месяц вперёд/назад, Сегодня, Закрыть.

- **Кастомный скроллбар** модалки (Webkit + Firefox).

- **SVG-плюс** на кнопке «+ Задача» с flex-выравниванием.

- **Чекбоксы задач** — CSS-only через ::after с `border 0 2px 2px 0`
  + rotate (имитация ✓), accent цвет.

- **Priority-badges** — фоны `--priority-high/medium/low`, uppercase,
  letter-spacing.

## Что можно настраивать

| Что | Где | Как |
|---|---|---|
| Цвет приоритетов | `Agents/planner.html` CSS | переменные `--priority-high/medium/low` |
| Лимит задач в AI-контексте | `Workflow/planner.json` | в SELECT для query — `LIMIT 100` |
| Сортировка задач в списке | `Workflow/planner.json` | ORDER BY в action=list |
| Доступные приоритеты | `Workflow/planner.json` + `Agents/planner.html` + `Планировщик/planner-schema.sql` | три места: CHECK constraint в SQL, валидация в workflow, options в HTML |
| LLM-температура для AI-запросов | `Workflow/planner.json` | нода «LLM: ответ» → options.temperature (по умолчанию 0.3) |
| Системный промпт AI | `Workflow/planner.json` | нода «Собрать промпт», переменная `systemPrompt` |
| Текст пустого состояния | `Agents/planner.html` | `emptyChatHtml`, `tasks-empty` |

## Диагностика

### «Failed to execute 'json' on 'Response': Unexpected end of JSON input»

n8n не вернул JSON. Самая частая причина — **таблица `planner_tasks`
не создана**. SQL INSERT/SELECT падает, workflow обрывается до
respondToWebhook, фронт получает пустой body.

**Проверка:**
```sql
\dt planner_tasks
```
Если пусто — запусти миграцию (`psql ... -f planner-schema.sql`,
см. раздел [Настройка БД](#настройка-бд)).

Другие причины:
- Workflow не активирован в n8n (открой `http://server:5678/`, проверь)
- n8n не запущен (Docker контейнер упал)
- Postgres-credentials в workflow указывают не на тот сервер БД

### «Создайте список задач, потом спланируйте...» (empty state) висит, не открывается

Браузер не подгрузил `_shared.js` или ошибка инициализации
`createChatAgent`. Открой DevTools (F12) → Console — там будет красная
ошибка. Типичное: отсутствует один из ожидаемых DOM-якорей
(`#chat`, `#msg`, `#send`, `#sessionList`, `#statusDot`, `#statusText`,
`#attachBtn`, `#attachChips`). См. коммит `4cc822a` за прецедент.

### Карточка планировщика на дашборде показывает «Офлайн»

Ping не доходит до workflow. Проверки:
1. Workflow активен? (n8n UI → planner → toggle Active)
2. `webhookPath` в HTML и `path` в webhook-ноде workflow совпадают? (`planner`)
3. CORS — на дашборде fetch с другого origin'а, n8n должен отвечать
   `Access-Control-Allow-Origin: *` (в workflow эти заголовки уже стоят)

### AI отвечает «LLM недоступен» / «Пустой ответ»

GigaChat-LLM не достучался. Проверки:
1. Endpoint GigaChat-LLM запущен (см. project memory rude-coffee и др.)
2. Credentials `Qwyuj8GrADL2wlnl` в workflow указывают на правильный
   URL модели
3. timeout LLM-ноды (60 сек) — увеличить если LLM медленный

### Задачи не сортируются как ожидаешь

Сортировка фиксирована в SELECT-запросе action=list. Чтобы изменить —
правь ORDER BY в `Workflow/planner.json` (нода «SQL: list tasks»), не
во фронте. После правки — Re-import workflow в n8n.

### Просроченные задачи не подсвечиваются красным

Подсветка во фронте: `today < deadline` (string compare). Если задача
имеет `deadline=null` — не overdue. Если строка дедлайна не в формате
YYYY-MM-DD — компаратор не сработает. Проверь что валидация в workflow
не сломалась (правильный regex `^\d{4}-\d{2}-\d{2}$`).

### Сессии в разных вкладках не синхронизируются

Они и не должны. Каждая вкладка — отдельный sessionStore с собственными
сессиями в localStorage. Если хочешь шарить список задач — копируй
session_id (хранится в localStorage по ключу `planner_active`).

### Backup задач

```bash
docker exec <postgres-container> pg_dump -U postgres -d ai_agent -t planner_tasks > planner_backup.sql
```

Восстановить:
```bash
cat planner_backup.sql | docker exec -i <postgres-container> psql -U postgres -d ai_agent
```
