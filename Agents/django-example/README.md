# GigaChat — готовый Django app

Этот каталог — **готовый Django app** для подключения соседнего Python/Django
проекта к GigaChat. Скопируйте папку в свой Django-проект, добавьте 3 строки
конфига — получите рабочий API-endpoint `/giga/ask` для обращения к 6 агентам
GigaChat из любого места своего проекта.

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
    └── giga_client.py
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

Готово. Endpoint `POST /giga/ask` доступен.

## Что вы получаете

| URL | Что |
|---|---|
| `POST /giga/ask` | JSON API. Body: `{"message": "...", "agent": "chat\|rag\|sql\|math\|route\|prompt"}`. Ответ: `{"response": "..."}` (для math/route/prompt — расширенный JSON со специфичными полями). |
| `GET /giga/health` | Liveness-check. Возвращает `{"status":"ok","app":"giga","prefix":"..."}`. Дашборд GigaChat пингует этот URL и показывает админу «подключён ли ваш проект сейчас». |

## Добавление в дашборд GigaChat

После того как у вас запустится сервер, скажите админу GigaChat URL вашего
health endpoint — например `http://192.168.1.20/giga/health`. Админ
добавит ваш проект в реестр в дашборде, и вы появитесь в списке подключённых
со статусом онлайн/офлайн.

## Использование из своего HTML/JS

У вас уже есть свой UI чата — стучитесь в `/giga/ask` из вашего фронта:

```js
async function askGiga(message, agent = 'chat') {
  const res = await fetch("/giga/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCsrfToken()   // стандарт Django
    },
    body: JSON.stringify({ message, agent })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return data.response;   // для chat/rag/sql
  // для math/route/prompt — data содержит дополнительные поля
}

function getCsrfToken() {
  const m = document.cookie.match(/(^|;)\s*csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[2]) : '';
}
```

В вашем HTML-шаблоне должен быть `{% csrf_token %}` — Django генерит cookie.

## Использование из своих views (программно)

Если хотите дёргать GigaChat прямо из своих Django views:

```python
from giga.giga_client import GigaChatClient
from django.conf import settings

giga = GigaChatClient(
    base=settings.GIGACHAT_BASE,
    prefix=settings.GIGACHAT_PREFIX
)

def my_existing_view(request):
    answer = giga.chat_sync("Привет", user_id=str(request.user.id))
    # Доступны: chat_sync, rag_sync, sql_sync, math_sync, route_sync, prompt_sync
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
  при каждом POST из вашего JS. НЕ отключайте `@csrf_exempt` без
  необходимости.
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

## Проблемы

**`ModuleNotFoundError: No module named 'giga'`**
→ папка `giga` не на уровне `manage.py`, или нет `__init__.py`.

**`403 Forbidden` при POST `/giga/ask`**
→ забыт CSRF-токен. Проверьте что в HTML-шаблоне есть `{% csrf_token %}`
и JS отправляет `X-CSRFToken` заголовок (см. пример выше).

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
