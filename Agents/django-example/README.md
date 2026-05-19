# Подключение Django-проекта к GigaChat

Эта инструкция для разработчика соседнего офисного Django-проекта.
После выполнения 3 шагов ваше приложение сможет дёргать 5 AI-агентов GigaChat
(чат, поиск по документам, SQL, математика, prompt-engineer) из своего фронта
одной fetch-функцией.

Работает на Django **3.x / 4.x / 5.x**. Без async, без правок ASGI, без CORS.

> ⚠️ **Auto-routing (router) НЕ доступен через API.** Реальная маршрутизация
> живёт только в Web UI (`router.html` — классифицирует сообщение и сам
> выбирает webhook). Из Django вызывай конкретного агента напрямую.
>
> ⚠️ **Math возвращает только сгенерированный код**, не готовое число.
> Готовый ответ собирается только в Web UI через Pyodide + второй webhook
> `/math-explain`. Из Django либо исполняй код сам (subprocess — security!),
> либо используй math только в Web UI. См. секцию [Math](#math--особый-случай).

---

## Быстрый старт (30 секунд)

```
1. cp -r django-example /path/to/your-project/giga
2. pip install httpx
3. settings.py: INSTALLED_APPS = [..., 'giga']
                GIGACHAT_BASE = "http://192.168.1.10:5678"
                GIGACHAT_PREFIX = "myproject"
   urls.py:     path('giga/', include('giga.urls'))
```

Из вашего HTML:
```js
fetch('/giga/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrf() },
  body: JSON.stringify({ message: 'Привет, кто ты?', agent: 'chat' })
}).then(r => r.json()).then(data => console.log(data.response));
```

Готово. Дальше — детали.

---

## Установка — 3 шага

### Шаг 1. Скопировать папку в свой проект

```bash
cp -r django-example /path/to/your-django-project/giga
```

Должно получиться:

```
your-django-project/
├── manage.py
├── myproject/
│   ├── settings.py
│   └── urls.py
└── giga/                       ← вот эта папка
    ├── __init__.py
    ├── apps.py
    ├── views.py
    ├── urls.py
    └── giga_client.py
```

### Шаг 2. Установить httpx

```bash
pip install httpx
```

Если используете `requirements.txt` — добавьте `httpx>=0.27`.

### Шаг 3. Конфигурация Django

**`myproject/settings.py`** (3 строки конфига и регистрация app):

```python
INSTALLED_APPS = [
    # ... ваши apps ...
    'giga',
]

# URL вашего GigaChat-сервера в локальной сети
GIGACHAT_BASE = "http://192.168.1.10:5678"   # ← узнайте у админа GigaChat
GIGACHAT_PREFIX = "myproject"                # ← уникальный префикс вашего проекта
GIGACHAT_TIMEOUT = 120                       # секунд, не меньше 60
```

**`myproject/urls.py`** (одна строка):

```python
from django.urls import path, include

urlpatterns = [
    # ... ваши маршруты ...
    path('giga/', include('giga.urls')),
]
```

**Готово.** Перезапустите Django — два endpoint'а ниже доступны.

---

## Что вы получили

| URL | Метод | Зачем |
|---|---|---|
| `/giga/ask` | POST | Спросить агента GigaChat. Body: `{message, agent}` → ответ JSON. |
| `/giga/health` | GET | Проверка «живо ли подключение». Дашборд GigaChat это пингует. |

---

## Использование из вашего фронта

### Базовый шаблон

```html
<!-- В любом вашем Django-шаблоне -->
{% csrf_token %}

<button onclick="askGiga()">Спросить</button>
<div id="answer"></div>

<script>
async function askGiga() {
  const res = await fetch('/giga/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCsrfToken()
    },
    body: JSON.stringify({
      message: 'Расскажи о возможностях Python',
      agent: 'chat'
    })
  });
  const data = await res.json();
  document.getElementById('answer').textContent = data.response;
}

function getCsrfToken() {
  const m = document.cookie.match(/(^|;)\s*csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[2]) : '';
}
</script>
```

### Какой `agent` для какой задачи

| `agent` | Когда использовать | Пример вопроса |
|---|---|---|
| `chat` | Универсальный диалог, общие вопросы | «Расскажи про Python», «Привет» |
| `rag` | Поиск ответов в загруженных документах | «Найди в инструкции раздел про отпуск» |
| `sql` | Запросы к базе данных естественным языком | «Сколько клиентов из Москвы за месяц?» |
| `math` | Генерация Python-кода для задачи (см. ниже!) | «Корень из 2», «Решить x² + 5x + 6 = 0» |
| `prompt` | Генерация и улучшение промптов для LLM | «Напиши промпт для классификатора email» |

### Что возвращается

**Для `chat`, `rag`, `sql`:**
```json
{ "response": "Ответ агента строкой" }
```

**Для `math`** (см. секцию ниже):
```json
{
  "response": "",
  "code": "import math\\nresult = math.sqrt(2)\\nprint(f\\"ОТВЕТ: {result}\\")",
  "raw_result": "",
  "stage": "execute"
}
```

**Для `prompt`:**
```json
{ "response": "Объяснение", "prompt": "Готовый промпт" }
```

### Math — особый случай

После перевода math-агента на двухфазную архитектуру (Pyodide в браузере),
endpoint `/webhook/math` теперь **возвращает только сгенерированный код**
для задачи, не готовое число. Поле `response` пустое.

Полная цепочка решения (LLM → код → исполнение → пояснение) собирается
**только в GigaChat Web UI**: фронт получает код, запускает в Pyodide
(Python-в-браузере через WebAssembly), извлекает результат, отправляет
на второй webhook `/math-explain` для LLM-пояснения.

**Варианты для Django-проекта:**

1. **Не использовать math из API** — самое безопасное. Если пользователю
   нужна математика — дай ссылку на Web UI GigaChat.

2. **Показать код пользователю как есть** — пусть копирует и запускает
   у себя где удобно. Подойдёт если ваши пользователи — программисты.

3. **Исполнять код на сервере** (subprocess) — БЕЗ sandbox это серьёзная
   дыра безопасности (LLM может написать `os.system('rm -rf /')`).
   Минимум — Docker-контейнер с `--network none`, read-only `/`,
   ограничением CPU/RAM. Для прод-сценария обязательно review.

4. **Сделать свой исполнитель в браузере** — портировать наш
   `Agents/lib/pyodide-client.js` + `math-pyodide-worker.js` в свой
   фронт. Это работает, но требует HTTP-origin (см. файл `DEPLOY.md`
   в корне проекта).

### Auto-routing — почему не доступен

Endpoint `/webhook/router` в n8n — это **только пинг-стаб** (возвращает
`{response: 'pong'}` на любой POST). Реальная маршрутизация запроса к
нужному агенту живёт в `router.html` на фронте: классификатор смотрит
ключевые слова, выбирает агента, и сам вызывает соответствующий webhook.

Из Django это нельзя переиспользовать без портирования логики классификатора.
Если очень нужно — посмотри `router.html` файл проекта, скопируй массив
ключевых слов из его `classifyAgent()` функции, реализуй ту же логику в
Python — это ~50 строк.

Проще: всегда вызывай конкретного агента (`chat` как fallback по умолчанию).

### Вызов из своего Django view (программно)

```python
from giga.giga_client import GigaChatClient
from django.conf import settings

giga = GigaChatClient(
    base=settings.GIGACHAT_BASE,
    prefix=settings.GIGACHAT_PREFIX,
)

def my_existing_view(request):
    answer = giga.chat_sync("Расскажи про нейросети", user_id=str(request.user.id))
    return JsonResponse({"answer": answer})
```

Методы клиента: `chat_sync`, `rag_sync`, `sql_sync`, `math_sync`, `prompt_sync`.

`route_sync` отсутствует намеренно — см. секцию [Auto-routing](#auto-routing--почему-не-доступен).

---

## Чеклист «как понять что подключение работает»

1. **Django запускается без ошибок?**
   ```bash
   python manage.py runserver
   ```
   Если падает на `from giga.giga_client import ...` — папка `giga` не на одном уровне с `manage.py` или нет `__init__.py`.

2. **Health endpoint живой?**
   В браузере открыть: `http://localhost:8000/giga/health`
   Должно вернуть JSON:
   ```json
   { "status": "ok", "app": "giga", "prefix": "myproject" }
   ```

3. **Запрос проходит?**
   В консоли браузера (F12) на любой странице вашего сайта:
   ```js
   fetch('/giga/ask', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'X-CSRFToken': document.cookie.match(/csrftoken=([^;]+)/)[1]
     },
     body: JSON.stringify({ message: 'тест', agent: 'chat' })
   }).then(r => r.json()).then(console.log);
   ```
   Через 1-5 секунд в консоли должен появиться JSON с ответом.

4. **Дашборд GigaChat видит вас?**
   Скажите админу GigaChat URL вашего health: `http://<ваш-сервер>/giga/health`
   Админ откроет дашборд → «Шлюз API» → добавит ваш проект → увидит «онлайн».

---

## Где взять `GIGACHAT_BASE`

- **Спросить у админа GigaChat** (рекомендуемый способ)
- Или открыть **дашборд GigaChat** → кнопка «Шлюз API» вверху страницы → URL шлюза показан вверху окна.

---

## Изоляция сессий — важно

Каждый ваш запрос автоматически получает `session_id` вида:
```
{GIGACHAT_PREFIX}_{agent}_{user_id}
```

Например: `myproject_chat_42`. Это нужно чтобы:
- Сессии вашего проекта **не пересекались** с сессиями GigaChat HTML и других проектов
- У каждого вашего пользователя была **своя память** в чате

**`GIGACHAT_PREFIX` в settings.py должен быть уникальным** для вашего проекта. Согласуйте с админом GigaChat.

`user_id` берётся из:
- `request.user.pk` если пользователь залогинен
- `anon_<session_key>` если аноним (у каждого анонима свой ID)

Можете переопределить логику в `views.py` функция `_user_id()`.

---

## Безопасность

### CSRF — Django стандарт

`/giga/ask` защищён CSRF. Из вашего JS нужно передавать токен:
```js
headers: { 'X-CSRFToken': csrftoken }
```

В HTML-шаблоне должен быть `{% csrf_token %}` — он создаёт cookie.

**НЕ ОТКЛЮЧАЙТЕ** `@csrf_exempt` без понимания последствий.

### Только для залогиненных

Если хотите ограничить — добавьте `@login_required` в `views.py`:
```python
from django.contrib.auth.decorators import login_required

@login_required
@require_POST
def ai_ask(request):
    ...
```

### Защита от спама

Если возможны зацикленные запросы — установите `django-ratelimit`:
```bash
pip install django-ratelimit
```
```python
from django_ratelimit.decorators import ratelimit

@ratelimit(key='user', rate='30/m', block=True)
@require_POST
def ai_ask(request):
    ...
```

---

## Решение проблем

### `ModuleNotFoundError: No module named 'giga'`
Папка `giga` не на уровне с `manage.py`, или внутри нет `__init__.py`.

### `403 Forbidden` при POST `/giga/ask`
Забыт CSRF-токен. В HTML должен быть `{% csrf_token %}`, в JS — заголовок `X-CSRFToken`.

### `504 Gateway не ответил вовремя`
Либо GigaChat-сервер недоступен по сети, либо запрос дольше 120 сек.
Проверьте `GIGACHAT_BASE` в settings. Откройте URL вручную в браузере — он должен отвечать (хотя бы 404).

### `502 GigaChat вернул XXX`
Webhook на стороне GigaChat вернул ошибку. Откройте дашборд GigaChat,
проверьте что нужный агент (chat/rag/sql/...) работает напрямую в HTML.
Если работает там, но не у вас — проблема в payload вашего запроса.

### Пустой `response` в ответе
Сервер вернул JSON без поля `response` — значит agent кинул ошибку.
Посмотрите логи на стороне GigaChat в n8n.

### Ответ приходит, но в HTML не отображается
Проверьте что вы парсите JSON: `await res.json()`, а не `res.text()`.

---

## Что НЕ нужно делать

- Не дёргайте webhook'и GigaChat **напрямую** из вашего HTML — теряете CSRF, авторизацию, можете утечь URL n8n
- Не используйте `@csrf_exempt`
- Не хардкодьте `GIGACHAT_BASE` в коде — выносите в settings/env
- Не используйте один `GIGACHAT_PREFIX` в разных проектах — сессии смешаются

---

# Асинхронный шлюз `django-gateway` — альтернативный паттерн

Раздел выше описывает **синхронный** клиент (`giga_client.py`) — он делает HTTP-запрос к агенту и **ждёт ответа** (до 120 сек пока LLM думает). Удобно для UI, но Django-worker занят всё время ожидания.

В n8n также есть **асинхронный шлюз** (`Workflow/django-gateway.json`) — он работает по callback-паттерну: Django отправляет запрос → n8n сразу возвращает `200 OK` → когда LLM ответит, n8n сам шлёт **второй HTTP-запрос** на ваш Django с результатом.

## Когда какой использовать

| Сценарий | Что выбрать |
|---|---|
| Простой UI: «кнопка → ответ в textarea через секунду» | **Синхронный** (`/giga/ask` из giga_client) |
| Очередь задач: пользователь нажал кнопку → закрыл вкладку → результат должен прийти на email/в БД | **Асинхронный** (`from_django_to_n8n` + callback) |
| Параллельно обрабатывать 50 запросов в секунду | **Асинхронный** (worker не висит на ожидании) |
| LLM может думать >2 минут (длинный RAG, тяжёлая SQL-выборка) | **Асинхронный** (Django timeout не убьёт запрос) |

## Архитектура асинхронного шлюза

```
┌────────────────────────────────────────────────────────────────────┐
│  Ваш Django                                                        │
│                                                                    │
│  1. user clicks → views.py:                                        │
│       POST n8n/webhook/from_django_to_n8n                          │
│       body: {"message": "...", "agent": "chat"}                    │
│                                                                    │
│  2. n8n возвращает 200 СРАЗУ:                                      │
│       {"ok": true, "accepted": true, "session_id": "django_..."}   │
│                                                                    │
│  3. Django сохраняет в БД: request_id, session_id, status='wait'   │
│     возвращает пользователю «принято в обработку»                  │
│                                                                    │
│  ...через ~10-60 сек...                                            │
│                                                                    │
│  4. n8n стучится на ваш endpoint:                                  │
│       POST your-django.local/from_n8n_to_django                    │
│       body: {ok, agent, message, session_id, response, error, ts}  │
│                                                                    │
│  5. Django views.py:                                               │
│       находит запись по session_id, обновляет status='done',       │
│       сохраняет response в БД, шлёт push/email пользователю        │
└────────────────────────────────────────────────────────────────────┘
```

## Шаг 1. Endpoint для приёма запросов

n8n уже слушает `POST http://<GIGACHAT_BASE>/webhook/from_django_to_n8n`. Ничего на стороне n8n настраивать не нужно — workflow `Django Gateway` импортируется одной командой админом GigaChat.

## Шаг 2. Endpoint для приёма callback в Django

Создайте view, который n8n будет дёргать с результатом. Минимальный пример:

**`giga/views.py`** (добавить рядом с существующими):

```python
import json
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from django.http import JsonResponse
from .models import GigaAsyncRequest  # ← ваша модель, см. ниже


@csrf_exempt   # n8n не знает про Django CSRF — отключаем для этого endpoint'а
@require_POST
def from_n8n_callback(request):
    """
    Приёмник callback'ов от n8n django-gateway.
    URL: /from_n8n_to_django (зашит в workflow)
    Body: {ok, agent, message, session_id, response, error, timestamp}
    """
    try:
        data = json.loads(request.body.decode('utf-8'))
    except json.JSONDecodeError:
        return JsonResponse({'ok': False, 'error': 'Invalid JSON'}, status=400)

    session_id = data.get('session_id')
    if not session_id:
        return JsonResponse({'ok': False, 'error': 'session_id required'}, status=400)

    # Защита: принимать только запросы с IP n8n. Подставьте свой.
    # Если за прокси — используйте X-Forwarded-For с настройкой.
    allowed_ips = {'192.168.1.10', '127.0.0.1'}
    client_ip = request.META.get('REMOTE_ADDR')
    if client_ip not in allowed_ips:
        return JsonResponse({'ok': False, 'error': 'Forbidden'}, status=403)

    # Находим исходный запрос по session_id и обновляем
    try:
        req = GigaAsyncRequest.objects.get(session_id=session_id)
    except GigaAsyncRequest.DoesNotExist:
        # Это нормальный сценарий если запрос удалили или callback с задержкой
        return JsonResponse({'ok': True, 'note': 'request not found'}, status=200)

    req.status = 'done' if data.get('ok') else 'error'
    req.response_text = data.get('response') or ''
    req.error_text = data.get('error') or ''
    req.completed_at = data.get('timestamp')
    req.save(update_fields=['status', 'response_text', 'error_text', 'completed_at'])

    # TODO: уведомить пользователя — email, push, WebSocket, polling таблицы
    # notify_user(req.user_id, req.response_text)

    return JsonResponse({'ok': True})
```

**`giga/models.py`** (минимальная схема для отслеживания запросов):

```python
from django.db import models

class GigaAsyncRequest(models.Model):
    session_id     = models.CharField(max_length=64, unique=True)
    user_id        = models.IntegerField()   # для уведомлений
    agent          = models.CharField(max_length=32)
    message        = models.TextField()
    status         = models.CharField(max_length=16, default='wait')  # wait/done/error
    response_text  = models.TextField(blank=True, default='')
    error_text     = models.TextField(blank=True, default='')
    created_at     = models.DateTimeField(auto_now_add=True)
    completed_at   = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=['user_id', 'status'])]
```

**`giga/urls.py`** — добавить маршрут:

```python
from django.urls import path
from . import views

urlpatterns = [
    path('ask', views.ai_ask, name='giga_ask'),
    path('health', views.health, name='giga_health'),
    path('from_n8n_to_django', views.from_n8n_callback, name='giga_callback'),
]
```

Тогда полный URL callback'а будет `http://<ваш-django>/giga/from_n8n_to_django`.

## Шаг 3. View для отправки запросов

```python
import httpx
import uuid
from django.conf import settings
from .models import GigaAsyncRequest


@require_POST
def ai_ask_async(request):
    """
    Принимает {message, agent} от пользователя, ставит в очередь, возвращает
    request_id. Реальный ответ придёт callback'ом на /from_n8n_to_django.
    """
    data = json.loads(request.body.decode('utf-8'))
    message = data.get('message', '').strip()
    agent = data.get('agent', 'chat')

    if not message:
        return JsonResponse({'ok': False, 'error': 'message required'}, status=400)

    # session_id — Django сам формирует, чтобы знать как привязать callback
    session_id = f"{settings.GIGACHAT_PREFIX}_{agent}_{uuid.uuid4().hex[:12]}"

    # Сохраняем запрос в БД (status='wait')
    req = GigaAsyncRequest.objects.create(
        session_id=session_id,
        user_id=request.user.pk if request.user.is_authenticated else 0,
        agent=agent,
        message=message,
    )

    # Шлём в n8n. ВАЖНО: ждём только подтверждение приёма (200 OK), не сам ответ.
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(
                f"{settings.GIGACHAT_BASE}/webhook/from_django_to_n8n",
                json={
                    'message': message,
                    'agent': agent,
                    'session_id': session_id,   # передаём свой, чтобы n8n его использовала
                },
            )
        if r.status_code != 200:
            req.status = 'error'
            req.error_text = f'n8n returned {r.status_code}'
            req.save()
            return JsonResponse({'ok': False, 'error': req.error_text}, status=502)
    except httpx.RequestError as e:
        req.status = 'error'
        req.error_text = str(e)
        req.save()
        return JsonResponse({'ok': False, 'error': str(e)}, status=502)

    return JsonResponse({'ok': True, 'session_id': session_id, 'status': 'wait'})
```

## Формат запроса (Django → n8n)

```http
POST http://<GIGACHAT_BASE>/webhook/from_django_to_n8n
Content-Type: application/json

{
  "message": "Привет, как дела?",
  "agent": "chat",
  "session_id": "myproject_chat_a1b2c3d4e5f6"
}
```

Поля:

| Поле | Обязательное | Описание |
|---|---|---|
| `message` | да | Текст вопроса/задачи, max 100 000 символов |
| `agent` | нет | Default `chat`. Whitelist: `chat`, `math`, `rag`, `sql`, `router`, `prompt-engineer` |
| `session_id` | нет | Если передаёте — n8n использует. Если нет — n8n генерирует `django_<ts>_<rand>` |

## Формат ответа (n8n → Django, СРАЗУ)

```json
{
  "ok": true,
  "accepted": true,
  "session_id": "myproject_chat_a1b2c3d4e5f6",
  "agent": "chat"
}
```

Этот ответ приходит за миллисекунды — после валидации, ДО вызова LLM. Подтверждает что запрос принят в обработку.

## Формат callback (n8n → Django, ПОТОМ)

```http
POST http://<ваш-django>/giga/from_n8n_to_django
Content-Type: application/json; charset=utf-8

{
  "ok": true,
  "agent": "chat",
  "message": "Привет, как дела?",
  "session_id": "myproject_chat_a1b2c3d4e5f6",
  "response": "Готов помогать. Чем могу быть полезен?",
  "error": null,
  "timestamp": "2026-05-19T15:30:00.000Z"
}
```

При ошибке агента:

```json
{
  "ok": false,
  "agent": "chat",
  "message": "...",
  "session_id": "...",
  "response": "",
  "error": "Описание ошибки",
  "timestamp": "..."
}
```

## Как пользователь получает ответ

После того как callback пришёл и status='done' в БД, есть три способа уведомить пользователя:

| Способ | Сложность | Когда подходит |
|---|---|---|
| **Polling** — фронт каждые 2 сек делает GET `/giga/status?session_id=...` | Низкая | Простой UI, пользователь сидит на странице |
| **WebSocket** (django-channels) | Средняя | Многопользовательский real-time UI |
| **Email / push / Telegram** | Низкая | Долгие задачи (>5 мин), пользователь может уйти |
| **Server-Sent Events** (EventSource) | Низкая | Альтернатива polling, более эффективно |

Минимальный polling endpoint:

```python
@require_GET
def ai_status(request):
    session_id = request.GET.get('session_id')
    try:
        req = GigaAsyncRequest.objects.get(
            session_id=session_id,
            user_id=request.user.pk,   # пользователь видит только свои запросы
        )
        return JsonResponse({
            'status': req.status,
            'response': req.response_text if req.status == 'done' else '',
            'error': req.error_text if req.status == 'error' else '',
        })
    except GigaAsyncRequest.DoesNotExist:
        return JsonResponse({'status': 'not_found'}, status=404)
```

И на фронте:

```js
async function pollUntilDone(sessionId) {
  for (let i = 0; i < 60; i++) {  // максимум 60 попыток по 2 сек = 2 минуты
    const r = await fetch('/giga/status?session_id=' + encodeURIComponent(sessionId));
    const data = await r.json();
    if (data.status === 'done') return data.response;
    if (data.status === 'error') throw new Error(data.error);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout');
}
```

## Настройка URL Django в workflow

**ВАЖНО**: в `Workflow/django-gateway.json` есть нода **«Callback в Django»** с URL:

```
http://<DJANGO_HOST>/from_n8n_to_django
```

Это плейсхолдер. После импорта в n8n админ GigaChat должен открыть workflow → нода «Callback в Django» → заменить `<DJANGO_HOST>` на адрес вашего Django:

```
http://192.168.1.20/giga/from_n8n_to_django
```

Сообщите ваш URL админу GigaChat.

## Безопасность

| Угроза | Защита |
|---|---|
| Любой в LAN дёрнет ваш `/from_n8n_to_django` с фейковым ответом | IP whitelist (`allowed_ips` в callback view) — принимать только с IP n8n |
| Подмена session_id для чужого пользователя | Привязка `user_id` в БД при создании запроса. В status-endpoint проверяем что request.user.pk совпадает |
| DDoS через массовые запросы в gateway | django-ratelimit на `ai_ask_async`, как в синхронной версии |
| Утечка чужих ответов через callback | n8n знает только session_id, который вы сами генерируете и не светите наружу |

## Тестирование (без UI)

```bash
# 1. Сделать «отправить запрос»
curl -X POST http://your-django.local/giga/ask-async \
  -H 'Content-Type: application/json' \
  -H 'X-CSRFToken: <token>' \
  -d '{"message":"тест","agent":"chat"}'
# → {"ok":true,"session_id":"...","status":"wait"}

# 2. Подождать 10 секунд

# 3. Проверить статус
curl 'http://your-django.local/giga/status?session_id=...'
# → {"status":"done","response":"..."}
```

Или напрямую к n8n (без Django, для отладки самого gateway):

```bash
curl -X POST http://<GIGACHAT_BASE>/webhook/from_django_to_n8n \
  -H 'Content-Type: application/json' \
  -d '{"message":"тест","agent":"chat","session_id":"debug_test_001"}'
# → {"ok":true,"accepted":true,"session_id":"debug_test_001","agent":"chat"}

# Через 10-30 сек n8n должна постучаться в ваш callback endpoint
# (если URL подставлен в workflow).
```

## Решение проблем (асинхронный режим)

### Запрос «вечно в статусе wait»

n8n не достучалась до вашего Django callback. Возможные причины:

1. **`<DJANGO_HOST>` не подставлен** в workflow — открой n8n → workflow Django Gateway → нода «Callback в Django» → проверь URL.
2. **Django недоступен по сети** с машины n8n — на n8n-сервере: `curl http://<ваш-django>/giga/from_n8n_to_django` (должен вернуть 405 Method Not Allowed для GET — это значит endpoint жив).
3. **Firewall** на Django-сервере — открыть порт 80/8000 для входящих с IP n8n.
4. **Callback view упал** — проверь логи Django, скорее всего модель не мигрирована или CSRF не отключён.

### Все callback приходят с `ok: false`

Workflow Django Gateway вызывает агента, но агент возвращает ошибку. Проверь:

1. Указанный `agent` существует и активен в n8n (Settings → Workflows → должен быть зелёный тумблер).
2. На стороне n8n в Executions посмотри последний запуск Django Gateway — увидишь конкретную ошибку в шаге «Вызов агента».

### Callback приходит, но Django возвращает 403

Скорее всего IP whitelist в `from_n8n_callback` не пускает. Проверь `request.META.get('REMOTE_ADDR')` — может за прокси, надо использовать `HTTP_X_FORWARDED_FOR`.

### `session_id` сгенерирован дважды для одного запроса

Если вы НЕ передаёте `session_id` в запросе к n8n — он генерирует свой. А в БД у вас может быть другой. Решение: **всегда генерируйте session_id на стороне Django** и передавайте в запросе (как в примере `ai_ask_async` выше). Тогда обе стороны знают один и тот же ID.

### Очень много запросов в статусе `wait` накапливаются

n8n может отвалиться или не успевать. Сделайте management-команду которая чистит старые `wait`-записи:

```python
# giga/management/commands/cleanup_giga.py
from django.core.management.base import BaseCommand
from django.utils import timezone
from datetime import timedelta
from giga.models import GigaAsyncRequest

class Command(BaseCommand):
    def handle(self, *args, **opts):
        cutoff = timezone.now() - timedelta(minutes=5)
        n = GigaAsyncRequest.objects.filter(
            status='wait', created_at__lt=cutoff,
        ).update(status='error', error_text='Timeout: callback не пришёл за 5 мин')
        self.stdout.write(f'Cleaned {n} stale wait-requests')
```

Запускайте кроном раз в минуту: `* * * * * cd /path && python manage.py cleanup_giga`.

## Краткий чеклист «подключение асинхронного шлюза»

- [ ] Админ GigaChat импортировал `Workflow/django-gateway.json` и активировал
- [ ] Админ GigaChat подставил ваш URL Django в ноду «Callback в Django»
- [ ] Вы добавили модель `GigaAsyncRequest` + миграция
- [ ] Вы добавили views `ai_ask_async`, `from_n8n_callback`, `ai_status`
- [ ] Вы добавили URL `/giga/from_n8n_to_django` в `giga/urls.py`
- [ ] Вы открыли порт Django для входящих с IP n8n (firewall)
- [ ] Тест curl'ом прошёл (см. выше), callback пришёл в БД
