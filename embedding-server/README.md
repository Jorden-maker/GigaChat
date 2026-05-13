# Локальный сервис эмбеддингов для GigaChat

Простой HTTP-сервис на FastAPI, который превращает текст в векторы с помощью
модели **intfloat/multilingual-e5-large** (Multilingual-E5-large).

Полностью офлайн, работает в корпоративной LAN. Решает проблему, когда
существующий внутренний эндпойнт `/v1/db/vector/doc/` требует жёстких параметров
(`record_id`, `table_name`, `vector_table_name`) и сам пишет в БД — нам же нужно
просто получить вектор и сохранить его в свою таблицу `documents`.

---

## Оглавление

1. [Что нужно перед началом](#1-что-нужно-перед-началом)
2. [Подготовка папки модели](#2-подготовка-папки-модели)
3. [Установка Python и зависимостей](#3-установка-python-и-зависимостей)
4. [Запуск сервера](#4-запуск-сервера)
5. [Проверка работы](#5-проверка-работы)
6. [Подключение к n8n](#6-подключение-к-n8n)
7. [Автозапуск при включении ПК](#7-автозапуск-при-включении-пк)
8. [Конфигурация](#8-конфигурация)
9. [API](#9-api)
10. [Решение частых проблем](#10-решение-частых-проблем)

---

## 1. Что нужно перед началом

- **Сама модель Multilingual-E5-large** (папка ~9 GB) — у тебя уже есть на рабочем столе.
- **Python 3.10–3.12**. Если нет — скачать с [python.org](https://www.python.org/downloads/) и при установке **обязательно поставить галочку «Add Python to PATH»**.
- **~3 GB свободного места** под Python-зависимости (torch + transformers).
- **~4 GB свободной RAM** для CPU-режима (или GPU NVIDIA с 4+ GB VRAM для CUDA).
- **n8n** уже работает (на этом же ПК или на другой машине в LAN).

Проверь Python:
```powershell
python --version
```
Должно показать `Python 3.10.x` / `3.11.x` / `3.12.x`. Если показывает 3.9 или ниже — нужна новая версия. Если выводит ошибку — Python не в PATH, переустанови с галочкой.

---

## 2. Подготовка папки модели

### Что должно быть внутри папки

Открой папку с моделью (например `C:\Users\Lenovo\Desktop\Multilingual-E5-large`). Внутри должны быть следующие файлы:

**Обязательные:**
- `config.json`
- `tokenizer.json` (или `tokenizer.model`)
- `tokenizer_config.json`
- `model.safetensors` *или* `pytorch_model.bin` (или оба — нормально)

**Желательные (для `sentence-transformers` — самый простой способ загрузки):**
- `sentence_bert_config.json`
- `modules.json`
- `1_Pooling/config.json` (вложенная подпапка)

Если `sentence_bert_config.json` и `modules.json` **есть** — отлично, всё заработает «из коробки».

Если их **нет** — модель в «голом» формате `transformers`. См. раздел [Решение частых проблем](#10-решение-частых-проблем), пункт «Модель без sentence-transformers конфигов».

### Переименуй папку (рекомендуется)

Если в названии папки **есть пробелы или дефисы с пробелами** (например `Multilingual- E5 - large`) — переименуй в `multilingual-e5-large` без пробелов. С пробелами будут проблемы в командной строке.

```powershell
Rename-Item "C:\Users\Lenovo\Desktop\Multilingual- E5 - large" "multilingual-e5-large"
```

После переименования путь, который мы будем использовать дальше:
```
C:\Users\Lenovo\Desktop\multilingual-e5-large
```

> **Где лучше хранить модель?** Рабочий стол — нормально, ничего перемещать не обязательно. Но если хочется навести порядок — перенеси в `C:\models\multilingual-e5-large`, путь короче и понятнее.

---

## 3. Установка Python и зависимостей

Открой PowerShell **от обычного пользователя** (не от администратора). Перейди в папку сервера:

```powershell
cd C:\Users\Lenovo\Desktop\GigaChat\embedding-server
```

Создай виртуальное окружение (отдельное от системного Python — чтобы не засорять):

```powershell
python -m venv venv
```

Активируй окружение:

```powershell
.\venv\Scripts\Activate.ps1
```

В строке приглашения должно появиться `(venv)` слева. Это значит окружение активно.

> **Если PowerShell ругается** `... cannot be loaded because running scripts is disabled on this system` — выполни **один раз**:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```
> Ответь `Y` (Да). После этого повтори `.\venv\Scripts\Activate.ps1`.

Установи зависимости:

```powershell
pip install -r requirements.txt
```

Это займёт 5–15 минут (качается ~3 GB: torch, transformers, sentence-transformers и др.). Делается один раз.

---

## 4. Запуск сервера

В том же окне PowerShell (где активно `(venv)`):

```powershell
$env:EMBED_MODEL = "C:\Users\Lenovo\Desktop\multilingual-e5-large"
python server.py
```

При первом запуске модель грузится в память. На CPU это 1–3 минуты, на GPU — 10–20 секунд.

Если всё хорошо, должно появиться примерно такое:

```
2026-05-13 10:15:01 [INFO] Loading model: C:\Users\Lenovo\Desktop\multilingual-e5-large
2026-05-13 10:15:01 [INFO] Device: cpu
2026-05-13 10:15:42 [INFO] Model loaded. Embedding dim: 1024
2026-05-13 10:15:42 [INFO] Starting on http://0.0.0.0:8001
INFO:     Uvicorn running on http://0.0.0.0:8001 (Press CTRL+C to quit)
```

**Не закрывай это окно** — сервер работает, пока окно открыто. Закроешь окно — сервер остановится.

Чтобы остановить вручную — нажми `Ctrl+C` в окне.

---

## 5. Проверка работы

Открой **второе** окно PowerShell (первое не трогай — там сервер).

### Проверка живости

```powershell
curl http://localhost:8001/health
```

Ожидаемый ответ:
```json
{"status":"ok","model":"C:\\Users\\Lenovo\\Desktop\\multilingual-e5-large","dim":1024,"device":"cpu"}
```

### Получение вектора (тест)

```powershell
$body = '{"input":"тестовая фраза для проверки","type":"passage"}'
Invoke-RestMethod -Method POST -Uri http://localhost:8001/embed -ContentType "application/json" -Body $body
```

Должно вернуть объект с полем `embedding` — массив из 1024 чисел вида `[0.0145, -0.0231, ...]` и `dim: 1024`.

Если оба теста прошли — **сервис работает корректно**.

---

## 6. Подключение к n8n

В workflows `document-loader.json` и `rag-agent.json` URL-эндпойнт стоит как заглушка:

```
http://EMBED_HOST:8001/embed
```

Тебе нужно `EMBED_HOST` заменить на реальный адрес ПК, где запущен сервер эмбеддингов:

| Где запущен n8n                                  | На что менять `EMBED_HOST`                       |
|--------------------------------------------------|--------------------------------------------------|
| На том же ПК, что и сервер эмбеддингов           | `localhost`                                      |
| На другой машине в LAN                           | IP-адрес ПК с сервером (например `192.168.1.42`) |
| n8n в Docker, сервер на хосте                    | `host.docker.internal`                           |

### Как узнать IP в локальной сети

```powershell
ipconfig
```
Нужен IPv4 в активном адаптере (Ethernet или Wi-Fi). Обычно `192.168.x.x` или `10.x.x.x`.

### Применение изменений

1. Открой файл (например `Workflow/document-loader.json`) в любом текстовом редакторе.
2. Найди `EMBED_HOST` (Ctrl+F).
3. Замени на свой адрес. Сохрани.
4. Сделай то же самое в `Workflow/rag-agent.json`.
5. В n8n: открой workflow → меню `⋮` → `Import from File` (или удали старый и импортируй заново). Активируй workflow.

### Проверка цепочки document-loader → embedding

Загрузи тестовый документ через интерфейс `document-loader.html`. Если в ответе видишь «Документ успешно загружен» и в PostgreSQL появилась запись в `documents` — связка работает.

---

## 7. Автозапуск при включении ПК

Чтобы не запускать вручную каждый раз — сделай автозапуск.

### Windows: через Task Scheduler

**Шаг 1.** Создай в папке `embedding-server` файл `run-embed-server.bat`:

```bat
@echo off
cd /d C:\Users\Lenovo\Desktop\GigaChat\embedding-server
call venv\Scripts\activate.bat
set EMBED_MODEL=C:\Users\Lenovo\Desktop\multilingual-e5-large
python server.py
```

Поправь два пути под себя:
- `cd /d ...` — путь к папке `embedding-server`
- `set EMBED_MODEL=...` — путь к папке модели

Запусти `.bat` вручную, чтобы проверить — открывается окно с логами сервера? Если да — переходи к следующему шагу.

**Шаг 2.** Открой **Планировщик заданий** (`taskschd.msc`).

- Справа: «Создать задачу...» (не «Создать простую задачу»).
- **Вкладка «Общие»**:
  - Имя: `GigaChat Embedding Server`
  - «Выполнять только для вошедших пользователей» (галочка)
  - «Выполнять с наивысшими правами» (галочка — необязательно)
- **Вкладка «Триггеры»** → «Создать...»:
  - «Начать задачу: При входе в систему»
  - ОК
- **Вкладка «Действия»** → «Создать...»:
  - «Запуск программы»
  - «Программа или сценарий»: укажи полный путь к твоему `run-embed-server.bat`
  - ОК
- **Вкладка «Условия»**:
  - Сними галочку «Запускать только при питании от сети» (если ноутбук)
- **Вкладка «Параметры»**:
  - «Если задача уже выполняется: Не запускать новый экземпляр»
- ОК. Перезагрузи ПК — сервер должен подняться сам.

### Windows: запуск без чёрного окна (фоновый)

Если не хочешь, чтобы окно PowerShell висело на экране — можно прятать. Самый простой способ — установить пакет `nssm` (Non-Sucking Service Manager) и зарегистрировать сервер как Windows-службу. Скажи мне, если нужно — добавлю инструкцию.

### Linux: через systemd

Создай файл `/etc/systemd/system/gigachat-embed.service`:

```ini
[Unit]
Description=GigaChat Embeddings (Multilingual-E5-large)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gigachat/embedding-server
Environment=EMBED_MODEL=/opt/models/multilingual-e5-large
ExecStart=/opt/gigachat/embedding-server/venv/bin/python server.py
Restart=on-failure
RestartSec=10
User=gigachat

[Install]
WantedBy=multi-user.target
```

Активируй:
```bash
sudo systemctl daemon-reload
sudo systemctl enable gigachat-embed
sudo systemctl start gigachat-embed
sudo systemctl status gigachat-embed   # проверка
journalctl -u gigachat-embed -f         # смотреть логи
```

---

## 8. Конфигурация

Сервер читает настройки из переменных окружения. Менять значения можно либо в `.bat`/`.service`-файле автозапуска, либо в текущей сессии PowerShell перед запуском.

| Переменная     | По умолчанию                          | Описание                                |
|---------------:|---------------------------------------|-----------------------------------------|
| `EMBED_MODEL`  | `intfloat/multilingual-e5-large`      | HuggingFace id или путь к локальной папке |
| `EMBED_HOST`   | `0.0.0.0`                             | Интерфейс прослушивания (`0.0.0.0` = все) |
| `EMBED_PORT`   | `8001`                                | Порт                                    |
| `EMBED_DEVICE` | автоопределение                       | `cpu`, `cuda`, `mps` (Mac)              |

Пример: запустить только для localhost (закрыть от LAN), на порту 9000, форсированно на GPU:
```powershell
$env:EMBED_HOST = "127.0.0.1"
$env:EMBED_PORT = "9000"
$env:EMBED_DEVICE = "cuda"
$env:EMBED_MODEL = "C:\Users\Lenovo\Desktop\multilingual-e5-large"
python server.py
```

---

## 9. API

### `POST /embed`
Один текст → один вектор.

**Запрос:**
```json
{ "input": "Москва — столица России", "type": "passage" }
```

**Ответ:**
```json
{
  "embedding": [0.0145, -0.0231, ...],
  "dim": 1024,
  "model": "intfloat/multilingual-e5-large"
}
```

Поле `"type"`:
- `"passage"` (по умолчанию) — для индексации документов
- `"query"` — для пользовательского вопроса при поиске

> **Важно:** E5-моделям критична разница между passage и query. Это даёт значительно лучшее качество поиска. Document-loader использует `passage`, rag-agent — `query`. Это уже настроено в обновлённых workflow.

### `POST /embed_batch`
Несколько текстов сразу.

**Запрос:**
```json
{ "input": ["кусок 1", "кусок 2"], "type": "passage" }
```

**Ответ в OpenAI-совместимом формате:**
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

## 10. Решение частых проблем

### `OSError: ... is not a valid model identifier`

Модель в «голом» формате `transformers`, без файлов `sentence_bert_config.json` / `modules.json`. Не критично — открой `server.py`, найди строку:

```python
model = SentenceTransformer(MODEL_NAME, device=device)
```

И замени блок загрузки на:

```python
from transformers import AutoTokenizer, AutoModel
import torch.nn.functional as F

tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
hf_model = AutoModel.from_pretrained(MODEL_NAME).to(device)
hf_model.eval()
EMB_DIM = hf_model.config.hidden_size

def encode(texts, kind):
    prepared = add_e5_prefix(texts, kind)
    batch = tokenizer(prepared, padding=True, truncation=True, max_length=512, return_tensors='pt').to(device)
    with torch.no_grad():
        out = hf_model(**batch)
    # mean pooling по attention mask
    mask = batch['attention_mask'].unsqueeze(-1).float()
    emb = (out.last_hidden_state * mask).sum(1) / mask.sum(1)
    emb = F.normalize(emb, p=2, dim=1)
    return [v.tolist() for v in emb.cpu()]
```

Если столкнёшься с этим — напиши, помогу подставить.

### Грузится 10+ минут

Норма для первого запуска без GPU. Модель кэшируется в RAM, при повторных запросах работает быстро.

### `Out of memory` / процесс убит

Модель не помещается в RAM. Варианты:
- **Использовать FP16** — в `server.py` найди `SentenceTransformer(MODEL_NAME, device=device)` и замени на:
  ```python
  model = SentenceTransformer(MODEL_NAME, device=device, model_kwargs={'torch_dtype': torch.float16})
  ```
  Сэкономит ~50% памяти. Качество страдает минимально.
- **Брать меньшую модель** — `intfloat/multilingual-e5-base` (~1 GB, dim=768) или `e5-small` (~470 MB, dim=384). Если перейдёшь на base/small — поменяй `vector(1024)` на `vector(768)` или `vector(384)` в SQL.

### n8n не достучится: `ECONNREFUSED` или таймаут

1. **Сервер запущен?** Проверь, что окно с `python server.py` открыто и в нём нет красных ошибок.
2. **Правильный URL в workflow?** Открой узел «Эмбеддинг» в n8n → поле URL должно содержать твой IP, не `EMBED_HOST`.
3. **Firewall блокирует?** На ПК с сервером выполни:
   ```powershell
   New-NetFirewallRule -DisplayName "GigaChat Embed" -LocalPort 8001 -Protocol TCP -Action Allow -Direction Inbound
   ```
   (нужны права администратора)
4. **n8n в Docker?** Используй `host.docker.internal` вместо `localhost`, а не IP хоста.

### Сервер запускается, но `/embed` возвращает 500

Открой окно сервера — внизу будет traceback. Самое частое: ошибка токенизации (текст слишком длинный). E5-large обрабатывает до 512 токенов. В `document-loader.json` нарезка идёт по 500 слов с перекрытием 50 — это норма, но иногда длинное слово может выйти за лимит. Если видишь ошибки — увеличь усечение в `encode`:
```python
vectors = model.encode(prepared, batch_size=8, normalize_embeddings=True, show_progress_bar=False, truncate_dim=None)
```

### Хочу проверить с другой машины LAN

С другого ПК в локальной сети:
```powershell
curl http://192.168.1.42:8001/health
```
(подставь свой IP). Если отвечает — всё работает.

### Сервер периодически падает

Включи автоперезапуск через Task Scheduler («Если задача не выполнена: Перезапускать каждые 1 мин»). Для systemd это уже встроено через `Restart=on-failure`.

---

## Где это используется в проекте

| Файл                                  | Узел в n8n               | Что делает                                  |
|---------------------------------------|--------------------------|---------------------------------------------|
| `Workflow/document-loader.json`       | «Эмбеддинг»              | Векторизует куски текста при загрузке доков |
| `Workflow/rag-agent.json`             | «Эмбеддинг вопроса»      | Векторизует пользовательский вопрос         |

В таблице `documents` колонка `embedding VECTOR(1024)` — размерность совпадает с моделью E5-large. См. `PostgreSQL-Guide.md` раздел «Размерность вектора», если хочешь использовать другую модель.
