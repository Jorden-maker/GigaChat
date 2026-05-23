# PostgreSQL для GigaChat — практический гайд

> Только то, что реально нужно для запуска и поддержки в офисе.
> Всё работает в локальной сети, без интернета.
>
> **Имя БД:** `ai_agent` (создаётся в разделе 3).
> **Настройка таблиц алгоритма «Организация обращения»** — отдельный гайд: [OrgAppeal-Setup.md](OrgAppeal-Setup.md).

## Содержание

1. [Установка PostgreSQL](#1-установка-postgresql)
2. [Установка PGVector](#2-установка-pgvector)
3. [Создание базы и таблиц](#3-создание-базы-и-таблиц)
4. [Подключение n8n](#4-подключение-n8n)
5. [Доступ из локальной сети](#5-доступ-из-локальной-сети)
6. [Бэкап и восстановление](#6-бэкап-и-восстановление)
7. [Шпаргалка администратора](#7-шпаргалка-администратора)
8. [Если что-то сломалось](#8-если-что-то-сломалось)
9. [Полный SQL-справочник по этой базе](#9-полный-sql-справочник-по-этой-базе)
10. [Миграция существующей БД при обновлении проекта](#10-миграция-существующей-бд-при-обновлении-проекта)

---

## 1. Установка PostgreSQL

### Скачать и установить

1. Сайт: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads
2. Скачать **PostgreSQL 16** (или новее) для Windows x86-64
3. Запустить `.exe`, везде **Next** с дефолтами
4. На шаге **Password** — задать пароль для пользователя `postgres` (запомнить!)
5. Порт оставить `5432`, locale — `[Default locale]`
6. Снять галку «Launch Stack Builder»

### Проверить что работает

Открыть `cmd`:

```
psql --version
pg_isready
```

Должно появиться `psql (PostgreSQL) 16.x` и `localhost:5432 - accepting connections`.

Если `psql` не найден — добавить в PATH:
1. Win+R → `sysdm.cpl` → **Дополнительно** → **Переменные среды**
2. В **Path** добавить `C:\Program Files\PostgreSQL\16\bin`
3. Закрыть и заново открыть cmd

Если сервер не запущен — `net start postgresql-x64-16` (или через `services.msc`).

---

## 2. Установка PGVector

PGVector — расширение для векторных эмбеддингов, нужно для RAG-агента и загрузчика документов.

### Через SQL (если уже установлено)

```
psql -U postgres
```

```sql
\c ai_agent
CREATE EXTENSION IF NOT EXISTS vector;
```

Если ошибки нет — расширение работает. Если `could not open extension control file` — устанавливаем вручную.

### Установка вручную

1. Скачать с https://github.com/pgvector/pgvector/releases (Windows-сборку)
2. Скопировать файлы:
   - `vector.dll` → `C:\Program Files\PostgreSQL\16\lib\`
   - `vector.control` и `vector--*.sql` → `C:\Program Files\PostgreSQL\16\share\extension\`
3. Перезапустить сервер: `net stop postgresql-x64-16 && net start postgresql-x64-16`
4. Снова выполнить `CREATE EXTENSION vector;`

### Проверка

```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

Если строка появилась — всё работает.

---

## 3. Создание базы и таблиц

Подключиться:

```
psql -U postgres
```

Создать базу и таблицы одним скриптом — скопируй и выполни целиком:

```sql
-- 1. База данных
CREATE DATABASE ai_agent;
\c ai_agent

-- 2. Расширение для векторов
CREATE EXTENSION IF NOT EXISTS vector;

-- 3. Клиенты (для SQL-агента)
CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255),
    email VARCHAR(255),
    revenue DECIMAL(15, 2),
    created_at DATE DEFAULT CURRENT_DATE
);

-- 4. Заказы (для SQL-агента)
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id),
    product VARCHAR(255),
    amount DECIMAL(15, 2),
    status VARCHAR(50),
    order_date DATE DEFAULT CURRENT_DATE
);

-- 5. Документы с эмбеддингами (для RAG-агента)
CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(500) NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding vector(1024),
    created_at TIMESTAMP DEFAULT NOW(),
    -- UNIQUE нужен для ON CONFLICT в document-loader workflow: при
    -- повторной загрузке одного и того же файла чанки обновляются
    -- (UPDATE), а не дублируются. Без этого constraint в БД накапливались
    -- бы дубли, и RAG-выдача показывала бы 2x, 3x копии «разных
    -- релевантных источников».
    CONSTRAINT documents_filename_chunk_unique UNIQUE (filename, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_documents_embedding
ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_documents_filename ON documents (filename);

-- ⚠️ Если таблица documents УЖЕ существует без UNIQUE constraint, добавь
-- его отдельно (предварительно очистив возможные дубли):
--   DELETE FROM documents a USING documents b
--     WHERE a.id > b.id AND a.filename = b.filename AND a.chunk_index = b.chunk_index;
--   ALTER TABLE documents ADD CONSTRAINT documents_filename_chunk_unique UNIQUE (filename, chunk_index);

-- 6. История диалогов (используется всеми агентами)
CREATE TABLE IF NOT EXISTS chat_memory (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    extras JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_memory_session
ON chat_memory (session_id, created_at);

-- 7. Резюме длинных диалогов (для chat-agent)
CREATE TABLE IF NOT EXISTS chat_summaries (
    session_id VARCHAR(255) PRIMARY KEY,
    summary_text TEXT,
    messages_summarized INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 8. Задачи планировщика (инструмент «Планировщик»)
CREATE TABLE IF NOT EXISTS planner_tasks (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority VARCHAR(10) DEFAULT 'medium'
        CHECK (priority IN ('low','medium','high')),
    deadline DATE,
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active','completed')),
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_session_status
ON planner_tasks (session_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_deadline
ON planner_tasks (session_id, deadline) WHERE deadline IS NOT NULL;

\dt
SELECT 'Готово!' AS result;
```

После выполнения `\dt` должен показать 6 таблиц.

### Если БД уже существует — миграция для `extras`

Если ты обновляешься со старой версии и колонки `extras` нет:

```sql
\c ai_agent
ALTER TABLE chat_memory ADD COLUMN IF NOT EXISTS extras JSONB;
```

### Полная инициализация БД с нуля

Используй `База данных/init-db.sql` (см. [`README.md`](README.md)). Один файл,
все таблицы проекта (включая `planner_*`, `chat_memory`, `documents`,
`appeal_*` и прочие), все расширения (pgvector, pgcrypto), тестовые данные.

```sql
\c ai_agent
\i /path/to/GigaChat/База данных/init-db.sql
```

Если БД уже существует и нужны только таблицы планировщика — извлеки нужные
блоки `CREATE TABLE planner_*` из `init-db.sql` и запусти их вручную.

### Размерность вектора

В таблице `documents` указано `vector(1024)` — это размерность модели **Multilingual-E5-large**, которая используется по умолчанию.

Развернуть локальный сервис эмбеддингов с этой моделью (полностью офлайн, в корпоративной LAN) — пошаговый гайд в **[embedding-server/README.md](embedding-server/README.md)**: подготовка папки модели, установка Python и зависимостей, запуск сервера, проверка работы, подключение к n8n, автозапуск через Task Scheduler / systemd, и решение частых проблем.

Если ваша модель эмбеддинга возвращает векторы другой размерности — поменяй число в скобках. Для `e5-base` — `vector(768)`, для `e5-small` — `vector(384)`.

---

## 4. Подключение n8n

В n8n: **Credentials → New → Postgres**.

| Поле | Значение |
|------|----------|
| Host | `localhost` (или IP сервера БД) |
| Database | `ai_agent` |
| User | `postgres` |
| Password | твой пароль |
| Port | `5432` |
| SSL | отключён |

Имя credential — `Postgres` (это имя ожидают все workflow).

---

## 5. Доступ из локальной сети

Нужно только если **n8n запущен на другой машине** чем PostgreSQL. Если всё на одном сервере — пропусти раздел.

### Шаг 1. Разрешить подключения извне

Открой `C:\Program Files\PostgreSQL\16\data\postgresql.conf`, найди строку:

```
#listen_addresses = 'localhost'
```

Заменить на:

```
listen_addresses = '*'
```

### Шаг 2. Разрешить аутентификацию из подсети

Открой `C:\Program Files\PostgreSQL\16\data\pg_hba.conf`, добавь строку (под нужную подсеть, например `192.168.0.0/16`):

```
host    ai_agent    postgres    192.168.0.0/16    scram-sha-256
```

### Шаг 3. Открыть порт 5432 в firewall

Windows Defender → Дополнительные параметры → Правила для входящих → Создать правило → Порт → TCP 5432 → Разрешить.

### Шаг 4. Перезапустить PostgreSQL

```
net stop postgresql-x64-16
net start postgresql-x64-16
```

Проверка с другой машины: `psql -h IP_СЕРВЕРА_БД -U postgres -d ai_agent`.

---

## 6. Бэкап и восстановление

### Бэкап одной командой

```
pg_dump -U postgres -d ai_agent -Fc -f backup.dump
```

Параметр `-Fc` — сжатый формат (сильно меньше по размеру).

### Автоматический ежедневный бэкап (Task Scheduler)

Создай файл `C:\GigaChat\backup.bat`:

```bat
@echo off
set BACKUP_DIR=C:\GigaChat\backups
set TS=%date:~6,4%-%date:~3,2%-%date:~0,2%
pg_dump -U postgres -d ai_agent -Fc -f "%BACKUP_DIR%\ai_agent_%TS%.dump"
```

В Task Scheduler: создать ежедневную задачу → запускать `backup.bat`.

### Восстановление

Если база уже создана и пустая:

```
pg_restore -U postgres -d ai_agent backup.dump
```

Если нужно полностью перезаписать:

```
pg_restore -U postgres -d ai_agent --clean backup.dump
```

---

## 7. Шпаргалка администратора

### Зайти в БД

```
psql -U postgres -d ai_agent
```

### Базовые команды psql

| Команда | Описание |
|---------|----------|
| `\dt` | Список таблиц |
| `\d <таблица>` | Структура таблицы |
| `\dx` | Установленные расширения |
| `\du` | Список пользователей |
| `\l` | Список баз данных |
| `\c <база>` | Переключиться на другую базу |
| `\q` | Выйти |
| `\timing` | Показывать время выполнения запросов |

### Размер базы и таблиц

```sql
-- Размер всей базы
SELECT pg_size_pretty(pg_database_size('ai_agent'));

-- Размер каждой таблицы
SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size('public.' || tablename)) AS size,
    n_live_tup AS rows
FROM pg_tables t
LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size('public.' || tablename) DESC;
```

### Документы в базе знаний

```sql
-- Список загруженных документов
SELECT filename, COUNT(*) AS chunks, MIN(created_at) AS uploaded
FROM documents
GROUP BY filename
ORDER BY uploaded DESC;

-- Удалить конкретный документ
DELETE FROM documents WHERE filename = 'имя_файла.pdf';

-- Очистить всю базу знаний (ОСТОРОЖНО!)
TRUNCATE TABLE documents RESTART IDENTITY;
```

### История чатов

```sql
-- Активные сессии (по последней активности)
SELECT
    session_id,
    COUNT(*) AS messages,
    MIN(created_at) AS started,
    MAX(created_at) AS last_msg
FROM chat_memory
GROUP BY session_id
ORDER BY last_msg DESC
LIMIT 50;

-- Сообщения конкретной сессии
SELECT role, LEFT(content, 100) AS msg, created_at
FROM chat_memory
WHERE session_id = 'ВАШ_SESSION_ID'
ORDER BY created_at;

-- Удалить историю сессии
DELETE FROM chat_memory WHERE session_id = 'ВАШ_SESSION_ID';
DELETE FROM chat_summaries WHERE session_id = 'ВАШ_SESSION_ID';

-- Удалить старую историю (старше 90 дней)
DELETE FROM chat_memory WHERE created_at < NOW() - INTERVAL '90 days';

-- Очистить ВСЕ чаты (ОСТОРОЖНО!)
TRUNCATE TABLE chat_memory RESTART IDENTITY;
TRUNCATE TABLE chat_summaries;
```

### Тестовые данные для clients/orders

Когда нужно проверить работу SQL-агента, заполни таблицы тестовыми данными:

```sql
INSERT INTO clients (name, city, email, revenue) VALUES
('ООО Ромашка', 'Москва', 'romashka@mail.ru', 1500000.00),
('ООО Василёк', 'Казань', 'vasilek@mail.ru', 800000.00),
('ИП Иванов А.В.', 'Воронеж', 'ivanov@mail.ru', 350000.00),
('ЗАО Рассвет', 'Сочи', 'rassvet@mail.ru', 2200000.00),
('ООО ТехноСервис', 'Москва', 'techno@mail.ru', 4100000.00);

INSERT INTO orders (client_id, product, amount, status, order_date) VALUES
(1, 'Сервер HP ProLiant', 450000.00, 'delivered', '2026-01-15'),
(2, 'Ноутбук Lenovo', 120000.00, 'delivered', '2026-01-20'),
(3, 'Принтер Canon', 28000.00, 'delivered', '2026-03-01'),
(4, 'Видеонаблюдение', 320000.00, 'pending', '2026-04-15'),
(5, 'СХД NetApp', 850000.00, 'delivered', '2026-03-20');
```

---

## 8. Если что-то сломалось

### Не подключается → `connection refused`

Сервер не запущен:
```
net start postgresql-x64-16
```

Проверить статус:
```
pg_isready
```

### Не подключается → `password authentication failed`

Неверный пароль. Если забыл — сбросить:

1. Открыть `C:\Program Files\PostgreSQL\16\data\pg_hba.conf`
2. Заменить `scram-sha-256` на `trust` в строке для localhost
3. Перезапустить сервер
4. Подключиться без пароля и сменить:
   ```sql
   ALTER USER postgres WITH PASSWORD 'новый_пароль';
   ```
5. Вернуть `scram-sha-256` обратно
6. Перезапустить сервер ещё раз

### `relation "X" does not exist`

Таблицы нет в текущей базе. Проверить:

```sql
SELECT current_database();
\dt
```

Возможно ты не в той базе — `\c ai_agent`. Если таблиц действительно нет — выполни скрипт из раздела 3.

### `could not open extension control file "vector.control"`

PGVector не установлен. См. раздел 2 (установка вручную).

### `different vector dimensions`

В `documents.embedding` стоит размерность 1024, а API эмбеддинга возвращает другую. Проверить:

```sql
\d documents
```

Если нужно изменить — пересоздать таблицу с правильной размерностью или заменить столбец:
```sql
ALTER TABLE documents ALTER COLUMN embedding TYPE vector(NEW_DIM);
```
(может потребоваться пересчёт всех существующих векторов)

### Зависший запрос

Найти активные запросы:
```sql
SELECT pid, state, query, query_start
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start;
```

Убить:
```sql
SELECT pg_cancel_backend(PID);       -- мягко (запрос отменится)
SELECT pg_terminate_backend(PID);    -- жёстко (если cancel не помог)
```

### Логи PostgreSQL

```
C:\Program Files\PostgreSQL\16\data\log\
```

Самый свежий файл — текущий лог. Открывать обычным текстовым редактором.

---

## 9. Полный SQL-справочник по этой базе

Все команды ниже — для базы `ai_agent` с твоими 5 таблицами. Подключайся:

```
psql -U postgres -d ai_agent
```

### 9.1. Таблица `clients`

#### Просмотр

```sql
-- Все клиенты
SELECT * FROM clients;

-- Конкретные колонки
SELECT name, city, revenue FROM clients;

-- Первые 10 строк
SELECT * FROM clients LIMIT 10;

-- Найти по имени (частичное совпадение, без учёта регистра)
SELECT * FROM clients WHERE name ILIKE '%ромашка%';

-- Клиенты из конкретного города
SELECT * FROM clients WHERE city = 'Москва';

-- Клиенты из нескольких городов
SELECT * FROM clients WHERE city IN ('Москва', 'Казань', 'Сочи');

-- С выручкой больше миллиона
SELECT * FROM clients WHERE revenue > 1000000;

-- В диапазоне выручки
SELECT * FROM clients WHERE revenue BETWEEN 500000 AND 2000000;

-- Сортировка по выручке (по убыванию)
SELECT name, revenue FROM clients ORDER BY revenue DESC;

-- Топ-5 по выручке
SELECT name, revenue FROM clients ORDER BY revenue DESC LIMIT 5;

-- Без email
SELECT * FROM clients WHERE email IS NULL;

-- С email на mail.ru
SELECT * FROM clients WHERE email LIKE '%@mail.ru';

-- Добавленные за последние 30 дней
SELECT * FROM clients WHERE created_at >= CURRENT_DATE - INTERVAL '30 days';

-- Подсчёт
SELECT COUNT(*) FROM clients;
SELECT COUNT(*) FROM clients WHERE city = 'Москва';
```

#### Добавление

```sql
-- Одного клиента
INSERT INTO clients (name, city, email, revenue)
VALUES ('ООО Ромашка', 'Москва', 'romashka@mail.ru', 1500000.00);

-- Несколько за раз
INSERT INTO clients (name, city, email, revenue) VALUES
('ООО Василёк', 'Казань', 'vasilek@mail.ru', 800000.00),
('ИП Иванов', 'Воронеж', 'ivanov@mail.ru', 350000.00);

-- Только обязательные поля (остальное возьмёт дефолты или NULL)
INSERT INTO clients (name) VALUES ('Тестовый клиент');

-- Вернуть id новой строки
INSERT INTO clients (name, city) VALUES ('Тест', 'Москва') RETURNING id;
```

#### Изменение

```sql
-- Обновить город конкретному клиенту
UPDATE clients SET city = 'Санкт-Петербург' WHERE id = 1;

-- Несколько полей сразу
UPDATE clients SET city = 'Казань', revenue = 2000000.00 WHERE id = 2;

-- Поднять выручку всем московским на 10%
UPDATE clients SET revenue = revenue * 1.1 WHERE city = 'Москва';

-- Установить email тем, у кого его нет
UPDATE clients SET email = 'unknown@example.com' WHERE email IS NULL;
```

#### Удаление

```sql
-- Конкретного клиента
DELETE FROM clients WHERE id = 5;

-- Всех из определённого города
DELETE FROM clients WHERE city = 'Воронеж';

-- Клиентов без email
DELETE FROM clients WHERE email IS NULL;

-- ОСТОРОЖНО: всех клиентов
TRUNCATE TABLE clients RESTART IDENTITY CASCADE;
-- CASCADE удалит связанные заказы из orders
```

---

### 9.2. Таблица `orders`

#### Просмотр

```sql
-- Все заказы
SELECT * FROM orders ORDER BY order_date DESC LIMIT 50;

-- По статусу
SELECT * FROM orders WHERE status = 'pending';
SELECT * FROM orders WHERE status IN ('pending', 'delivered');

-- За период
SELECT * FROM orders WHERE order_date BETWEEN '2026-01-01' AND '2026-06-30';
SELECT * FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '7 days';

-- На сумму больше N
SELECT * FROM orders WHERE amount > 100000;

-- Заказы конкретного клиента
SELECT * FROM orders WHERE client_id = 1;

-- Сколько заказов всего
SELECT COUNT(*) FROM orders;

-- По статусам — сводка
SELECT status, COUNT(*) AS cnt, SUM(amount) AS total
FROM orders
GROUP BY status;
```

#### Добавление

```sql
-- Один заказ
INSERT INTO orders (client_id, product, amount, status, order_date)
VALUES (1, 'Сервер HP', 450000.00, 'pending', CURRENT_DATE);

-- Несколько
INSERT INTO orders (client_id, product, amount, status, order_date) VALUES
(1, 'Лицензия Windows', 85000.00, 'delivered', '2026-02-10'),
(2, 'Ноутбук Lenovo', 120000.00, 'delivered', '2026-01-20');
```

#### Изменение

```sql
-- Сменить статус
UPDATE orders SET status = 'delivered' WHERE id = 10;

-- Все pending за прошлый месяц перевести в cancelled
UPDATE orders
SET status = 'cancelled'
WHERE status = 'pending' AND order_date < CURRENT_DATE - INTERVAL '30 days';

-- Скидка 5% на все delivered за март
UPDATE orders SET amount = amount * 0.95
WHERE status = 'delivered' AND order_date BETWEEN '2026-03-01' AND '2026-03-31';
```

#### Удаление

```sql
-- Конкретный заказ
DELETE FROM orders WHERE id = 10;

-- Все отменённые
DELETE FROM orders WHERE status = 'cancelled';

-- Все заказы клиента
DELETE FROM orders WHERE client_id = 5;

-- ОСТОРОЖНО: все заказы
TRUNCATE TABLE orders RESTART IDENTITY;
```

---

### 9.3. Таблица `documents` (PGVector)

#### Просмотр

```sql
-- Список всех загруженных файлов
SELECT filename, COUNT(*) AS chunks, MIN(created_at) AS uploaded
FROM documents
GROUP BY filename
ORDER BY uploaded DESC;

-- Куски конкретного файла
SELECT chunk_index, LEFT(chunk_text, 100) AS preview
FROM documents
WHERE filename = 'договор.pdf'
ORDER BY chunk_index;

-- Полный текст куска
SELECT chunk_text FROM documents WHERE id = 42;

-- Сколько кусков всего
SELECT COUNT(*) FROM documents;

-- Сколько уникальных документов
SELECT COUNT(DISTINCT filename) FROM documents;

-- Файлы за последнюю неделю
SELECT DISTINCT filename FROM documents
WHERE created_at >= NOW() - INTERVAL '7 days';
```

#### Векторный поиск (похожие куски)

```sql
-- Топ-5 самых похожих кусков на заданный вектор
-- (вектор должен быть длиной 1024)
SELECT filename, chunk_index, LEFT(chunk_text, 200) AS preview,
       1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS similarity
FROM documents
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 5;

-- С фильтром по similarity > 0.3
SELECT filename, chunk_text,
       1 - (embedding <=> '[...]'::vector) AS sim
FROM documents
WHERE 1 - (embedding <=> '[...]'::vector) > 0.3
ORDER BY embedding <=> '[...]'::vector
LIMIT 10;

-- Похожие куски в пределах одного файла
SELECT chunk_index, chunk_text
FROM documents
WHERE filename = 'договор.pdf'
ORDER BY embedding <=> (SELECT embedding FROM documents WHERE id = 100)
LIMIT 5;
```

Операторы pgvector:
- `<=>` — косинусное расстояние (используется в проекте)
- `<->` — евклидово расстояние
- `<#>` — отрицательное скалярное произведение

#### Удаление

```sql
-- Конкретный документ (все его куски)
DELETE FROM documents WHERE filename = 'договор.pdf';

-- Документы старше 90 дней
DELETE FROM documents WHERE created_at < NOW() - INTERVAL '90 days';

-- Конкретный кусок
DELETE FROM documents WHERE id = 42;

-- ОСТОРОЖНО: вся база знаний
TRUNCATE TABLE documents RESTART IDENTITY;
```

---

### 9.4. Таблица `chat_memory` (история диалогов)

#### Просмотр

```sql
-- Последние 20 сообщений конкретной сессии
SELECT role, content, created_at
FROM chat_memory
WHERE session_id = 'chat_1234567890_abc123'
ORDER BY created_at DESC
LIMIT 20;

-- Все активные сессии (по последней активности)
SELECT
    session_id,
    COUNT(*) AS messages,
    MIN(created_at) AS started,
    MAX(created_at) AS last_msg
FROM chat_memory
GROUP BY session_id
ORDER BY last_msg DESC;

-- Сессии конкретного агента (по префиксу)
SELECT session_id, COUNT(*) AS msgs
FROM chat_memory
WHERE session_id LIKE 'sql_%'
GROUP BY session_id
ORDER BY MAX(created_at) DESC;

-- Сколько сообщений было сегодня
SELECT COUNT(*) FROM chat_memory WHERE created_at::date = CURRENT_DATE;

-- Самые длинные сообщения
SELECT session_id, LENGTH(content) AS len, LEFT(content, 80) AS preview
FROM chat_memory
ORDER BY LENGTH(content) DESC
LIMIT 10;

-- Сообщения с упоминанием слова
SELECT session_id, content, created_at
FROM chat_memory
WHERE content ILIKE '%ошибк%'
ORDER BY created_at DESC
LIMIT 20;
```

#### Работа с `extras` JSONB (math и prompt-engineer)

```sql
-- Сообщения math-агента с кодом
SELECT session_id, content, extras->>'code' AS code, extras->>'raw_result' AS result
FROM chat_memory
WHERE session_id LIKE 'math_%' AND extras IS NOT NULL;

-- Сообщения prompt-инженера с готовым промптом
SELECT session_id, extras->>'prompt' AS prompt, created_at
FROM chat_memory
WHERE session_id LIKE 'pe_%' AND extras->>'prompt' IS NOT NULL
ORDER BY created_at DESC;

-- Поиск по содержимому extras (текст в коде)
SELECT * FROM chat_memory
WHERE extras->>'code' ILIKE '%import pandas%';

-- Проверка структуры extras для конкретной строки
SELECT id, jsonb_pretty(extras) FROM chat_memory WHERE id = 42;
```

#### Удаление

```sql
-- Историю конкретной сессии
DELETE FROM chat_memory WHERE session_id = 'chat_xxx';

-- Старше 90 дней
DELETE FROM chat_memory WHERE created_at < NOW() - INTERVAL '90 days';

-- Только сообщения пользователя (не ответы агента)
DELETE FROM chat_memory WHERE role = 'user' AND session_id = 'chat_xxx';

-- Всех сессий определённого агента
DELETE FROM chat_memory WHERE session_id LIKE 'sql_%';

-- ОСТОРОЖНО: вся история
TRUNCATE TABLE chat_memory RESTART IDENTITY;
```

---

### 9.5. Таблица `chat_summaries` (резюме длинных диалогов)

```sql
-- Все резюме
SELECT session_id, messages_summarized, updated_at,
       LEFT(summary_text, 200) AS preview
FROM chat_summaries
ORDER BY updated_at DESC;

-- Резюме конкретной сессии (полностью)
SELECT summary_text FROM chat_summaries WHERE session_id = 'chat_xxx';

-- Сессии с самой большой компрессией
SELECT session_id, messages_summarized
FROM chat_summaries
ORDER BY messages_summarized DESC
LIMIT 10;

-- Удалить резюме сессии
DELETE FROM chat_summaries WHERE session_id = 'chat_xxx';

-- Очистить всё (ОСТОРОЖНО)
TRUNCATE TABLE chat_summaries;
```

---

### 9.6. Запросы между таблицами (JOIN)

```sql
-- Клиенты с их заказами
SELECT c.name, o.product, o.amount, o.status
FROM clients c
JOIN orders o ON c.id = o.client_id
ORDER BY c.name;

-- Клиенты, у которых НЕТ заказов
SELECT c.name, c.city
FROM clients c
LEFT JOIN orders o ON c.id = o.client_id
WHERE o.id IS NULL;

-- Клиенты, у которых ЕСТЬ доставленные заказы
SELECT DISTINCT c.name FROM clients c
JOIN orders o ON c.id = o.client_id
WHERE o.status = 'delivered';

-- Сумма заказов каждого клиента
SELECT c.name, COUNT(o.id) AS orders_count, COALESCE(SUM(o.amount), 0) AS total
FROM clients c
LEFT JOIN orders o ON c.id = o.client_id
GROUP BY c.id, c.name
ORDER BY total DESC;

-- Топ-5 клиентов по выручке доставленных заказов
SELECT c.name, SUM(o.amount) AS revenue
FROM clients c
JOIN orders o ON c.id = o.client_id
WHERE o.status = 'delivered'
GROUP BY c.id, c.name
ORDER BY revenue DESC
LIMIT 5;
```

---

### 9.7. Аналитика и отчёты

```sql
-- Общая сводка по заказам
SELECT
    COUNT(*) AS total_orders,
    SUM(amount) AS total_revenue,
    ROUND(AVG(amount), 2) AS avg_check,
    MIN(amount) AS min_order,
    MAX(amount) AS max_order
FROM orders
WHERE status = 'delivered';

-- Заказы по месяцам
SELECT
    TO_CHAR(order_date, 'YYYY-MM') AS month,
    COUNT(*) AS orders,
    SUM(amount) AS revenue
FROM orders
GROUP BY TO_CHAR(order_date, 'YYYY-MM')
ORDER BY month DESC;

-- Клиенты по городам
SELECT city, COUNT(*) AS clients_count, AVG(revenue) AS avg_revenue
FROM clients
GROUP BY city
ORDER BY clients_count DESC;

-- Конверсия по статусам
SELECT
    status,
    COUNT(*) AS cnt,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS percent
FROM orders
GROUP BY status;

-- Активность чатов по дням
SELECT
    created_at::date AS day,
    COUNT(*) AS messages,
    COUNT(DISTINCT session_id) AS sessions
FROM chat_memory
GROUP BY created_at::date
ORDER BY day DESC
LIMIT 30;

-- Средняя длина сессии
SELECT AVG(msg_count) AS avg_messages_per_session
FROM (SELECT session_id, COUNT(*) AS msg_count FROM chat_memory GROUP BY session_id) t;
```

---

### 9.8. Изменение структуры таблиц (ALTER TABLE)

```sql
-- Добавить колонку
ALTER TABLE clients ADD COLUMN phone VARCHAR(20);
ALTER TABLE clients ADD COLUMN is_vip BOOLEAN DEFAULT false;

-- Удалить колонку
ALTER TABLE clients DROP COLUMN phone;

-- Переименовать колонку
ALTER TABLE clients RENAME COLUMN email TO contact_email;

-- Изменить тип колонки
ALTER TABLE clients ALTER COLUMN name TYPE TEXT;

-- Сделать колонку NOT NULL
ALTER TABLE clients ALTER COLUMN email SET NOT NULL;

-- Убрать NOT NULL
ALTER TABLE clients ALTER COLUMN email DROP NOT NULL;

-- Задать значение по умолчанию
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending';

-- Переименовать таблицу
ALTER TABLE clients RENAME TO customers;
```

---

### 9.9. Индексы

```sql
-- Список всех индексов
\di

-- Подробно с размерами
\di+

-- Создать индекс по полю
CREATE INDEX idx_clients_city ON clients (city);

-- Уникальный индекс
CREATE UNIQUE INDEX idx_clients_email ON clients (email);

-- Составной индекс (для частых WHERE city=X AND revenue>Y)
CREATE INDEX idx_clients_city_revenue ON clients (city, revenue);

-- Частичный индекс (только для определённых строк)
CREATE INDEX idx_orders_pending ON orders (order_date)
WHERE status = 'pending';

-- Индекс для поиска по подстроке (нужно расширение pg_trgm)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_clients_name_trgm ON clients USING gin (name gin_trgm_ops);

-- Удалить индекс
DROP INDEX idx_clients_city;

-- Перестроить индекс (если повредился или сильно фрагментирован)
REINDEX INDEX idx_clients_city;
REINDEX TABLE clients;
```

---

### 9.10. Системные команды и обслуживание

```sql
-- Текущая база и пользователь
SELECT current_database(), current_user;

-- Версия PostgreSQL
SELECT version();

-- Время сервера
SELECT NOW();

-- Кто сейчас подключён
SELECT pid, usename, client_addr, state, query
FROM pg_stat_activity
WHERE datname = 'ai_agent';

-- Размер базы
SELECT pg_size_pretty(pg_database_size('ai_agent'));

-- Размер каждой таблицы
SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size('public.' || tablename)) AS size
FROM pg_tables WHERE schemaname = 'public'
ORDER BY pg_total_relation_size('public.' || tablename) DESC;

-- VACUUM (очистка мёртвых строк, освобождение места)
VACUUM clients;
VACUUM ANALYZE clients;   -- + обновление статистики оптимизатора
VACUUM FULL clients;      -- агрессивная переупаковка (блокирует таблицу!)

-- ANALYZE (обновить статистику оптимизатора)
ANALYZE;                  -- все таблицы
ANALYZE clients;          -- одна таблица

-- План выполнения запроса (без выполнения)
EXPLAIN SELECT * FROM clients WHERE city = 'Москва';

-- План + реальное время выполнения
EXPLAIN ANALYZE SELECT * FROM clients WHERE city = 'Москва';

-- Показывать время выполнения каждого запроса
\timing
```

---

### 9.11. Экспорт и импорт CSV

```sql
-- Экспортировать таблицу в CSV (с заголовками)
\copy clients TO 'C:/tmp/clients.csv' CSV HEADER;
\copy orders TO 'C:/tmp/orders.csv' CSV HEADER;

-- Экспортировать результат запроса
\copy (SELECT name, city, revenue FROM clients WHERE revenue > 1000000) TO 'C:/tmp/top_clients.csv' CSV HEADER;

-- Импортировать из CSV в существующую таблицу
\copy clients (name, city, email, revenue) FROM 'C:/tmp/clients.csv' CSV HEADER;
```

---

### 9.12. Транзакции

```sql
-- Начать транзакцию
BEGIN;

-- Что-то делаем...
UPDATE clients SET revenue = revenue * 1.1 WHERE city = 'Москва';
DELETE FROM orders WHERE status = 'cancelled';

-- Если всё ОК — зафиксировать
COMMIT;

-- Если передумали — откатить
ROLLBACK;

-- Точка сохранения внутри транзакции
BEGIN;
UPDATE clients SET city = 'Питер' WHERE id = 1;
SAVEPOINT before_delete;
DELETE FROM clients WHERE id = 2;
ROLLBACK TO before_delete;  -- откатились только до удаления
COMMIT;
```

---

## 10. Миграция существующей БД при обновлении проекта

Если БД уже существует и работала со старой версией GigaChat — нужно несколько SQL-команд, чтобы привести её к актуальной схеме.

**Бэкап перед миграцией — опционально.** DELETE-команда ниже жёстко ограничена (`a.id > b.id AND ...`), удаляет только новейшие из пары дублей. Если боишься опечататься или эмбеддинг занимал часы — сделай бэкап (см. раздел 6). Если документов мало и можно перезалить через `/webhook/upload-doc` — пропускай.

### Шаг 1. UNIQUE constraint на `documents` (обязательно)

Нужен для нового workflow `document-loader` (`ON CONFLICT (filename, chunk_index)`). Без него повторная загрузка файла будет падать с ошибкой `ON CONFLICT specification requires unique index`.

```sql
-- 1.1. Очистить возможные дубли от старых загрузок
DELETE FROM documents a USING documents b
  WHERE a.id > b.id
    AND a.filename = b.filename
    AND a.chunk_index = b.chunk_index;

-- 1.2. Добавить UNIQUE constraint
ALTER TABLE documents
  ADD CONSTRAINT documents_filename_chunk_unique
  UNIQUE (filename, chunk_index);
```

### Шаг 2. Проверить тип `chat_memory.extras` (диагностика)

```sql
SELECT data_type FROM information_schema.columns
WHERE table_name = 'chat_memory' AND column_name = 'extras';
```

Возможные результаты:

| Результат | Что делать |
|---|---|
| `jsonb` | ✅ ничего, всё ок |
| `json` (без B) | ⚠️ выполнить миграцию шага 3 |
| `text` или другое | ⚠️ выполнить миграцию шага 3 |
| Пусто (нет строк) | ⚠️ колонки нет, выполнить миграцию шага 3 |

### Шаг 3. Миграция `extras` на JSONB (если не jsonb)

```sql
-- Если колонки extras вообще нет:
ALTER TABLE chat_memory ADD COLUMN IF NOT EXISTS extras JSONB;

-- Если колонка есть, но тип не JSONB:
ALTER TABLE chat_memory ALTER COLUMN extras TYPE JSONB USING extras::jsonb;
```

### Шаг 4. Контрольная проверка

После всех шагов выполни блок проверки готовности:

```sql
-- 1. Расширение vector
SELECT * FROM pg_extension WHERE extname = 'vector';
-- Должна быть 1 строка

-- 2. Все таблицы на месте
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- Должны быть: chat_memory, chat_summaries, clients, documents, orders

-- 3. UNIQUE constraint на documents
SELECT conname FROM pg_constraint
WHERE conrelid = 'documents'::regclass AND contype = 'u';
-- Должна вернуть: documents_filename_chunk_unique

-- 4. Индексы на месте
SELECT indexname FROM pg_indexes WHERE tablename IN ('chat_memory', 'documents');
-- Должны быть: idx_chat_memory_session, idx_documents_embedding, idx_documents_filename

-- 5. extras в JSONB
SELECT data_type FROM information_schema.columns
WHERE table_name = 'chat_memory' AND column_name = 'extras';
-- Должно вернуть: jsonb
```

Если все 5 пунктов проходят — БД готова, можно импортировать workflow'ы в n8n и запускать тесты.

### Если используется pgBouncer (важно для B1)

Новый chat-agent использует `pg_advisory_xact_lock` для сериализации параллельных запросов в одной сессии. Этот механизм **не работает** в pgBouncer'е с `pool_mode = transaction` (advisory-lock от одной транзакции не виден другой, даже если они идут через одно соединение).

Проверь в `pgbouncer.ini`:

```ini
pool_mode = session    # ✅ работает с advisory_xact_lock
pool_mode = transaction  # ❌ ломает B1 фикс
pool_mode = statement    # ❌ ещё хуже, не использовать
```

Если стоит `transaction` — переключи на `session`, либо обходи pgBouncer для n8n (прямое подключение к 5432, а pgBouncer для других приложений).

