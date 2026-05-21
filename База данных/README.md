# База данных GigaChat

Всё, что нужно для развёртывания PostgreSQL под проект — в одной папке.

## Содержимое

| Файл | Что это |
|---|---|
| **[`init-db.sql`](init-db.sql)** | ⚡ **Главный файл** — одним прогоном собирает ВСЮ БД проекта (11 таблиц + 2 расширения + тестовые данные) |
| [`PostgreSQL-Guide.md`](PostgreSQL-Guide.md) | Полный гайд: установка Postgres, pgvector, доступ из LAN, частые запросы, бэкап/восстановление |
| [`OrgAppeal-Setup.md`](OrgAppeal-Setup.md) | Детально про таблицы алгоритма «Организация обращения» + 10 тест-сценариев |
| [`planner-schema.sql`](planner-schema.sql) | Только таблицы планировщика (если ставится отдельно от остального) |
| [`migration-v3-auth.sql`](migration-v3-auth.sql) | Миграция планировщика v2 → v3 (добавляет auth) |

---

## Быстрый старт: вся БД одним файлом

`init-db.sql` создаёт всё что нужно проекту:

**Расширения:** `pgcrypto`, `vector` (pgvector)

**Таблицы (11):**
| Кто использует | Таблицы |
|---|---|
| SQL-агент | `clients`, `orders` (+ тест-данные: 5 + 5) |
| RAG-агент | `documents` (vector(1024) + ivfflat-индекс) |
| Чат-агенты | `chat_memory`, `chat_summaries` |
| Планировщик | `planner_users`, `planner_sessions`, `planner_tasks` |
| Алгоритм «Организация обращения» | `appeal_employees`, `appeal_event1`, `appeal_event2` (+ тест-данные: 58 + 40 + 28) |

---

## Сценарий 1: PostgreSQL на Linux-сервере (по SSH)

Типичная офисная схема: Postgres стоит на удалённом Linux-сервере, ходишь к нему через `ssh`.

**Шаг 1 — со своего ПК положить `init-db.sql` на сервер:**

```powershell
scp -P 7022 "База данных/init-db.sql" postgres@130.100.X.X:~/
```

**Шаг 2 — зайти на сервер:**

```powershell
ssh postgres@130.100.X.X -p 7022
```

**Шаг 3 — на сервере снести старую БД и накатить новую:**

```bash
psql -U postgres -c "DROP DATABASE IF EXISTS ai_agent;"
psql -U postgres -c "CREATE DATABASE ai_agent;"
psql -U postgres -d ai_agent -f ~/init-db.sql
```

После этого `\dt` в `ai_agent` покажет 11 таблиц.

> ⚠️ **Перед DROP** убедись, что в `ai_agent` нет рабочих данных, которые жалко
> потерять (история чатов агентов, задачи планировщика). После DROP всё уйдёт.

---

## Сценарий 2: PostgreSQL в Docker (как у нас на dev-машине)

**Шаг 1 — снести контейнер и его volume:**

```powershell
docker stop postgres
docker rm postgres
$vol = docker inspect postgres --format '{{(index .Mounts 0).Name}}' 2>$null
if ($vol) { docker volume rm $vol }
```

**Шаг 2 — поднять контейнер с pgvector:**

```powershell
docker run -d --name postgres --network n8n-net --restart unless-stopped `
  -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin123 -e POSTGRES_DB=testdb `
  -p 5432:5432 pgvector/pgvector:pg16
```

**Шаг 3 — подождать готовности (5 сек) и накатить:**

```powershell
docker exec -i postgres psql -U admin -d testdb -v ON_ERROR_STOP=1 < "База данных/init-db.sql"
```

> ⚡ Используй именно образ **`pgvector/pgvector:pg16`** — стандартный `postgres:16`
> НЕ содержит расширения `vector`, и `init-db.sql` упадёт на `CREATE EXTENSION vector`.

---

## Сценарий 3: PostgreSQL на Windows (обычная установка)

```powershell
# 1. Сначала установи pgvector (см. PostgreSQL-Guide.md раздел 2)

# 2. Пересоздать БД и накатить
psql -U postgres -c "DROP DATABASE IF EXISTS ai_agent;"
psql -U postgres -c "CREATE DATABASE ai_agent;"
psql -U postgres -d ai_agent -f "База данных/init-db.sql"
```

---

## Проверка результата

После прогона `init-db.sql` должна вывестись таблица:

```
              List of relations
 Schema |       Name       | Type
--------+------------------+-------
 public | appeal_employees | table
 public | appeal_event1    | table
 public | appeal_event2    | table
 public | chat_memory      | table
 public | chat_summaries   | table
 public | clients          | table
 public | documents        | table
 public | orders           | table
 public | planner_sessions | table
 public | planner_tasks    | table
 public | planner_users    | table
(11 rows)
```

И расширения:

```
   Name   | Version
----------+---------
 pgcrypto | 1.3
 plpgsql  | 1.0
 vector   | 0.8.x
```

---

## Дальше

1. **Импортировать workflow в n8n** — см. [`../Import-Workflows-Guide.md`](../Import-Workflows-Guide.md). Postgres-credential должен указывать на ту БД, в которую мы только что накатили.
2. **Запустить агентов** — открой [`../GigaChat-Platform.html`](../GigaChat-Platform.html). Регистрация в планировщике, тестовые запросы к SQL-агенту по `clients`/`orders`, прогон 10 кейсов алгоритма обращений из [`../Tests/OrgAppeal/`](../Tests/OrgAppeal/) — всё должно работать сразу.

## Что если что-то сломалось

- **`CREATE EXTENSION vector` упал** — pgvector не установлен. См. [`PostgreSQL-Guide.md`](PostgreSQL-Guide.md) раздел 2, или используй Docker-образ `pgvector/pgvector:pg16`.
- **`role "postgres" does not exist`** — у тебя другой суперпользователь. В Docker-сетапе обычно `admin`, в чистой Linux-установке — `postgres`. Смотри переменную `POSTGRES_USER` контейнера или Linux-юзера на сервере.
- **Другие проблемы** — раздел «Если что-то сломалось» в [`PostgreSQL-Guide.md`](PostgreSQL-Guide.md).
