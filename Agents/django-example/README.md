# GigaChat — готовый Django app

Этот каталог — **готовый Django app** для подключения соседнего проекта
к GigaChat. Скопируйте папку в свой Django-проект и сделайте 3 правки —
получите рабочий чат-виджет и API-endpoint.

Работает на любой версии Django 3.x / 4.x / 5.x. Sync-only — без async,
никаких настроек ASGI.

## Установка — 3 шага

### Шаг 1: скопировать папку

```bash
cp -r django-example /path/to/your-django-project/giga
```

Структура которая должна получиться:
```
your-django-project/
├── manage.py
├── myproject/
│   ├── settings.py
│   └── urls.py
└── giga/                       ← эта папка
    ├── __init__.py
    ├── apps.py
    ├── views.py
    ├── urls.py
    ├── giga_client.py
    └── templates/giga/chat.html
```

### Шаг 2: установить зависимость

```bash
pip install httpx
```

### Шаг 3: подключить в `settings.py` и корневой `urls.py`

**`myproject/settings.py`:**
```python
INSTALLED_APPS = [
    # ... ваше ...
    'giga',
]

# URL вашего GigaChat-сервера (узнайте у админа)
GIGACHAT_BASE = "http://192.168.1.10:5678"
GIGACHAT_PREFIX = "myproject"   # ваш префикс — изоляция сессий
GIGACHAT_TIMEOUT = 120
```

**`myproject/urls.py`:**
```python
from django.urls import path, include

urlpatterns = [
    # ... ваше ...
    path('giga/', include('giga.urls')),
]
```

Готово. Откройте `http://localhost:8000/giga/chat` — увидите рабочий чат.

## Что вы получаете

| URL | Что |
|---|---|
| `GET /giga/chat` | Демо-страница виджета чата. Можно встроить в iframe или взять `templates/giga/chat.html` как пример. |
| `POST /giga/ask` | JSON API. Body: `{"message": "...", "agent": "chat\|rag\|sql\|math\|route\|prompt"}`. Ответ: `{"response": "..."}` (для math/route/prompt — расширенный JSON). |

## Использование из своего кода

### Через готовые views (просто)

Подключили urls — пользуйтесь через `/giga/ask` из любой страницы:

```js
fetch("/giga/ask", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-CSRFToken": getCsrfToken()   // стандарт Django
  },
  body: JSON.stringify({ message: "Привет", agent: "chat" })
}).then(r => r.json()).then(data => console.log(data.response));
```

### Из своих views (программно)

```python
from giga.giga_client import GigaChatClient

giga = GigaChatClient(base="http://192.168.1.10:5678", prefix="myproject")

def my_view(request):
    answer = giga.chat_sync("Привет", user_id=str(request.user.id))
    return JsonResponse({"answer": answer})
```

## Изоляция сессий

`session_id` в GigaChat собирается автоматически как:
```
{prefix}_{agent}_{user_id}
```

Например `myproject_chat_42`. Чужие проекты с другим префиксом
не пересекаются с вашими.

User ID берётся:
- Залогиненный → `request.user.pk`
- Аноним → `anon_<session_key первые 12 символов>`

Можете переопределить логику в `views.py:_user_id()` — например,
использовать username вместо ID.

## Безопасность

- **CSRF** — используется стандарт Django через cookie + `X-CSRFToken`
  (см. `chat.html`). НЕ отключайте `@csrf_exempt` без необходимости.
- **Авторизация** — если хотите ограничить только залогиненным,
  добавьте `@login_required` в `views.py`:
  ```python
  from django.contrib.auth.decorators import login_required

  @login_required
  @require_POST
  def ai_ask(request):
      ...
  ```
- **Rate limit** — на больших нагрузках рекомендую `django-ratelimit`:
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

## Логирование

В `views.py` уже встроено через стандартный `logging`:

```python
log = logging.getLogger("giga")
log.info("giga.chat user=42 ms=1234")
```

Чтобы увидеть логи — добавьте в `settings.py`:
```python
LOGGING = {
    'version': 1,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'loggers': {
        'giga': {'handlers': ['console'], 'level': 'INFO'},
    },
}
```

## Темплейт виджета

`templates/giga/chat.html` — самодостаточная HTML-страница со стилями
и JS. Не зависит ни от чего, кроме CSRF-куки Django.

Можете:
- **Открыть как есть** на `/giga/chat`.
- **Встроить через iframe** в свою страницу.
- **Скопировать стили и логику** в свой шаблон.
- **Изменить цвета** — есть `:root` переменные сверху.

## Проблемы

**`ModuleNotFoundError: No module named 'giga'`**
→ папка `giga` не на уровне `manage.py`, или нет `__init__.py`.

**`403 Forbidden` при POST `/giga/ask`**
→ забыт CSRF-токен. Проверьте что в HTML есть `{% csrf_token %}`
и JS отправляет `X-CSRFToken`.

**`504 GigaChat не ответил вовремя`**
→ либо GigaChat-сервер недоступен по сети, либо ответ дольше 120 сек.
Проверьте `GIGACHAT_BASE` в `settings.py`, увеличьте `GIGACHAT_TIMEOUT`.

**`502 GigaChat вернул XXX`**
→ webhook на стороне GigaChat выдал ошибку. Откройте дашборд
GigaChat → кнопка «Шлюз API» → вкладка «Тест», попробуйте тот же
запрос. Если падает — баг в n8n workflow.

## Что НЕ делать

- Не использовать `@csrf_exempt` если не понимаете последствий
  (открывается риск CSRF-атак).
- Не хардкодить `GIGACHAT_BASE` в коде — выносить в settings/env.
- Не использовать одинаковые `prefix` в нескольких проектах — сессии
  смешаются.
