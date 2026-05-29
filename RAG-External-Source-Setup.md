# RAG: подключение внешней базы документов (rel_db)

RAG-агент после R8.35 умеет искать **одновременно** в двух источниках:
- **Наша** `documents` в `ai_agent` (всё что мы сами загружали через document-loader)
- **Внешняя** таблица в `rel_db` (та что уже была наполнена в офисе)

Каждый результат тегается полем `source` (`'наш'` / `'внешний'`), мержится по `cosine_similarity`, верхний топ-5 уходит в LLM.

Если внешний источник не настроен — нод `Поиск внешний` тихо вернёт ошибку, RAG продолжит работать **только** по нашей `documents` (никаких регрессий по существующему пути).

---

## Что нужно настроить в офисе (3 шага, ~5 минут)

### Шаг 1. Узнать имя схемы и таблицы

В DBeaver/pgAdmin подключись к **`rel_db`** и прогони:

```sql
-- Какие схемы есть (кроме системных)
SELECT schema_name
FROM information_schema.schemata
WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
ORDER BY schema_name;

-- Найти таблицу по характерным столбцам
SELECT table_schema, table_name, COUNT(*) AS matched_cols
FROM information_schema.columns
WHERE column_name IN (
  'vector','text','document_id','file_name',
  'chunk_index','total_chunks','metadata','uploaded_at'
)
GROUP BY table_schema, table_name
HAVING COUNT(*) >= 6
ORDER BY matched_cols DESC;
```

Запиши: **`<схема>.<таблица>`**.

Опционально проверить что вектор 1024:
```sql
SELECT array_length(vector::real[], 1) FROM <схема>.<таблица> LIMIT 1;
```
Должно вернуть `1024`. Если другая цифра — стоп, скажи мне.

### Шаг 2. Создать в n8n credential для `rel_db`

1. В n8n UI → **Credentials** → **New**
2. Выбрать **Postgres**
3. Скопировать поля host / port / user / password от существующей `Postgres` credential
4. Изменить **database** → `rel_db` (вместо `ai_agent`)
5. Сохранить с именем **`Postgres rel_db`** (важно — именно так, чтобы было понятно)

### Шаг 3. Подключить credential

Имя таблицы **уже вписано** в SQL ноды (R8.41): `_vectordocuments.v_general` в базе `rel_db`. Тебе нужно только привязать credential:

**Вариант А — через скрипт (рекомендую):**
1. Создай credential `Postgres rel_db` (Шаг 2)
2. Запусти `.\import-workflows.ps1 -ResetCreds`
3. Скрипт сам подставит ID в нод «Поиск внешний». В выводе должно быть `postgres / Postgres rel_db -> id: <uuid>` (без «ID не получен») и БЕЗ блока «⚠️ ВРЕМЕННЫЕ FALLBACK CREDENTIALS».

**Вариант Б — вручную в UI:**
1. n8n → workflow `[GigaChat] RAG-Агент. Поток` → нод **«Поиск внешний»**
2. Вкладка **Credentials** → выбрать `Postgres rel_db`
3. Сохранить workflow

> ⚠️ Если credential не привязан к `rel_db` — нод пойдёт искать `_vectordocuments.v_general` в `ai_agent` (где её нет) → onError → RAG продолжит работать только по нашей `documents`. Ничего не сломается, просто внешний поиск не подключится.

**Финальный SQL в ноде** (для справки, менять не надо):
```sql
SELECT file_name AS filename, chunk_index, "text" AS chunk_text,
       1 - ("vector" <=> $1::vector) AS similarity, 'внешний' AS source
FROM _vectordocuments.v_general
ORDER BY "vector" <=> $1::vector LIMIT 5
```
`"text"` и `"vector"` в кавычках — это имена-типы PostgreSQL, в кавычках трактуются как имена столбцов.

Готово. RAG теперь ищет в обеих базах.

---

## Как проверить что работает

В RAG-чате задай вопрос по теме которая точно есть **только** во внешней базе (не в нашей). Если LLM отвечает осмысленно — двойной поиск работает.

Если ответ всё ещё «не нашёл документов»:
1. В n8n открой последний execution
2. Посмотри ноды **«Поиск внешний»** и **«Объединить документы»**
3. Если `Поиск внешний` показывает 0 результатов:
   - Проверь credential подключён
   - Проверь имя таблицы (без опечаток, с правильной схемой)
   - Запусти в DBeaver `SELECT count(*) FROM <схема>.<таблица>` — есть ли вообще данные
4. Если ошибка `column "vector" does not exist` — значит у них вектор хранится не в столбце `vector`. Скажи мне его реальное имя, поправлю SQL.

---

## Откатить (если что-то пошло не так)

В n8n удалить три новых нода: **«Поиск внешний»**, **«Merge внешний+наш»**, **«Объединить документы»**. Старые связи «Построить поиск → Поиск в документах → Проверка документов» вернуть. Или просто `git revert` коммита `R8.35` локально и `import-workflows.ps1` заново.

---

## Технические детали (для понимания)

- **Document-loader НЕ ТРОГАЕТСЯ.** Он продолжает писать в нашу `documents`. Их таблица — read-only с нашей стороны.
- **Embedding нашего запроса считается ОДИН РАЗ** в ноде «Эмбеддинг вопроса», обе ветки поиска используют один и тот же вектор.
- **Маппинг колонок:**
  | Наша `documents` | Их таблица |
  |---|---|
  | `filename` | `file_name` |
  | `chunk_text` | `text` |
  | `embedding` | `vector` |
  | `chunk_index` | `chunk_index` |
- **Поля `document_id`, `total_chunks`, `metadata`, `uploaded_at` в их таблице игнорируются** — RAG-агенту они не нужны.
- **Дедупликация по `(filename, chunk_index)` НЕ ДЕЛАЕТСЯ.** Если в обеих базах окажется файл с одинаковым именем — оба чанка будут в выборке. Если нужно — добавлю.
- **Порог similarity ≥ 0.5** (из R7) применяется уже после мержа, к обеим источникам одинаково.
