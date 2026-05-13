# Локальный сервис эмбеддингов для GigaChat

Простой HTTP-сервис на FastAPI, который превращает текст в векторы с помощью
модели **intfloat/multilingual-e5-large** (Multilingual-E5-large).

Полностью офлайн, работает в корпоративной LAN. Решает проблему, когда
существующий внутренний эндпойнт `/v1/db/vector/doc/` требует жёстких параметров
(`record_id`, `table_name`, `vector_table_name`) и сам пишет в БД — нам же нужно
просто получить вектор и сохранить его в свою таблицу `documents`.

---

## Установка

### 1. Получить модель

У вас на офисном ПК модель уже есть. Скопируйте её в любую папку, например:

```
C:\models\multilingual-e5-large
```

Структура папки модели должна быть стандартной (HuggingFace):
```
multilingual-e5-large/
  config.json
  model.safetensors
  sentence_bert_config.json
  tokenizer.json
  tokenizer_config.json
  ...
```

Если модели нет — сервис автоматически скачает её при первом запуске
(но для офлайн-LAN нужно положить локально).

### 2. Установить Python-зависимости

Нужен Python 3.10+ (3.11 или 3.12 ОК).

```powershell
cd embedding-server
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
```

На CPU работает, но GPU быстрее (CUDA или MPS на Mac).

### 3. Запустить сервис

```powershell
# Если модель локально:
$env:EMBED_MODEL = "C:\models\multilingual-e5-large"
python server.py

# Или через HuggingFace id (нужен интернет при первом запуске):
python server.py
```

По умолчанию слушает на `http://0.0.0.0:8001` — доступен по локальной сети.

### 4. Автозапуск (опционально)

**Windows (Task Scheduler):**
1. Создайте `.bat`:
   ```bat
   @echo off
   cd /d C:\path\to\GigaChat\embedding-server
   call venv\Scripts\activate.bat
   set EMBED_MODEL=C:\models\multilingual-e5-large
   python server.py
   ```
2. Task Scheduler → создать задачу → запуск при входе → действие = ваш .bat.

**Linux (systemd):**
```ini
[Unit]
Description=GigaChat Embeddings
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gigachat/embedding-server
Environment=EMBED_MODEL=/opt/models/multilingual-e5-large
ExecStart=/opt/gigachat/embedding-server/venv/bin/python server.py
Restart=on-failure
User=gigachat

[Install]
WantedBy=multi-user.target
```

---

## Конфигурация

| Переменная     | По умолчанию                          | Описание                                |
|---------------:|---------------------------------------|-----------------------------------------|
| `EMBED_MODEL`  | `intfloat/multilingual-e5-large`      | HF id или путь к локальной папке модели |
| `EMBED_HOST`   | `0.0.0.0`                             | Интерфейс, на котором слушать           |
| `EMBED_PORT`   | `8001`                                | Порт                                    |
| `EMBED_DEVICE` | автоопределение                       | `cpu`, `cuda`, `mps`                    |

---

## API

### `POST /embed`
Один текст → один вектор.

```json
// Запрос
{ "input": "Москва — столица России", "type": "passage" }

// Ответ
{
  "embedding": [0.0145, -0.0231, ...],   // 1024 float
  "dim": 1024,
  "model": "intfloat/multilingual-e5-large"
}
```

Поле `"type"`:
- `"passage"` (по умолчанию) — для индексации документов
- `"query"` — для пользовательского вопроса при поиске

E5 моделям важна разница между passage и query — это даёт лучшее качество поиска.

### `POST /embed_batch`
Несколько текстов сразу.

```json
{ "input": ["кусок 1", "кусок 2"], "type": "passage" }
```

Ответ в OpenAI-совместимом формате:
```json
{
  "data": [
    { "embedding": [...], "index": 0 },
    { "embedding": [...], "index": 1 }
  ],
  "dim": 1024
}
```

### `GET /health`
Проверка живости.

```json
{ "status": "ok", "model": "...", "dim": 1024, "device": "cuda" }
```

---

## Где это используется

В workflows n8n:
- `document-loader.json` → узел «Эмбеддинг»  (`/embed`, type=passage)
- `rag-agent.json` → узел «Эмбеддинг вопроса»  (`/embed`, type=query)

URL в workflow: `http://<хост-с-эмбеддингом>:8001/embed`.

В таблице `documents` колонка `embedding VECTOR(1024)` (если у вас стояло
другое значение — нужно мигрировать, см. PostgreSQL-Guide.md).
