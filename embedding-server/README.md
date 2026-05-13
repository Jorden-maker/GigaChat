# Локальный сервис эмбеддингов для GigaChat

Простой HTTP-сервис на FastAPI, который превращает текст в векторы с помощью
модели **intfloat/multilingual-e5-large** (Multilingual-E5-large).

Полностью офлайн, работает в корпоративной LAN. Решает проблему, когда
существующий внутренний эндпойнт `/v1/db/vector/doc/` требует жёстких параметров
(`record_id`, `table_name`, `vector_table_name`) и сам пишет в БД — нам же нужно
просто получить вектор и сохранить его в свою таблицу `documents`.

---

## Оглавление

**ЕСЛИ В ОФИСЕ НЕТ ИНТЕРНЕТА — это твой путь:**

- [Этап 1. ДОМА (на ПК с интернетом)](#этап-1-дома-на-пк-с-интернетом)
- [Этап 2. В ОФИСЕ (на ПК без интернета)](#этап-2-в-офисе-на-пк-без-интернета)
- [Этап 3. Подключить к n8n](#этап-3-подключить-к-n8n)
- [Этап 4. Проверка цепочки](#этап-4-проверка-цепочки)
- [Если что-то сломается](#если-что-то-сломается)

**Если интернет есть и на офисном ПК** — обычная пошаговая инструкция:

1. [Что нужно перед началом](#1-что-нужно-перед-началом)
2. [Получить файлы сервера](#2-получить-файлы-сервера)
3. [Подготовка папки модели](#3-подготовка-папки-модели)
4. [Установка Python и зависимостей](#4-установка-python-и-зависимостей)
5. [Запуск сервера](#5-запуск-сервера)
6. [Проверка работы](#6-проверка-работы)
7. [Подключение к n8n](#7-подключение-к-n8n)
8. [Автозапуск при включении ПК](#8-автозапуск-при-включении-пк)
9. [Конфигурация](#9-конфигурация)
10. [API](#10-api)
11. [Решение частых проблем](#11-решение-частых-проблем)

---

# Полная установка для офиса без интернета

Делается один раз. Суммарно занимает час-полтора (большая часть — пассивное ожидание, пока качаются пакеты).

В репозитории есть два готовых скрипта: **`make-offline-bundle.ps1`** запускается дома (готовит бандл), **`install-offline.ps1`** — в офисе (ставит из бандла). Все длинные команды уже внутри них, тебе вспоминать ничего не надо.

---

## Этап 1. ДОМА (на ПК с интернетом)

### Шаг 1.1 — Скачать проект

1. Открой в браузере: **https://github.com/Jorden-maker/GigaChat**
2. Зелёная кнопка справа сверху **`Code`** → **`Download ZIP`**
3. Файл `GigaChat-main.zip` упадёт в `Загрузки`
4. **Распакуй** ZIP куда угодно
5. **Переименуй** распакованную папку: `GigaChat-main` → `GigaChat`
6. **Перемести** папку `GigaChat` на рабочий стол

После этого на рабочем столе будет папка `GigaChat`, а внутри: `Agents/`, `Workflow/`, `embedding-server/`, `PostgreSQL-Guide.md` и т.д.

### Шаг 1.2 — Открыть PowerShell в нужном месте

1. Открой **проводник** → зайди в `Desktop\GigaChat\embedding-server`
2. В **адресной строке проводника сверху** напечатай `powershell` и нажми Enter
3. Откроется PowerShell сразу в нужной папке

Или через меню Пуск → PowerShell, и руками:
```powershell
cd C:\Users\<твоё_имя>\Desktop\GigaChat\embedding-server
```

### Шаг 1.3 — Разрешить запуск скриптов (один раз на весь ПК)

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
Подтверди `Y` (Да).

### Шаг 1.4 — Собрать оффлайн-бандл

```powershell
.\make-offline-bundle.ps1
```

Скрипт сам:
- проверит Python,
- обновит pip,
- скачает все Python-пакеты (~3 GB) в подпапку `wheels`.

Время: **5–15 минут**, зависит от твоего интернета.

Когда увидишь зелёное **«ГОТОВО»** с числом скачанных пакетов — готово, можно закрывать PowerShell.

### Шаг 1.5 — Скопировать на флешку

На флешку скопируй **всю папку `GigaChat` целиком**. Внутри теперь:
- `Agents/`, `Workflow/`, гайды и т.д. (~MB)
- `embedding-server/wheels/` (~3 GB) ← это и есть бандл
- `embedding-server/server.py`, `install-offline.ps1` и т.д.

Размер флешки нужен **не менее 4 GB**.

---

## Этап 2. В ОФИСЕ (на ПК без интернета)

### Шаг 2.1 — Скопировать с флешки

Скопируй с флешки папку `GigaChat` **целиком на рабочий стол** офисного ПК.

После этого путь будет: `C:\Users\<твоё_имя>\Desktop\GigaChat\embedding-server`

### Шаг 2.2 — Проверить модель

Убедись, что модель лежит здесь:
```
C:\models\multilingual-e5-large
```

Если её там нет — положи. Без модели сервер не запустится.

### Шаг 2.3 — Открыть PowerShell в embedding-server

Проводник → `Desktop\GigaChat\embedding-server` → в адресной строке `powershell` → Enter.

### Шаг 2.4 — Разрешить запуск скриптов (один раз)

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
`Y` → Enter.

### Шаг 2.5 — Установить из бандла

```powershell
.\install-offline.ps1
```

Скрипт сам:
- проверит, что в папке всё на месте,
- создаст `venv`,
- активирует его,
- поставит все пакеты из локального `wheels/` (без интернета).

Время: **3–5 минут**.

В конце увидишь зелёное **«УСТАНОВКА УСПЕШНА»** и две подсказки про следующие команды.

### Шаг 2.6 — Запустить сервер

В том же окне PowerShell:

```powershell
$env:EMBED_MODEL = "C:\models\multilingual-e5-large"
python server.py
```

Через 1–3 минуты должно появиться:
```
[INFO] Loading model: C:\models\multilingual-e5-large
[INFO] Device: cpu
[INFO] Model loaded. Embedding dim: 1024
[INFO] Starting on http://0.0.0.0:8001
```

**Не закрывай это окно** — сервер живёт, пока оно открыто. Чтобы остановить — `Ctrl+C` в этом окне.

### Шаг 2.7 — Проверка что работает

Открой **второе** окно PowerShell:

```powershell
curl http://localhost:8001/health
```

Должен прийти JSON с `"status":"ok"` и `"dim":1024`. Если да — сервер живой.

---

## Этап 3. Подключить к n8n

### Шаг 3.1 — Узнать, как n8n будет ходить к серверу

| n8n запущен где                       | В URL вместо `EMBED_HOST` пиши            |
|---------------------------------------|--------------------------------------------|
| На том же ПК, что и embedding-server  | `localhost`                                |
| На другом ПК в офисной LAN            | IP офисного ПК (узнать через `ipconfig`)   |
| n8n в Docker, сервер на хосте         | `host.docker.internal`                     |

### Шаг 3.2 — Заменить заглушку в workflow

В файлах:
- `Workflow/document-loader.json`
- `Workflow/rag-agent.json`

Найди (Ctrl+F) текст `EMBED_HOST` и замени на твоё значение из шага 3.1. Сохрани.

### Шаг 3.3 — Перезалить workflow в n8n

В n8n: открой `document-loader` → меню `⋮` → **Import from File** → выбери обновлённый `.json`. То же самое с `rag-agent`. Активируй обоих.

---

## Этап 4. Проверка цепочки

1. Открой `document-loader.html` в браузере.
2. Загрузи любой тестовый PDF/текстовый файл.
3. Жди ответа.

Если приходит «Документ успешно загружен, кусков: N» — связка **html → n8n → embedding-server → PostgreSQL** работает.

Дальше тестируй RAG:
1. Открой `rag-agent.html`.
2. Задай вопрос по содержимому загруженного документа.
3. Должен прийти ответ со ссылками на куски документа.

---

## Если что-то сломается

Самые частые подводные:

| Симптом                                                          | Куда смотреть                                                  |
|------------------------------------------------------------------|----------------------------------------------------------------|
| `Could not find a version that satisfies ...` при install        | На офисном ПК Python другой major.minor — нужен 3.12           |
| `OSError: ... is not a valid model identifier`                   | Модель в «голом» формате transformers — см. раздел 11          |
| Скрипт ругается `running scripts is disabled`                    | Забыл `Set-ExecutionPolicy` (шаг 1.3 / 2.4)                    |
| Сервер запускается, но n8n не достучится                         | Firewall блокирует порт 8001, см. раздел 11                    |
| Очень медленно при первом запросе                                | Норма — первая инициализация модели на CPU                      |

Полный список проблем и решений — раздел [11. Решение частых проблем](#11-решение-частых-проблем) ниже.

### Что важно учесть про бандл

- **Версия Python дома и в офисе должна совпадать по major.minor.** Бандл, собранный на Python 3.12, ставится только на 3.12. На 3.11 не встанет (разные ABI у скомпилированных пакетов).
- **Архитектура должна совпадать.** Если дома Windows x64 и в офисе Windows x64 — норма. Если дома Mac/Linux — не подойдёт, нужен Windows для сборки бандла.
- **Бандл одноразовый.** Если в репозитории обновится `requirements.txt` — собирай заново.
- **HuggingFace online-verification в коде сервера отключена** — `server.py` уже выставляет `HF_HUB_OFFLINE=1` и `TRANSFORMERS_OFFLINE=1` при запуске. Модель грузится строго из локальной папки, без попыток ходить в интернет.

---

# Альтернативный путь — если на офисном ПК есть интернет

Если интернета хватит и в офисе — оффлайн-бандл не нужен, ставится обычным `pip install`. Ниже разделы 1–11 — для этого случая, плюс справка по API, конфигурации и автозапуску.

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

## 2. Получить файлы сервера

Сервер — это три файла: `server.py`, `requirements.txt`, `README.md`. Они лежат в репозитории GigaChat на GitHub в папке `embedding-server/`. На новом ПК их нужно получить любым из способов ниже.

> **Важно:** не путай папку, в которой создаёшь venv, с пустой папкой. Файлы `requirements.txt` и `server.py` обязательно должны лежать в этой папке РЯДОМ с папкой `venv`. Иначе `pip install -r requirements.txt` выдаст «No such file or directory».

### Способ A — клонировать весь репозиторий (рекомендуется, если есть git)

```powershell
cd C:\Users\<твоё_имя>\Desktop
git clone https://github.com/Jorden-maker/GigaChat.git
cd GigaChat\embedding-server
```

Если git не установлен — скачай его с [git-scm.com](https://git-scm.com/download/win) или используй способ B/C.

### Способ B — скачать ZIP с GitHub

1. Открой в браузере: https://github.com/Jorden-maker/GigaChat
2. Зелёная кнопка `Code` → `Download ZIP`.
3. Распакуй ZIP. GitHub отдаёт папку с именем `GigaChat-main` — переименуй её в просто `GigaChat`. Внутри будет `embedding-server/` — это и есть нужная папка с тремя файлами.

### Способ C — скачать только три файла сервера

Если хочешь только сервер (без всего проекта). Создай папку и перейди в неё в PowerShell:

```powershell
mkdir C:\Users\<твоё_имя>\Desktop\embedding-server
cd C:\Users\<твоё_имя>\Desktop\embedding-server

Invoke-WebRequest -Uri "https://raw.githubusercontent.com/Jorden-maker/GigaChat/main/embedding-server/server.py" -OutFile "server.py"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/Jorden-maker/GigaChat/main/embedding-server/requirements.txt" -OutFile "requirements.txt"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/Jorden-maker/GigaChat/main/embedding-server/README.md" -OutFile "README.md"
```

Проверь, что файлы скачались:
```powershell
dir
```
Должно показать `server.py`, `requirements.txt`, `README.md`. После этого переходи к шагу 4 (установка зависимостей).

---

## 3. Подготовка папки модели

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

Если их **нет** — модель в «голом» формате `transformers`. См. раздел [Решение частых проблем](#11-решение-частых-проблем), пункт «Модель без sentence-transformers конфигов».

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

## 4. Установка Python и зависимостей

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

## 5. Запуск сервера

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

## 6. Проверка работы

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

## 7. Подключение к n8n

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

## 8. Автозапуск при включении ПК

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

## 9. Конфигурация

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

## 10. API

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

## 11. Решение частых проблем

### `Could not find a version that satisfies the requirement ...` при `pip install`

На офисном ПК нет интернета и pip не может достучаться до PyPI. Это ожидаемо — обычный `pip install` оффлайн не работает. Нужен оффлайн-бандл, см. раздел [Установка на ПК без интернета](#установка-на-пк-без-интернета-оффлайн-бандл).

### `ERROR: Could not open requirements file: ... 'requirements.txt'`

Файлы сервера (`requirements.txt`, `server.py`) **не лежат в папке**, в которой ты сейчас находишься. Типовой случай: создал пустую папку, в ней `python -m venv venv`, но файлы из репозитория не положил.

Проверь:
```powershell
dir
```
Должно показать как минимум `requirements.txt`, `server.py` и папку `venv`. Если их нет — см. раздел [Получить файлы сервера](#2-получить-файлы-сервера) и скачай нужное.

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
