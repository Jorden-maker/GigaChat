# PostgreSQL для GigaChat — практический гайд

> Только то, что реально нужно для запуска и поддержки в офисе.
> Всё работает в локальной сети, без интернета.

## Содержание

1. [Установка PostgreSQL](#1-установка-postgresql)
2. [Установка PGVector](#2-установка-pgvector)
3. [Создание базы и таблиц](#3-создание-базы-и-таблиц)
4. [Подключение n8n](#4-подключение-n8n)
5. [Доступ из локальной сети](#5-доступ-из-локальной-сети)
6. [Бэкап и восстановление](#6-бэкап-и-восстановление)
7. [Шпаргалка администратора](#7-шпаргалка-администратора)
8. [Если что-то сломалось](#8-если-что-то-сломалось)

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
\c n8n_db
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
CREATE DATABASE n8n_db;
\c n8n_db

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
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_embedding
ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_documents_filename ON documents (filename);

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

\dt
SELECT 'Готово!' AS result;
```

После выполнения `\dt` должен показать 5 таблиц.

### Если БД уже существует — миграция для `extras`

Если ты обновляешься со старой версии и колонки `extras` нет:

```sql
\c n8n_db
ALTER TABLE chat_memory ADD COLUMN IF NOT EXISTS extras JSONB;
```

### Размерность вектора

В таблице `documents` указано `vector(1024)`. Если ваша модель эмбеддинга возвращает векторы другой размерности — поменяй число в скобках.

---

## 4. Подключение n8n

В n8n: **Credentials → New → Postgres**.

| Поле | Значение |
|------|----------|
| Host | `localhost` (или IP сервера БД) |
| Database | `n8n_db` |
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
host    n8n_db    postgres    192.168.0.0/16    scram-sha-256
```

### Шаг 3. Открыть порт 5432 в firewall

Windows Defender → Дополнительные параметры → Правила для входящих → Создать правило → Порт → TCP 5432 → Разрешить.

### Шаг 4. Перезапустить PostgreSQL

```
net stop postgresql-x64-16
net start postgresql-x64-16
```

Проверка с другой машины: `psql -h IP_СЕРВЕРА_БД -U postgres -d n8n_db`.

---

## 6. Бэкап и восстановление

### Бэкап одной командой

```
pg_dump -U postgres -d n8n_db -Fc -f backup.dump
```

Параметр `-Fc` — сжатый формат (сильно меньше по размеру).

### Автоматический ежедневный бэкап (Task Scheduler)

Создай файл `C:\GigaChat\backup.bat`:

```bat
@echo off
set BACKUP_DIR=C:\GigaChat\backups
set TS=%date:~6,4%-%date:~3,2%-%date:~0,2%
pg_dump -U postgres -d n8n_db -Fc -f "%BACKUP_DIR%\n8n_db_%TS%.dump"
```

В Task Scheduler: создать ежедневную задачу → запускать `backup.bat`.

### Восстановление

Если база уже создана и пустая:

```
pg_restore -U postgres -d n8n_db backup.dump
```

Если нужно полностью перезаписать:

```
pg_restore -U postgres -d n8n_db --clean backup.dump
```

---

## 7. Шпаргалка администратора

### Зайти в БД

```
psql -U postgres -d n8n_db
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
SELECT pg_size_pretty(pg_database_size('n8n_db'));

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

Возможно ты не в той базе — `\c n8n_db`. Если таблиц действительно нет — выполни скрипт из раздела 3.

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
