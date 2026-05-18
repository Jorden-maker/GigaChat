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
