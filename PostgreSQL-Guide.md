# PostgreSQL — Полное руководство по настройке и командам

> Для платформы GigaChat на n8n  
> Всё работает локально (offline), без интернета

---

## Содержание

1. Установка PostgreSQL на Windows
2. Первый запуск и подключение
3. Создание базы данных и пользователя
4. Расширение PGVector
5. Создание всех таблиц проекта
6. Справочник команд psql (командная строка)
7. Справочник SQL-команд
8. Управление данными (INSERT, UPDATE, DELETE)
9. Выборка данных (SELECT)
10. Индексы и производительность
11. Резервное копирование и восстановление
12. Диагностика и решение проблем
13. Полезные скрипты для проекта GigaChat

---

## 1. Установка PostgreSQL на Windows

### Скачивание

Зайди на официальный сайт: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads

Скачай версию **PostgreSQL 16** (или новее) для Windows x86-64.

### Установка

1. Запусти скачанный `.exe` файл
2. Нажми **Next** на каждом шаге, параметры по умолчанию подходят
3. На шаге **Password** — задай пароль для пользователя `postgres`. Запомни его — он понадобится для подключения
4. На шаге **Port** — оставь `5432` (по умолчанию)
5. На шаге **Locale** — оставь `[Default locale]`
6. Дождись завершения установки
7. Сними галочку «Launch Stack Builder» — он не нужен
8. Нажми **Finish**

### Проверка установки

Открой **Командную строку** (Win + R → `cmd` → Enter) и введи:

```
psql --version
```

Если видишь что-то вроде `psql (PostgreSQL) 16.x` — установка прошла успешно.

Если команда не найдена — нужно добавить PostgreSQL в PATH:

```
set PATH=%PATH%;C:\Program Files\PostgreSQL\16\bin
```

Чтобы добавить навсегда:

1. Win + R → `sysdm.cpl` → Enter
2. Вкладка **Дополнительно** → кнопка **Переменные среды**
3. В блоке **Системные переменные** найди `Path` → нажми **Изменить**
4. Нажми **Создать** → вставь `C:\Program Files\PostgreSQL\16\bin`
5. Нажми **OK** три раза
6. Закрой и заново открой cmd

### Проверка, что сервер работает

```
pg_isready
```

Ответ `localhost:5432 - accepting connections` означает, что всё в порядке.

Если сервер не запущен:

```
net start postgresql-x64-16
```

Или через **Службы Windows** (Win + R → `services.msc`) — найди `postgresql-x64-16` → правый клик → **Запустить**.

---

## 2. Первый запуск и подключение

### Подключение через psql

psql — это консольный клиент PostgreSQL. Через него выполняются все SQL-команды.

```
psql -U postgres
```

Введи пароль, который задал при установке. Если подключение успешно — увидишь приглашение:

```
postgres=#
```

Это значит, что ты подключён к базе `postgres` как пользователь `postgres`.

### Подключение к конкретной базе

```
psql -U postgres -d n8n_db
```

### Подключение с указанием хоста и порта

```
psql -U postgres -h localhost -p 5432 -d n8n_db
```

### Подключение без запроса пароля

Создай файл `%APPDATA%\postgresql\pgpass.conf` с содержимым:

```
localhost:5432:*:postgres:ТВОЙ_ПАРОЛЬ
```

После этого psql не будет спрашивать пароль.

### Выход из psql

```
\q
```

---

## 3. Создание базы данных и пользователя

### Подключись к PostgreSQL

```
psql -U postgres
```

### Создание базы данных

```sql
CREATE DATABASE n8n_db;
```

### Проверка, что база создана

```sql
\l
```

Эта команда покажет список всех баз данных. В списке должна быть `n8n_db`.

### Подключение к новой базе

```sql
\c n8n_db
```

Увидишь:

```
You are now connected to database "n8n_db" as user "postgres".
n8n_db=#
```

### Создание отдельного пользователя (опционально)

Если не хочешь использовать суперпользователя `postgres` для всего:

```sql
CREATE USER gigachat_user WITH PASSWORD 'надёжный_пароль';
GRANT ALL PRIVILEGES ON DATABASE n8n_db TO gigachat_user;
```

После подключения к базе `n8n_db` дай права на схему:

```sql
\c n8n_db
GRANT ALL ON SCHEMA public TO gigachat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO gigachat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO gigachat_user;
```

---

## 4. Расширение PGVector

PGVector — расширение PostgreSQL для работы с векторами (эмбеддингами). Оно нужно для хранения и поиска по смыслу в таблице `documents`.

### Установка PGVector на Windows

**Вариант 1: Через Stack Builder** (если ставил PostgreSQL через EnterpriseDB)

Не все версии включают pgvector. Проверь сначала — возможно, уже установлен.

**Вариант 2: Через SQL** (если расширение уже есть в системе)

Подключись к базе и выполни:

```sql
\c n8n_db
CREATE EXTENSION IF NOT EXISTS vector;
```

Если видишь `CREATE EXTENSION` — расширение установлено. Если ошибка `could not open extension control file` — нужно установить PGVector отдельно.

**Вариант 3: Установка из исходников**

1. Скачай pgvector с https://github.com/pgvector/pgvector/releases
2. Скопируй файлы:
   - `vector.dll` → `C:\Program Files\PostgreSQL\16\lib\`
   - `vector.control` и `vector--*.sql` → `C:\Program Files\PostgreSQL\16\share\extension\`
3. Перезапусти PostgreSQL:
   ```
   net stop postgresql-x64-16
   net start postgresql-x64-16
   ```
4. Подключись и создай расширение:
   ```sql
   \c n8n_db
   CREATE EXTENSION vector;
   ```

### Проверка, что PGVector работает

```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

Если строка с `vector` есть в результате — всё работает.

---

## 5. Создание всех таблиц проекта

Подключись к базе:

```
psql -U postgres -d n8n_db
```

### Таблица clients — данные клиентов

```sql
CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255),
    email VARCHAR(255),
    revenue DECIMAL(15, 2),
    created_at DATE DEFAULT CURRENT_DATE
);
```

Поля:

| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Автоинкремент, первичный ключ |
| name | VARCHAR(255) | Название клиента / компании |
| city | VARCHAR(255) | Город |
| email | VARCHAR(255) | Электронная почта |
| revenue | DECIMAL(15,2) | Выручка |
| created_at | DATE | Дата добавления |

### Таблица orders — заказы

```sql
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id),
    product VARCHAR(255),
    amount DECIMAL(15, 2),
    status VARCHAR(50),
    order_date DATE DEFAULT CURRENT_DATE
);
```

Поля:

| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Автоинкремент, первичный ключ |
| client_id | INTEGER | Ссылка на clients.id (FK) |
| product | VARCHAR(255) | Название продукта |
| amount | DECIMAL(15,2) | Сумма заказа |
| status | VARCHAR(50) | Статус: delivered, pending, cancelled |
| order_date | DATE | Дата заказа |

### Таблица documents — документы с эмбеддингами (PGVector)

```sql
CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(500) NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding vector(1024),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Индекс для быстрого векторного поиска (cosine distance)
CREATE INDEX IF NOT EXISTS idx_documents_embedding
ON documents USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Индекс по имени файла
CREATE INDEX IF NOT EXISTS idx_documents_filename
ON documents (filename);
```

Поля:

| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Автоинкремент, первичный ключ |
| filename | VARCHAR(500) | Имя загруженного файла |
| chunk_index | INTEGER | Номер куска (0, 1, 2, ...) |
| chunk_text | TEXT | Текст куска (~500 слов) |
| embedding | vector(1024) | Вектор эмбеддинга GigaChat |
| created_at | TIMESTAMP | Дата и время загрузки |

Важно: если ваша модель эмбеддинга возвращает векторы другой размерности (не 1024), измените число в скобках. Узнать размерность можно, отправив тестовый запрос к API эмбеддинга.

### Таблица chat_memory — история переписки

```sql
CREATE TABLE IF NOT EXISTS chat_memory (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Индекс по session_id для быстрого поиска по сессиям
CREATE INDEX IF NOT EXISTS idx_chat_memory_session
ON chat_memory (session_id, created_at);
```

Поля:

| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Автоинкремент, первичный ключ |
| session_id | VARCHAR(255) | ID сессии чата |
| role | VARCHAR(20) | Роль: user или assistant |
| content | TEXT | Текст сообщения |
| created_at | TIMESTAMP | Дата и время сообщения |

### Таблица chat_summaries — сжатые резюме диалогов (для Чат-Агента)

```sql
CREATE TABLE IF NOT EXISTS chat_summaries (
    session_id VARCHAR(255) PRIMARY KEY,
    summary_text TEXT,
    messages_summarized INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);
```

Поля:

| Поле | Тип | Описание |
|------|-----|----------|
| session_id | VARCHAR(255) | ID сессии (первичный ключ) |
| summary_text | TEXT | Сжатое резюме старых сообщений |
| messages_summarized | INTEGER | Сколько сообщений было сжато |
| updated_at | TIMESTAMP | Когда последний раз обновлялось |

### Единый скрипт: создать всё за один раз

Скопируй и вставь целиком в psql:

```sql
-- Подключение к базе
\c n8n_db

-- Расширение для векторов
CREATE EXTENSION IF NOT EXISTS vector;

-- Клиенты
CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255),
    email VARCHAR(255),
    revenue DECIMAL(15, 2),
    created_at DATE DEFAULT CURRENT_DATE
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id),
    product VARCHAR(255),
    amount DECIMAL(15, 2),
    status VARCHAR(50),
    order_date DATE DEFAULT CURRENT_DATE
);

-- Документы с эмбеддингами
CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(500) NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding vector(1024),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_embedding
ON documents USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_documents_filename
ON documents (filename);

-- История чата
CREATE TABLE IF NOT EXISTS chat_memory (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_memory_session
ON chat_memory (session_id, created_at);

-- Резюме чатов (для Чат-Агента с памятью)
CREATE TABLE IF NOT EXISTS chat_summaries (
    session_id VARCHAR(255) PRIMARY KEY,
    summary_text TEXT,
    messages_summarized INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Проверка
SELECT 'Все таблицы созданы!' AS result;
\dt
```

---

## 6. Справочник команд psql (командная строка)

psql — это интерактивная консоль PostgreSQL. Команды, начинающиеся с `\` — это мета-команды psql (не SQL).

### Подключение и навигация

| Команда | Описание |
|---------|----------|
| `psql -U postgres` | Подключиться как пользователь postgres |
| `psql -U postgres -d n8n_db` | Подключиться к конкретной базе |
| `psql -U postgres -h 192.168.1.50 -p 5432 -d n8n_db` | Подключиться к удалённому серверу |
| `\c n8n_db` | Переключиться на другую базу |
| `\q` | Выйти из psql |
| `\! cls` | Очистить экран (Windows) |
| `\! clear` | Очистить экран (Linux) |

### Информация о базе

| Команда | Описание |
|---------|----------|
| `\l` | Список всех баз данных |
| `\dt` | Список таблиц в текущей базе |
| `\dt+` | Список таблиц с размерами |
| `\d имя_таблицы` | Структура конкретной таблицы (столбцы, типы) |
| `\d+ имя_таблицы` | Подробная структура таблицы |
| `\di` | Список индексов |
| `\di+` | Список индексов с размерами |
| `\dn` | Список схем |
| `\du` | Список пользователей (ролей) |
| `\df` | Список функций |
| `\dx` | Список установленных расширений |
| `\dv` | Список представлений (views) |
| `\ds` | Список последовательностей (sequences) |

### Ввод и вывод

| Команда | Описание |
|---------|----------|
| `\i путь/к/файлу.sql` | Выполнить SQL-файл |
| `\o путь/к/файлу.txt` | Перенаправить вывод в файл |
| `\o` | Вернуть вывод на экран |
| `\copy таблица TO 'файл.csv' CSV HEADER` | Экспорт таблицы в CSV |
| `\copy таблица FROM 'файл.csv' CSV HEADER` | Импорт из CSV в таблицу |
| `\e` | Открыть последний запрос в текстовом редакторе |
| `\g` | Выполнить последний запрос повторно |
| `\s` | Показать историю команд |

### Форматирование вывода

| Команда | Описание |
|---------|----------|
| `\x` | Переключить расширенный режим (вертикальный вывод) |
| `\x auto` | Автоматический выбор формата |
| `\pset border 2` | Таблица с рамками |
| `\pset format html` | Вывод в формате HTML |
| `\pset format aligned` | Вернуть обычный формат |
| `\timing` | Показывать время выполнения запросов |
| `\pset null '(NULL)'` | Отображать NULL как текст |

### Информация о подключении

| Команда | Описание |
|---------|----------|
| `\conninfo` | Информация о текущем подключении |
| `SELECT version();` | Версия PostgreSQL |
| `SELECT current_database();` | Имя текущей базы |
| `SELECT current_user;` | Имя текущего пользователя |
| `SELECT now();` | Текущая дата и время сервера |
| `\encoding` | Текущая кодировка |
| `\encoding UTF8` | Установить кодировку UTF-8 |

---

## 7. Справочник SQL-команд

### Управление базами данных

```sql
-- Создать базу
CREATE DATABASE имя_базы;

-- Создать базу с кодировкой
CREATE DATABASE имя_базы
  WITH ENCODING 'UTF8'
  LC_COLLATE = 'ru_RU.UTF-8'
  LC_CTYPE = 'ru_RU.UTF-8'
  TEMPLATE template0;

-- Удалить базу (ОСТОРОЖНО — удалит всё безвозвратно!)
DROP DATABASE имя_базы;

-- Удалить, только если существует
DROP DATABASE IF EXISTS имя_базы;

-- Переименовать базу
ALTER DATABASE старое_имя RENAME TO новое_имя;
```

### Управление таблицами

```sql
-- Создать таблицу
CREATE TABLE имя_таблицы (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    value INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Создать, только если не существует
CREATE TABLE IF NOT EXISTS имя_таблицы (...);

-- Удалить таблицу (ОСТОРОЖНО!)
DROP TABLE имя_таблицы;

-- Удалить, только если существует
DROP TABLE IF EXISTS имя_таблицы;

-- Переименовать таблицу
ALTER TABLE старое_имя RENAME TO новое_имя;

-- Очистить таблицу (удалить все строки, оставить структуру)
TRUNCATE TABLE имя_таблицы;

-- Очистить и сбросить счётчик SERIAL
TRUNCATE TABLE имя_таблицы RESTART IDENTITY;
```

### Управление столбцами

```sql
-- Добавить столбец
ALTER TABLE имя_таблицы ADD COLUMN новый_столбец VARCHAR(100);

-- Добавить столбец со значением по умолчанию
ALTER TABLE имя_таблицы ADD COLUMN активен BOOLEAN DEFAULT true;

-- Удалить столбец
ALTER TABLE имя_таблицы DROP COLUMN имя_столбца;

-- Переименовать столбец
ALTER TABLE имя_таблицы RENAME COLUMN старое_имя TO новое_имя;

-- Изменить тип столбца
ALTER TABLE имя_таблицы ALTER COLUMN имя_столбца TYPE TEXT;

-- Установить значение по умолчанию
ALTER TABLE имя_таблицы ALTER COLUMN имя_столбца SET DEFAULT 'значение';

-- Убрать значение по умолчанию
ALTER TABLE имя_таблицы ALTER COLUMN имя_столбца DROP DEFAULT;

-- Сделать столбец NOT NULL
ALTER TABLE имя_таблицы ALTER COLUMN имя_столбца SET NOT NULL;

-- Убрать NOT NULL
ALTER TABLE имя_таблицы ALTER COLUMN имя_столбца DROP NOT NULL;
```

### Типы данных

| Тип | Описание | Пример |
|-----|----------|--------|
| `SERIAL` | Автоинкремент (1, 2, 3, ...) | id SERIAL PRIMARY KEY |
| `INTEGER` / `INT` | Целое число | количество INT |
| `BIGINT` | Большое целое число | id BIGINT |
| `DECIMAL(p, s)` | Точное десятичное число | сумма DECIMAL(15, 2) |
| `REAL` | Число с плавающей точкой (4 байта) | рейтинг REAL |
| `DOUBLE PRECISION` | Число двойной точности (8 байт) | координата DOUBLE PRECISION |
| `VARCHAR(n)` | Строка до n символов | имя VARCHAR(255) |
| `TEXT` | Строка без ограничения длины | описание TEXT |
| `BOOLEAN` | true / false | активен BOOLEAN |
| `DATE` | Дата (2026-05-10) | дата_рождения DATE |
| `TIME` | Время (14:30:00) | время_начала TIME |
| `TIMESTAMP` | Дата + время | создан TIMESTAMP |
| `TIMESTAMP WITH TIME ZONE` | Дата + время + часовой пояс | создан TIMESTAMPTZ |
| `JSON` | JSON-данные | настройки JSON |
| `JSONB` | Бинарный JSON (быстрее для поиска) | метаданные JSONB |
| `UUID` | Уникальный идентификатор | uuid UUID DEFAULT gen_random_uuid() |
| `BYTEA` | Бинарные данные | файл BYTEA |
| `vector(n)` | Вектор PGVector (n чисел) | embedding vector(1024) |

### Ограничения (Constraints)

```sql
-- Первичный ключ
id SERIAL PRIMARY KEY

-- Уникальное значение
email VARCHAR(255) UNIQUE

-- NOT NULL — значение обязательно
name VARCHAR(255) NOT NULL

-- Значение по умолчанию
status VARCHAR(50) DEFAULT 'pending'

-- Проверка
age INTEGER CHECK (age >= 0 AND age <= 150)

-- Внешний ключ
client_id INTEGER REFERENCES clients(id)

-- Внешний ключ с каскадным удалением
client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE

-- Составной первичный ключ
PRIMARY KEY (session_id, message_index)

-- Составной уникальный ключ
UNIQUE (filename, chunk_index)
```

---

## 8. Управление данными (INSERT, UPDATE, DELETE)

### INSERT — добавить строки

```sql
-- Одна строка
INSERT INTO clients (name, city, email, revenue)
VALUES ('ООО Ромашка', 'Москва', 'romashka@mail.ru', 1500000.00);

-- Несколько строк
INSERT INTO clients (name, city, email, revenue) VALUES
('ООО Василёк', 'Казань', 'vasilek@mail.ru', 800000.00),
('ИП Иванов', 'Воронеж', 'ivanov@mail.ru', 350000.00),
('ЗАО Рассвет', 'Сочи', 'rassvet@mail.ru', 2200000.00);

-- Вставить и вернуть id новой строки
INSERT INTO clients (name, city) VALUES ('Тест', 'Москва')
RETURNING id;

-- Вставить и вернуть всю строку
INSERT INTO clients (name, city) VALUES ('Тест', 'Москва')
RETURNING *;

-- UPSERT — вставить или обновить, если уже существует
INSERT INTO chat_summaries (session_id, summary_text, messages_summarized, updated_at)
VALUES ('session_123', 'Резюме разговора...', 35, NOW())
ON CONFLICT (session_id) DO UPDATE SET
    summary_text = EXCLUDED.summary_text,
    messages_summarized = EXCLUDED.messages_summarized,
    updated_at = NOW();
```

### UPDATE — обновить строки

```sql
-- Обновить одно поле
UPDATE clients SET city = 'Санкт-Петербург' WHERE id = 1;

-- Обновить несколько полей
UPDATE clients SET city = 'Казань', revenue = 2000000.00 WHERE id = 2;

-- Обновить все строки (ОСТОРОЖНО!)
UPDATE clients SET revenue = revenue * 1.1;

-- Обновить с условием
UPDATE orders SET status = 'delivered' WHERE status = 'pending' AND order_date < '2026-01-01';

-- Обновить и вернуть изменённые строки
UPDATE clients SET revenue = revenue + 100000 WHERE city = 'Москва'
RETURNING id, name, revenue;
```

### DELETE — удалить строки

```sql
-- Удалить по условию
DELETE FROM orders WHERE status = 'cancelled';

-- Удалить конкретную строку
DELETE FROM clients WHERE id = 5;

-- Удалить старые записи из chat_memory
DELETE FROM chat_memory WHERE created_at < NOW() - INTERVAL '90 days';

-- Удалить все строки (лучше используй TRUNCATE)
DELETE FROM имя_таблицы;

-- Удалить и вернуть удалённые строки
DELETE FROM orders WHERE id = 10 RETURNING *;
```

---

## 9. Выборка данных (SELECT)

### Основы

```sql
-- Все столбцы
SELECT * FROM clients;

-- Конкретные столбцы
SELECT name, city, revenue FROM clients;

-- С переименованием столбцов
SELECT name AS "Клиент", city AS "Город", revenue AS "Выручка" FROM clients;

-- Первые 10 строк
SELECT * FROM clients LIMIT 10;

-- Пропустить первые 5, взять следующие 10
SELECT * FROM clients LIMIT 10 OFFSET 5;

-- Уникальные значения
SELECT DISTINCT city FROM clients;

-- Количество строк
SELECT COUNT(*) FROM clients;
```

### Условия (WHERE)

```sql
-- Равенство
SELECT * FROM clients WHERE city = 'Москва';

-- Не равно
SELECT * FROM clients WHERE city != 'Москва';
SELECT * FROM clients WHERE city <> 'Москва';

-- Больше / меньше
SELECT * FROM clients WHERE revenue > 1000000;
SELECT * FROM clients WHERE revenue >= 500000;
SELECT * FROM clients WHERE revenue < 100000;

-- Диапазон
SELECT * FROM clients WHERE revenue BETWEEN 500000 AND 2000000;

-- Список значений
SELECT * FROM clients WHERE city IN ('Москва', 'Казань', 'Сочи');

-- NOT IN
SELECT * FROM clients WHERE city NOT IN ('Москва', 'Казань');

-- NULL / NOT NULL
SELECT * FROM clients WHERE email IS NULL;
SELECT * FROM clients WHERE email IS NOT NULL;

-- Поиск по подстроке
SELECT * FROM clients WHERE name LIKE '%Ромашка%';
SELECT * FROM clients WHERE name ILIKE '%ромашка%';  -- без учёта регистра

-- Начинается с
SELECT * FROM clients WHERE name LIKE 'ООО%';

-- Заканчивается на
SELECT * FROM clients WHERE email LIKE '%@mail.ru';

-- Комбинация условий
SELECT * FROM clients WHERE city = 'Москва' AND revenue > 1000000;
SELECT * FROM clients WHERE city = 'Москва' OR city = 'Казань';
SELECT * FROM clients WHERE NOT (city = 'Москва');
```

### Сортировка (ORDER BY)

```sql
-- По возрастанию (по умолчанию)
SELECT * FROM clients ORDER BY revenue;
SELECT * FROM clients ORDER BY revenue ASC;

-- По убыванию
SELECT * FROM clients ORDER BY revenue DESC;

-- По нескольким столбцам
SELECT * FROM clients ORDER BY city ASC, revenue DESC;

-- По дате (свежие первые)
SELECT * FROM orders ORDER BY order_date DESC LIMIT 20;
```

### Агрегатные функции

```sql
-- Подсчёт
SELECT COUNT(*) FROM clients;
SELECT COUNT(*) FROM clients WHERE city = 'Москва';

-- Сумма
SELECT SUM(revenue) FROM clients;
SELECT SUM(amount) FROM orders WHERE status = 'delivered';

-- Среднее
SELECT AVG(revenue) FROM clients;
SELECT ROUND(AVG(amount), 2) AS "Средний чек" FROM orders;

-- Минимум / максимум
SELECT MIN(revenue) FROM clients;
SELECT MAX(revenue) FROM clients;

-- Все сразу
SELECT
    COUNT(*) AS "Всего",
    SUM(revenue) AS "Общая выручка",
    ROUND(AVG(revenue), 2) AS "Средняя",
    MIN(revenue) AS "Минимальная",
    MAX(revenue) AS "Максимальная"
FROM clients;
```

### Группировка (GROUP BY)

```sql
-- Количество клиентов по городам
SELECT city, COUNT(*) AS "Количество"
FROM clients
GROUP BY city
ORDER BY "Количество" DESC;

-- Сумма заказов по статусам
SELECT status, COUNT(*) AS "Кол-во", SUM(amount) AS "Сумма"
FROM orders
GROUP BY status;

-- Выручка по городам, только где больше 2 клиентов
SELECT city, COUNT(*) AS cnt, SUM(revenue) AS total
FROM clients
GROUP BY city
HAVING COUNT(*) > 2
ORDER BY total DESC;

-- Заказы по месяцам
SELECT
    DATE_TRUNC('month', order_date) AS "Месяц",
    COUNT(*) AS "Заказов",
    SUM(amount) AS "Сумма"
FROM orders
GROUP BY DATE_TRUNC('month', order_date)
ORDER BY "Месяц" DESC;
```

### JOIN — соединение таблиц

```sql
-- INNER JOIN — только совпадающие строки
SELECT c.name, o.product, o.amount, o.status
FROM orders o
JOIN clients c ON o.client_id = c.id;

-- LEFT JOIN — все из левой таблицы + совпадения из правой
SELECT c.name, o.product, o.amount
FROM clients c
LEFT JOIN orders o ON c.id = o.client_id;

-- Клиенты без заказов
SELECT c.name
FROM clients c
LEFT JOIN orders o ON c.id = o.client_id
WHERE o.id IS NULL;

-- Количество заказов по каждому клиенту
SELECT c.name, COUNT(o.id) AS "Заказов", COALESCE(SUM(o.amount), 0) AS "Сумма"
FROM clients c
LEFT JOIN orders o ON c.id = o.client_id
GROUP BY c.name
ORDER BY "Сумма" DESC;

-- Топ-5 клиентов по сумме заказов
SELECT c.name, SUM(o.amount) AS total
FROM clients c
JOIN orders o ON c.id = o.client_id
WHERE o.status = 'delivered'
GROUP BY c.name
ORDER BY total DESC
LIMIT 5;
```

### Подзапросы

```sql
-- Клиенты с выручкой выше средней
SELECT * FROM clients
WHERE revenue > (SELECT AVG(revenue) FROM clients);

-- Клиенты, у которых есть заказы
SELECT * FROM clients
WHERE id IN (SELECT DISTINCT client_id FROM orders);

-- Последний заказ каждого клиента
SELECT * FROM orders o
WHERE order_date = (
    SELECT MAX(order_date) FROM orders
    WHERE client_id = o.client_id
);
```

### Работа с датами

```sql
-- Текущая дата и время
SELECT NOW();
SELECT CURRENT_DATE;
SELECT CURRENT_TIME;

-- Разница между датами
SELECT NOW() - INTERVAL '7 days';
SELECT NOW() - INTERVAL '1 month';
SELECT NOW() - INTERVAL '1 year';

-- Заказы за последнюю неделю
SELECT * FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '7 days';

-- Заказы за текущий месяц
SELECT * FROM orders WHERE DATE_TRUNC('month', order_date) = DATE_TRUNC('month', CURRENT_DATE);

-- Извлечь части даты
SELECT
    EXTRACT(YEAR FROM order_date) AS "Год",
    EXTRACT(MONTH FROM order_date) AS "Месяц",
    EXTRACT(DAY FROM order_date) AS "День"
FROM orders;

-- Форматирование даты
SELECT TO_CHAR(order_date, 'DD.MM.YYYY') AS "Дата" FROM orders;
SELECT TO_CHAR(NOW(), 'DD Mon YYYY HH24:MI:SS') AS "Сейчас";

-- Возраст записи
SELECT name, AGE(created_at) AS "Возраст записи" FROM clients;
```

### Работа со строками

```sql
-- Длина строки
SELECT name, LENGTH(name) AS "Длина" FROM clients;

-- Верхний / нижний регистр
SELECT UPPER(name) FROM clients;
SELECT LOWER(email) FROM clients;

-- Обрезка пробелов
SELECT TRIM('  текст  ');
SELECT LTRIM('  текст');
SELECT RTRIM('текст  ');

-- Конкатенация (склеивание)
SELECT name || ' — ' || city AS "Клиент" FROM clients;
SELECT CONCAT(name, ' (', city, ')') FROM clients;

-- Подстрока
SELECT SUBSTRING(name FROM 1 FOR 10) FROM clients;
SELECT LEFT(name, 10) FROM clients;
SELECT RIGHT(name, 5) FROM clients;

-- Замена
SELECT REPLACE(name, 'ООО', 'Компания') FROM clients;

-- Разделение
SELECT SPLIT_PART('а;б;в', ';', 2);  -- вернёт 'б'
```

---

## 10. Индексы и производительность

### Создание индексов

```sql
-- Обычный индекс (B-tree) — для точного поиска и сортировки
CREATE INDEX idx_clients_city ON clients (city);

-- Уникальный индекс
CREATE UNIQUE INDEX idx_clients_email ON clients (email);

-- Составной индекс
CREATE INDEX idx_orders_client_date ON orders (client_id, order_date);

-- Индекс для LIKE-запросов (поиск подстроки)
CREATE INDEX idx_clients_name_trgm ON clients USING gin (name gin_trgm_ops);
-- Для этого нужно расширение: CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Индекс для PGVector (косинусное расстояние)
CREATE INDEX idx_documents_embedding
ON documents USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Частичный индекс (только для определённых строк)
CREATE INDEX idx_orders_pending ON orders (order_date)
WHERE status = 'pending';
```

### Удаление индексов

```sql
DROP INDEX имя_индекса;
DROP INDEX IF EXISTS имя_индекса;
```

### Анализ запросов

```sql
-- Показать план выполнения запроса
EXPLAIN SELECT * FROM clients WHERE city = 'Москва';

-- Показать план + реальное время выполнения
EXPLAIN ANALYZE SELECT * FROM clients WHERE city = 'Москва';

-- Обновить статистику для оптимизатора
ANALYZE clients;
ANALYZE;  -- для всех таблиц
```

### Размер базы и таблиц

```sql
-- Размер базы данных
SELECT pg_size_pretty(pg_database_size('n8n_db'));

-- Размер каждой таблицы
SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS "Размер"
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;

-- Количество строк в каждой таблице
SELECT
    relname AS "Таблица",
    n_live_tup AS "Примерно строк"
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

---

## 11. Резервное копирование и восстановление

### Резервная копия через командную строку

```
rem Одна база — в SQL-файл
pg_dump -U postgres -d n8n_db > backup.sql

rem Одна база — в сжатый формат
pg_dump -U postgres -d n8n_db -Fc -f backup.dump

rem Только данные (без структуры)
pg_dump -U postgres -d n8n_db --data-only > data_only.sql

rem Только структура (без данных)
pg_dump -U postgres -d n8n_db --schema-only > schema_only.sql

rem Конкретная таблица
pg_dump -U postgres -d n8n_db -t clients > clients_backup.sql

rem Несколько таблиц
pg_dump -U postgres -d n8n_db -t clients -t orders > clients_orders.sql

rem Все базы данных
pg_dumpall -U postgres > all_databases.sql
```

### Восстановление

```
rem Из SQL-файла
psql -U postgres -d n8n_db < backup.sql

rem Из сжатого файла
pg_restore -U postgres -d n8n_db backup.dump

rem Из сжатого файла с очисткой (удалит старые данные)
pg_restore -U postgres -d n8n_db --clean backup.dump
```

### Экспорт таблицы в CSV

Из psql:

```sql
\copy clients TO 'C:/backup/clients.csv' CSV HEADER;
\copy orders TO 'C:/backup/orders.csv' CSV HEADER;
```

Или через SQL:

```sql
COPY clients TO 'C:/backup/clients.csv' WITH CSV HEADER;
```

### Импорт из CSV

```sql
\copy clients (name, city, email, revenue) FROM 'C:/data/clients.csv' CSV HEADER;
```

---

## 12. Диагностика и решение проблем

### Не удаётся подключиться

Проверь, что сервер запущен:

```
pg_isready
```

Если `no response` — запусти сервер:

```
net start postgresql-x64-16
```

Если ошибка аутентификации — проверь пароль. Можно сбросить через `pg_hba.conf`:

1. Найди файл: `C:\Program Files\PostgreSQL\16\data\pg_hba.conf`
2. Измени строку `host all all 127.0.0.1/32 scram-sha-256` на `host all all 127.0.0.1/32 trust`
3. Перезапусти сервер
4. Подключись без пароля, смени пароль:
   ```sql
   ALTER USER postgres WITH PASSWORD 'новый_пароль';
   ```
5. Верни обратно `scram-sha-256` в pg_hba.conf
6. Перезапусти сервер

### Ошибка «relation does not exist»

Таблица не существует в текущей базе. Проверь:

```sql
SELECT current_database();  -- в какой базе ты сейчас?
\dt                         -- какие таблицы есть?
```

Если нужная база — другая:

```sql
\c n8n_db
```

### Ошибка «permission denied»

Нет прав. Дай права:

```sql
GRANT ALL PRIVILEGES ON TABLE имя_таблицы TO имя_пользователя;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO имя_пользователя;
```

### Ошибка «could not open extension control file» (для PGVector)

Расширение PGVector не установлено в системе. Нужно скачать и установить (см. раздел 4).

### Ошибка «duplicate key value violates unique constraint»

Пытаешься вставить строку с id или уникальным полем, которое уже существует. Используй UPSERT:

```sql
INSERT INTO таблица (...) VALUES (...)
ON CONFLICT (уникальное_поле) DO UPDATE SET ...;
```

Или сбрось счётчик SERIAL:

```sql
SELECT setval(pg_get_serial_sequence('имя_таблицы', 'id'), (SELECT MAX(id) FROM имя_таблицы));
```

### Ошибка «different vector dimensions»

Размерность вектора в INSERT не совпадает с размерностью в таблице. Проверь:

```sql
\d documents
```

Посмотри, какая размерность указана для столбца `embedding`. Она должна совпадать с тем, что возвращает API эмбеддинга.

### Блокировки (deadlocks)

Посмотреть активные запросы:

```sql
SELECT pid, state, query, query_start
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start;
```

Убить зависший запрос:

```sql
SELECT pg_cancel_backend(PID);       -- мягко
SELECT pg_terminate_backend(PID);    -- принудительно
```

### Логи PostgreSQL

Файлы логов обычно находятся в:

```
C:\Program Files\PostgreSQL\16\data\log\
```

Самый свежий файл — текущий лог.

---

## 13. Полезные скрипты для проекта GigaChat

### Проверить состояние всех таблиц

```sql
SELECT
    t.tablename AS "Таблица",
    pg_size_pretty(pg_total_relation_size('public.' || t.tablename)) AS "Размер",
    s.n_live_tup AS "Строк"
FROM pg_tables t
LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname
WHERE t.schemaname = 'public'
ORDER BY pg_total_relation_size('public.' || t.tablename) DESC;
```

### Посмотреть загруженные документы

```sql
SELECT filename, COUNT(*) AS "Кусков", MIN(created_at) AS "Загружен"
FROM documents
GROUP BY filename
ORDER BY "Загружен" DESC;
```

### Удалить конкретный документ из базы знаний

```sql
DELETE FROM documents WHERE filename = 'имя_файла.pdf';
```

### Посмотреть историю чатов (последние 20 сообщений сессии)

```sql
SELECT role, LEFT(content, 80) AS "Сообщение", created_at
FROM chat_memory
WHERE session_id = 'ВАШ_SESSION_ID'
ORDER BY created_at DESC
LIMIT 20;
```

### Посмотреть все активные сессии чата

```sql
SELECT
    session_id,
    COUNT(*) AS "Сообщений",
    MIN(created_at) AS "Начало",
    MAX(created_at) AS "Последнее"
FROM chat_memory
GROUP BY session_id
ORDER BY "Последнее" DESC;
```

### Очистить историю чата конкретной сессии

```sql
DELETE FROM chat_memory WHERE session_id = 'ВАШ_SESSION_ID';
DELETE FROM chat_summaries WHERE session_id = 'ВАШ_SESSION_ID';
```

### Очистить всю историю чатов (ОСТОРОЖНО!)

```sql
TRUNCATE TABLE chat_memory RESTART IDENTITY;
TRUNCATE TABLE chat_summaries;
```

### Посмотреть резюме чатов

```sql
SELECT session_id, messages_summarized, updated_at, LEFT(summary_text, 100) AS "Резюме"
FROM chat_summaries
ORDER BY updated_at DESC;
```

### Статистика по заказам

```sql
SELECT
    status AS "Статус",
    COUNT(*) AS "Кол-во",
    ROUND(SUM(amount), 2) AS "Сумма",
    ROUND(AVG(amount), 2) AS "Средний чек"
FROM orders
GROUP BY status
ORDER BY "Сумма" DESC;
```

### Топ-5 клиентов по доставленным заказам

```sql
SELECT c.name, COUNT(o.id) AS "Заказов", SUM(o.amount) AS "Сумма"
FROM clients c
JOIN orders o ON c.id = o.client_id
WHERE o.status = 'delivered'
GROUP BY c.name
ORDER BY "Сумма" DESC
LIMIT 5;
```

### Тестовые данные — заполнить clients и orders

```sql
INSERT INTO clients (name, city, email, revenue) VALUES
('ООО Ромашка', 'Москва', 'romashka@mail.ru', 1500000.00),
('ООО Василёк', 'Казань', 'vasilek@mail.ru', 800000.00),
('ИП Иванов А.В.', 'Воронеж', 'ivanov@mail.ru', 350000.00),
('ЗАО Рассвет', 'Сочи', 'rassvet@mail.ru', 2200000.00),
('ООО ТехноСервис', 'Москва', 'techno@mail.ru', 4100000.00),
('ИП Петрова М.И.', 'Казань', 'petrova@mail.ru', 620000.00),
('ООО Горизонт', 'Новосибирск', 'gorizont@mail.ru', 1800000.00),
('ЗАО Меридиан', 'Екатеринбург', 'meridian@mail.ru', 950000.00);

INSERT INTO orders (client_id, product, amount, status, order_date) VALUES
(1, 'Сервер HP ProLiant', 450000.00, 'delivered', '2026-01-15'),
(1, 'Лицензия Windows Server', 85000.00, 'delivered', '2026-02-10'),
(2, 'Ноутбук Lenovo ThinkPad', 120000.00, 'delivered', '2026-01-20'),
(2, 'Монитор Dell 27"', 35000.00, 'pending', '2026-04-05'),
(3, 'Принтер Canon', 28000.00, 'delivered', '2026-03-01'),
(4, 'Система видеонаблюдения', 320000.00, 'delivered', '2026-02-25'),
(4, 'Сетевое оборудование Cisco', 180000.00, 'pending', '2026-04-15'),
(5, 'Серверная стойка', 95000.00, 'delivered', '2026-01-10'),
(5, 'СХД NetApp', 850000.00, 'delivered', '2026-03-20'),
(5, 'Лицензия VMware', 210000.00, 'cancelled', '2026-04-01'),
(6, 'Ноутбук HP EliteBook', 98000.00, 'delivered', '2026-02-15'),
(7, 'Сервер Dell PowerEdge', 520000.00, 'pending', '2026-04-20'),
(8, 'Коммутатор Huawei', 45000.00, 'delivered', '2026-03-10');
```

### Подключение n8n к PostgreSQL

В n8n при создании credential Postgres укажи:

| Поле | Значение |
|------|----------|
| Host | localhost (или IP-адрес сервера) |
| Database | n8n_db |
| User | postgres |
| Password | (твой пароль) |
| Port | 5432 |
| SSL | отключён (для локальной сети) |

---

## Шпаргалка: быстрые команды на каждый день

```
psql -U postgres -d n8n_db         — подключиться к базе
\dt                                — какие таблицы есть
\d clients                         — структура таблицы clients
SELECT COUNT(*) FROM clients;      — сколько строк в таблице
SELECT * FROM clients LIMIT 5;     — посмотреть первые 5 строк
\q                                 — выйти
```

```
pg_isready                         — работает ли сервер
net start postgresql-x64-16        — запустить сервер
net stop postgresql-x64-16         — остановить сервер
pg_dump -U postgres -d n8n_db > backup.sql   — сделать бэкап
```
