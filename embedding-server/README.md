# Локальный сервис эмбеддингов для GigaChat

Простой HTTP-сервис на FastAPI, который превращает текст в векторы с помощью
модели **intfloat/multilingual-e5-large** (Multilingual-E5-large).

Полностью офлайн, работает в корпоративной LAN. Решает проблему, когда
существующий внутренний эндпойнт `/v1/db/vector/doc/` требует жёстких параметров
(`record_id`, `table_name`, `vector_table_name`) и сам пишет в БД — нам же нужно
просто получить вектор и сохранить его в свою таблицу `documents`.

---

## Оглавление

**Полная установка от GitHub до рабочего сервера в LAN:**

- [Этап 1. На ПК с интернетом — скачать два ZIP с GitHub](#этап-1-на-пк-с-интернетом--скачать-два-zip-с-github)
- [Этап 2. Перенести оба ZIP в LAN](#этап-2-перенести-оба-zip-в-lan)
- [Этап 3. На целевом ПК в LAN — установить и запустить](#этап-3-на-целевом-пк-в-lan--установить-и-запустить)
- [Этап 4. Подключить к n8n](#этап-4-подключить-к-n8n)
- [Этап 5. Проверка цепочки](#этап-5-проверка-цепочки)
- [Если что-то сломается](#если-что-то-сломается)

**Справочник:**

- [Автозапуск при включении ПК](#автозапуск-при-включении-пк)
- [Конфигурация (переменные окружения)](#конфигурация-переменные-окружения)
- [API сервера](#api-сервера)
- [Решение частых проблем](#решение-частых-проблем)

---

# Полная установка

Делается один раз. Суммарно занимает 20–30 минут (большая часть — пассивная установка пакетов).

**Схема развёртывания:**

1. **На ПК с интернетом** (любом — домашнем, офисном-гейтвее, ноутбуке) открываешь GitHub, скачиваешь **два ZIP-файла**.
2. **Переносишь их в офисную LAN** — внутренней сетью, расшаренной папкой, флешкой — как удобно.
3. **На целевом ПК в LAN** (без интернета) распаковываешь, запускаешь установку и сервер.

В репозитории есть скрипт **`install-offline.ps1`**, который на целевом ПК сам распакует бандл, поставит пакеты и подскажет команды для запуска. Скрипт **`make-offline-bundle.ps1`** нужен только в редком случае — если на целевом ПК стоит Python другой версии (не 3.12), см. шаг 1.3.

---

## Этап 1. На ПК с интернетом — скачать два ZIP с GitHub

### Шаг 1.1 — Скачать проект GigaChat

1. В браузере открой: **https://github.com/Jorden-maker/GigaChat**
2. Зелёная кнопка справа сверху **`Code`** → **`Download ZIP`**
3. Скачается файл `GigaChat-main.zip` (~MB) — упадёт в `Загрузки`

### Шаг 1.2 — Скачать `wheels.zip`

1. В браузере открой: **https://github.com/Jorden-maker/GigaChat/releases/latest**
2. Внизу страницы в разделе **`Assets`** клик по `wheels.zip` (~204 MB)
3. Дождись окончания скачивания

В итоге в `Загрузки` лежат **два файла**:
- `GigaChat-main.zip` — код проекта
- `wheels.zip` — Python-пакеты (44 .whl под Python 3.12 + CPU torch)

### Шаг 1.3 — (опционально) Собрать свой бандл

Используй этот шаг **только если** на целевом ПК в LAN Python другой версии (не 3.12). В таком случае готовый `wheels.zip` из Releases не подойдёт — wheels привязаны к major.minor (3.12 ставится только на 3.12.x).

Чтобы собрать свой:

1. Распакуй `GigaChat-main.zip`, переименуй папку в `GigaChat`.
2. Открой PowerShell в `GigaChat\embedding-server`.
3. Разреши запуск скриптов:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

4. Собери бандл (15 минут, нужен интернет):

   ```powershell
   .\make-offline-bundle.ps1
   ```

5. Упакуй обратно в ZIP:

   ```powershell
   Compress-Archive -Path wheels -DestinationPath wheels.zip -Force
   ```

**Важно:** версия Python на этом ПК (где запускаешь `make-offline-bundle.ps1`) должна **совпадать** с Python на целевом ПК в LAN.

---

## Этап 2. Перенести оба ZIP в LAN

Два файла (`GigaChat-main.zip` + `wheels.zip`) любым удобным способом — внутренней сетью, расшаренной папкой, флешкой между ПК-гейтвеем и целевым ПК. Способ роли не играет.

Главное — оба ZIP должны оказаться на целевом ПК.

---

## Этап 3. На целевом ПК в LAN — установить и запустить

### Шаг 3.1 — Распаковать проект

1. ПКМ по `GigaChat-main.zip` → **«Извлечь всё»** → выбрать место (например рабочий стол) → **«Извлечь»**.
2. Распакованную папку **переименовать**: `GigaChat-main` → `GigaChat`.
3. Положить на рабочий стол.

Должна получиться структура `<куда положил>\GigaChat\embedding-server\` со скриптами внутри.

### Шаг 3.2 — Положить `wheels.zip` рядом со скриптом

Файл `wheels.zip` положи **внутрь папки** `GigaChat\embedding-server\` — рядом с `install-offline.ps1`. **Не распаковывать!** Скрипт сам распакует при запуске.

После этого в `embedding-server` должно быть **6 файлов**:
- `install-offline.ps1`
- `make-offline-bundle.ps1`
- `README.md`
- `requirements.txt`
- `server.py`
- `wheels.zip` ← вот этот ты положил

### Шаг 3.3 — Проверить, что модель на месте

Открой проводник и убедись, что есть папка:

```
C:\models\multilingual-e5-large
```

Внутри должны быть файлы `config.json`, `model.safetensors` (или `pytorch_model.bin`), `tokenizer.json`, `sentence_bert_config.json`, `modules.json` и др.

Если папки нет — положи модель туда. **Без модели сервер не запустится.**

### Шаг 3.4 — Узнать IP целевого ПК

Этот IP нужен будет для подключения n8n и других ПК в LAN. Открой PowerShell, выполни:

```powershell
ipconfig
```

В выводе найди секцию активного сетевого адаптера (`Ethernet adapter` или `Wireless LAN adapter`) → строку **`IPv4-адрес`**:

```
IPv4-адрес. . . . . . . . . . . . : 192.168.1.42
```

Запиши себе этот адрес — он понадобится в Этапе 4.

### Шаг 3.5 — Открыть PowerShell в папке embedding-server

Самый простой способ:

1. Открой **проводник** → перейди в `<твой_путь>\GigaChat\embedding-server`.
2. В **адресной строке проводника сверху** напечатай:

   ```
   powershell
   ```

3. Нажми Enter — PowerShell откроется прямо в этой папке.

### Шаг 3.6 — Разрешить запуск скриптов (один раз на целевом ПК)

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Подтверди `Y` (Да) → Enter.

### Шаг 3.7 — Открыть порт 8001 в Firewall (один раз, от админа)

Чтобы embedding-сервер был доступен с других ПК в LAN, нужно открыть входящий порт 8001.

**Важно:** эта команда требует **прав администратора**.

1. Закрой текущий PowerShell.
2. Открой меню Пуск → начни печатать `PowerShell`.
3. На результате ПКМ → **`Запуск от имени администратора`** → подтверди UAC-окно.
4. В заголовке окна появится `Администратор: Windows PowerShell`.
5. Выполни команду:

   ```powershell
   New-NetFirewallRule -DisplayName "GigaChat Embed" -LocalPort 8001 -Protocol TCP -Action Allow -Direction Inbound
   ```

6. Закрой это админ-окно. Правило сохранится навсегда.

### Шаг 3.8 — Установить из бандла

Снова открой обычный PowerShell в `embedding-server` (как в шаге 3.5) и запусти:

```powershell
.\install-offline.ps1
```

Что увидишь по этапам:
- `==> Проверка Python...` → `Python 3.12.x`
- `==> Найден wheels.zip — распаковываю в папку wheels...` → `Распаковка завершена.`
- `==> Проверка файлов бандла...` → `requirements.txt: OK`, `server.py: OK`, `wheels: 44 .whl файлов`
- `==> Создание виртуального окружения...` (10–30 сек)
- `==> Активация...`
- `==> Установка зависимостей из локальных wheels (без интернета)...` ← **самая длинная часть, 3–5 минут**, много вывода pip
- В конце зелёный блок **«УСТАНОВКА УСПЕШНА»** + подсказки

В строке приглашения PowerShell слева появится `(venv)` — это значит виртуальное окружение активно и можно запускать сервер.

### Шаг 3.9 — Указать путь к модели

В том же окне (с активным `(venv)`):

```powershell
$env:EMBED_MODEL = "C:\models\multilingual-e5-large"
```

Команда отрабатывает мгновенно, ничего не печатает. Просто возвращается приглашение `PS C:\...>` на следующей строке.

### Шаг 3.10 — Запустить сервер

```powershell
python server.py
```

Через 1–3 минуты должно появиться:

```
[INFO] Loading model: C:\models\multilingual-e5-large
[INFO] Device: cpu
[INFO] Model loaded. Embedding dim: 1024
[INFO] Starting on http://0.0.0.0:8001
INFO:     Uvicorn running on http://0.0.0.0:8001 (Press CTRL+C to quit)
```

**Не закрывай это окно** — сервер живёт, пока окно открыто. Чтобы остановить — `Ctrl+C` в этом окне.

> `http://0.0.0.0:8001` в логе — это служебный адрес «слушаю на всех интерфейсах». **Для подключения с других ПК используй IP из шага 3.4**, например `http://192.168.1.42:8001`.

### Шаг 3.11 — Проверка локально

Открой **второе** окно PowerShell (первое не трогай — там сервер).

```powershell
curl http://localhost:8001/health
```

Должен прийти JSON примерно такой:

```
{"status":"ok","model":"C:\\models\\multilingual-e5-large","dim":1024,"device":"cpu"}
```

### Шаг 3.12 — Проверка отправки на эмбеддинг

В том же втором окне создай переменную с телом запроса:

```powershell
$body = '{"input":"тестовая фраза","type":"passage"}'
```

Команда отрабатывает мгновенно, ничего не печатает.

Затем отправь запрос:

```powershell
Invoke-RestMethod -Method POST -Uri http://localhost:8001/embed -ContentType "application/json" -Body $body
```

Должен вернуться объект с полем `embedding` (массив из 1024 чисел) и `dim: 1024`. Если так — **сервер полностью рабочий**.

### Шаг 3.13 — Проверка с другого ПК в LAN

С **любого другого** ПК в офисной LAN, в PowerShell:

```powershell
curl http://192.168.1.42:8001/health
```

(подставь свой IP из шага 3.4)

Если приходит тот же JSON — embedding-сервер доступен по LAN как и n8n.

Если не отвечает — см. раздел [Если что-то сломается](#если-что-то-сломается), пункт про Firewall.

---

## Этап 4. Подключить к n8n

### Шаг 4.1 — Понять, какой URL писать вместо `EMBED_HOST`

| n8n запущен где                                | Что писать вместо `EMBED_HOST`                |
|------------------------------------------------|------------------------------------------------|
| На том же ПК, что и embedding-сервер           | `localhost`                                    |
| На другом ПК в офисной LAN                     | IP целевого ПК из шага 3.4 (например `192.168.1.42`) |
| n8n в Docker, embedding-сервер на хост-машине  | `host.docker.internal`                         |

### Шаг 4.2 — Заменить заглушку в `document-loader.json`

1. Открой файл `Workflow\document-loader.json` в Блокноте (или любом текстовом редакторе).
2. Нажми `Ctrl+F` и найди текст `EMBED_HOST` — он встречается **один раз**, в строке вроде:

   ```
   "url": "http://EMBED_HOST:8001/embed"
   ```

3. Замени `EMBED_HOST` на твоё значение из шага 4.1.

   Пример (если используешь IP):
   ```
   "url": "http://192.168.1.42:8001/embed"
   ```

4. Сохрани файл (`Ctrl+S`).

### Шаг 4.3 — Заменить заглушку в `rag-agent.json`

Точно так же:

1. Открой `Workflow\rag-agent.json`.
2. `Ctrl+F` → найди `EMBED_HOST`.
3. Замени на свой IP/localhost/host.docker.internal.
4. Сохрани.

### Шаг 4.4 — Перезалить workflow в n8n

1. В n8n открой workflow `document-loader`.
2. Меню **`⋮`** (три точки справа сверху) → **`Import from File`** → выбери обновлённый `document-loader.json` → импорт.
3. Активируй тумблером `Active` справа сверху.
4. То же самое для `rag-agent.json`.

---

## Этап 5. Проверка цепочки

### Шаг 5.1 — Загрузить тестовый документ

1. Открой `Agents/document-loader.html` в браузере.
2. Загрузи любой тестовый PDF или текстовый файл.
3. Подожди ответ.

**Ожидание:** «Документ "имя.pdf" успешно загружен! Распознано и сохранено кусков: N».

Если так — связка **HTML → n8n → OCR → embedding-сервер → PostgreSQL** работает.

### Шаг 5.2 — Задать вопрос по документу через RAG

1. Открой `Agents/rag-agent.html` в браузере.
2. Задай вопрос по содержимому загруженного документа: например «что написано в [имя_документа]?»
3. Подожди ответ.

**Ожидание:** ответ от модели со ссылками на найденные куски документа (с источником `(файл: имя.pdf)`).

Если так — **вся система собрана и работает**.

---

## Если что-то сломается

Самые частые подводные:

| Симптом                                                              | Куда смотреть                                                                |
|----------------------------------------------------------------------|------------------------------------------------------------------------------|
| `install-offline.ps1` падает с `Could not find a version that satisfies` | На целевом ПК Python другой версии. Проверь `python --version`. Нужно 3.12.x. Если 3.10/3.11 — пересобери бандл через шаг 1.3 на ПК с такой же версией. |
| Скрипт ругается `running scripts is disabled on this system`         | Забыл выполнить `Set-ExecutionPolicy` (шаг 3.6). Запусти и повтори.          |
| `New-NetFirewallRule` → `Access is denied`                           | PowerShell открыт от обычного пользователя. Закрой и открой от админа (шаг 3.7). |
| `python server.py` падает с `OSError: ... is not a valid model identifier` | Модель в «голом» формате transformers. См. раздел [Решение частых проблем](#решение-частых-проблем). |
| Сервер живой локально, но n8n возвращает таймаут или `ECONNREFUSED`  | 1. В workflow IP правильный? Не `EMBED_HOST` остался? 2. Firewall открыт (шаг 3.7)? 3. ПК в одной подсети? |
| `curl http://<IP>:8001/health` с другого ПК LAN не отвечает          | Firewall блокирует. Проверь правило: `Get-NetFirewallRule -DisplayName "GigaChat Embed"`. Если правила нет — повтори шаг 3.7. |
| Очень медленный первый запрос к `/embed`                              | Норма — модель кэшируется в RAM при первом обращении. Следующие быстрее.    |
| Эмбеддинг возвращает `dim: 768` или другое число вместо 1024         | В `C:\models\multilingual-e5-large` лежит не та модель (base вместо large). Проверь имя и содержимое папки. |

### Что важно учесть про бандл

- **Версия Python на ПК сборки и на целевом ПК должна совпадать по major.minor.** Бандл, собранный на Python 3.12, ставится только на 3.12. На 3.11 не встанет (разные ABI у скомпилированных пакетов). `wheels.zip` из GitHub Releases собран под Python 3.12.
- **Архитектура должна совпадать.** Windows x64 ↔ Windows x64 — норма. Mac/Linux → Windows — не подойдёт.
- **Бандл одноразовый.** Если в репозитории обновится `requirements.txt` — нужен новый бандл (либо обновлённый Release, либо пересборка через `make-offline-bundle.ps1`).
- **HuggingFace online-verification в коде сервера отключена** — `server.py` уже выставляет `HF_HUB_OFFLINE=1` и `TRANSFORMERS_OFFLINE=1` при запуске. Модель грузится строго из локальной папки, без попыток ходить в интернет.

---

# Справочник

## Автозапуск при включении ПК

Чтобы не запускать сервер вручную каждый раз — сделай автозапуск.

### Windows: через Task Scheduler

**Шаг 1.** Создай в папке `embedding-server` файл `run-embed-server.bat`:

```bat
@echo off
cd /d C:\Users\Lenovo\Desktop\GigaChat\embedding-server
call venv\Scripts\activate.bat
set EMBED_MODEL=C:\models\multilingual-e5-large
python server.py
```

Поправь два пути под себя:
- `cd /d ...` — путь к папке `embedding-server`
- `set EMBED_MODEL=...` — путь к папке модели

Запусти `.bat` вручную — должно открыться окно с логами сервера. Если так — переходи к следующему шагу.

**Шаг 2.** Открой **Планировщик заданий** (`taskschd.msc`):

- Справа: «Создать задачу...» (не «Создать простую задачу»).
- **Вкладка «Общие»**:
  - Имя: `GigaChat Embedding Server`
  - «Выполнять только для вошедших пользователей» (галочка)
- **Вкладка «Триггеры»** → «Создать...»:
  - «Начать задачу: При входе в систему» → ОК
- **Вкладка «Действия»** → «Создать...»:
  - «Запуск программы»
  - «Программа или сценарий»: укажи полный путь к `run-embed-server.bat`
  - ОК
- **Вкладка «Условия»**:
  - Сними галочку «Запускать только при питании от сети» (если ноутбук)
- **Вкладка «Параметры»**:
  - «Если задача уже выполняется: Не запускать новый экземпляр»
- ОК. Перезагрузи ПК — сервер должен подняться сам.

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
sudo systemctl status gigachat-embed
journalctl -u gigachat-embed -f
```

---

## Конфигурация (переменные окружения)

Сервер читает настройки из переменных окружения. Менять значения можно либо в `.bat`/`.service`-файле автозапуска, либо в текущей сессии PowerShell перед запуском.

| Переменная     | По умолчанию                          | Описание                                |
|----------------|---------------------------------------|-----------------------------------------|
| `EMBED_MODEL`  | `intfloat/multilingual-e5-large`      | HuggingFace id или путь к локальной папке |
| `EMBED_HOST`   | `0.0.0.0`                             | Интерфейс прослушивания (`0.0.0.0` = все) |
| `EMBED_PORT`   | `8001`                                | Порт                                    |
| `EMBED_DEVICE` | автоопределение                       | `cpu`, `cuda`, `mps` (Mac)              |

Пример: запустить только для localhost (закрыть от LAN), на порту 9000, форсированно на GPU:

```powershell
$env:EMBED_HOST = "127.0.0.1"
$env:EMBED_PORT = "9000"
$env:EMBED_DEVICE = "cuda"
$env:EMBED_MODEL = "C:\models\multilingual-e5-large"
python server.py
```

(В этом примере 4 переменные сетятся одной за одной как 4 отдельные команды, потом запуск сервера 5-й командой.)

---

## API сервера

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

## Решение частых проблем

### `Could not find a version that satisfies the requirement ...` при установке

На целевом ПК Python другой версии (не 3.12), и `wheels.zip` из Releases не подошёл. Соберите свой бандл — шаг 1.3 на ПК с такой же версией Python, что и на целевом.

### `ERROR: Could not open requirements file: ... 'requirements.txt'`

Файлы сервера не лежат в текущей папке. Типовой случай: создал пустую папку, в ней `python -m venv venv`, но не положил рядом `server.py` / `requirements.txt`. Проверь:

```powershell
dir
```

Должно показать как минимум `requirements.txt`, `server.py`, `install-offline.ps1`. Если их нет — распакуй `GigaChat-main.zip` в нужную папку.

### `OSError: ... is not a valid model identifier`

Модель в «голом» формате `transformers`, без файлов `sentence_bert_config.json` / `modules.json`. Открой `server.py`, найди строку:

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
    mask = batch['attention_mask'].unsqueeze(-1).float()
    emb = (out.last_hidden_state * mask).sum(1) / mask.sum(1)
    emb = F.normalize(emb, p=2, dim=1)
    return [v.tolist() for v in emb.cpu()]
```

### Грузится 10+ минут при первом запуске

Норма для первого запуска без GPU. Модель кэшируется в RAM, при повторных запросах работает быстро.

### `Out of memory` / процесс убит

Модель не помещается в RAM. Варианты:

**1. Использовать FP16** — в `server.py` найди:

```python
model = SentenceTransformer(MODEL_NAME, device=device)
```

И замени на:

```python
model = SentenceTransformer(MODEL_NAME, device=device, model_kwargs={'torch_dtype': torch.float16})
```

Сэкономит ~50% памяти. Качество страдает минимально.

**2. Взять меньшую модель** — `intfloat/multilingual-e5-base` (~1 GB, dim=768) или `e5-small` (~470 MB, dim=384). Если перейдёшь на base/small — поменяй `vector(1024)` на `vector(768)` или `vector(384)` в SQL.

### n8n не достучится: `ECONNREFUSED` или таймаут

Проверь по порядку:

**1. Сервер запущен?** Окно с `python server.py` открыто, в нём нет красных ошибок?

**2. Правильный URL в workflow?** Открой узел «Эмбеддинг» в n8n → поле URL должно содержать твой IP (или `localhost`), а не текст `EMBED_HOST`.

**3. Firewall блокирует?** На ПК с сервером в PowerShell от админа:

```powershell
New-NetFirewallRule -DisplayName "GigaChat Embed" -LocalPort 8001 -Protocol TCP -Action Allow -Direction Inbound
```

**4. n8n в Docker?** Используй `host.docker.internal` вместо IP хоста.

### Сервер запускается, но `/embed` возвращает 500

Открой окно сервера — внизу будет traceback. Самое частое: ошибка токенизации (текст слишком длинный). E5-large обрабатывает до 512 токенов. В `document-loader.json` нарезка идёт по 500 слов с перекрытием 50 — это норма, но иногда длинное слово может выйти за лимит. Решение — в `server.py`:

```python
vectors = model.encode(prepared, batch_size=8, normalize_embeddings=True, show_progress_bar=False, truncate_dim=None)
```

### Сервер периодически падает

Включи автоперезапуск через Task Scheduler («Если задача не выполнена: Перезапускать каждые 1 мин»). Для systemd это уже встроено через `Restart=on-failure`.

---

## Где это используется в проекте

| Файл                                  | Узел в n8n               | Что делает                                  |
|---------------------------------------|--------------------------|---------------------------------------------|
| `Workflow/document-loader.json`       | «Эмбеддинг»              | Векторизует куски текста при загрузке доков |
| `Workflow/rag-agent.json`             | «Эмбеддинг вопроса»      | Векторизует пользовательский вопрос         |

В таблице `documents` колонка `embedding VECTOR(1024)` — размерность совпадает с моделью E5-large. См. `PostgreSQL-Guide.md` раздел «Размерность вектора», если хочешь использовать другую модель.
