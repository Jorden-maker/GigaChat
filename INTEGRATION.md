# Подключение внешних проектов к GigaChat

Документ для разработчиков соседних офисных проектов, которым нужно
использовать AI-агентов GigaChat (чат, RAG, SQL, Math, Router, Prompt-engineer)
из своего приложения.

## Что вы получаете

Шлюз GigaChat — это набор HTTP-endpoint'ов на n8n, через которые любой
проект в локальной сети офиса может обращаться к 6 агентам:

| Endpoint | Что делает |
|---|---|
| `POST /webhook/router` | Авто-выбор агента по тексту вопроса |
| `POST /webhook/chat-agent` | Универсальный чат-агент с памятью |
| `POST /webhook/rag-agent` | Поиск ответов в загруженной базе документов |
| `POST /webhook/sql-agent` | Запросы к БД на естественном языке |
| `POST /webhook/math-agent` | Математические вычисления через Python |
| `POST /webhook/prompt-engineer` | Генерация и улучшение промптов |
| `POST /webhook/history` | История чата по `session_id` |

Базовый URL шлюза: `http://<gigachat-server>:5678` (зависит от офиса,
уточняется у админа).

## Архитектура

```
[Ваш HTML]
     ↓ fetch /ai/chat
[Ваш Python-сервер]      ← добавляете один endpoint-прокси
     ↓ httpx POST
[GigaChat n8n :5678]     ← здесь живёт логика всех 6 агентов
     ↓
[Postgres, Embedding, OCR]
```

Соседнему проекту **не нужно** напрямую обращаться в n8n из браузера —
лучше делать через свой backend. Это даёт:
- авторизацию (ваш бэк проверяет кто пользователь),
- логирование (видно кто что спрашивал),
- защиту URL n8n (не светим в HTML).

## Формат запроса/ответа

Все агенты работают по одинаковой схеме:

**Запрос:**
```http
POST <base>/webhook/<agent>
Content-Type: application/json

{
  "message": "Текст вопроса",
  "session_id": "myproject_chat_user42"
}
```

**Ответ:**
```json
{ "response": "Ответ агента" }
```

Math/Router/Prompt-engineer возвращают дополнительные поля:
- `math` → `{ response, code, raw_result }`
- `router` → `{ response, agent }`
- `prompt-engineer` → `{ response, prompt }`

## ВАЖНО: изоляция сессий через `session_id`

`session_id` определяет «диалог» — историю запоминания агента и сжатое
резюме. **Всегда добавляйте префикс своего проекта**, иначе сессии
вашего приложения смешаются с сессиями GigaChat HTML и других проектов.

**Хорошо:**
```
myproject_chat_user42
sales_dashboard_rag_alice
hr_assistant_router_bob
```

**Плохо:**
```
chat_1747234567_abc123   ← такой формат у GigaChat HTML, не использовать
12345                    ← без префикса проекта, риск коллизии
```

Рекомендуемый формат: `{ваш_проект}_{короткое_имя_агента}_{id_пользователя}`.

## Способ 0: для Django-проектов — готовый app (самый быстрый)

Если ваш проект на Django — есть готовая папка `Agents/django-example/`,
её достаточно скопировать и подключить как обычное Django-приложение.
3 шага:

1. Скопировать папку в свой проект:
   ```bash
   cp -r django-example /path/to/your-project/giga
   ```

2. В `settings.py`:
   ```python
   INSTALLED_APPS = [..., 'giga']
   GIGACHAT_BASE = "http://192.168.1.10:5678"
   GIGACHAT_PREFIX = "myproject"
   ```

3. В корневом `urls.py`:
   ```python
   path('giga/', include('giga.urls')),
   ```

Готово. Открыть `http://localhost:8000/giga/chat` — рабочий чат-виджет.
POST на `/giga/ask` — JSON API.

Работает на Django 3.x / 4.x / 5.x. Поддерживает CSRF, Django auth,
любые шаблоны. Полная инструкция: `Agents/django-example/README.md`.

## Способ 1: готовый Python-клиент (для не-Django Python-проектов)

В корне репозитория есть `Agents/giga_client.py`. Скопируйте этот файл
в свой проект.

```bash
pip install httpx
```

```python
from giga_client import GigaChatClient, GigaChatError

giga = GigaChatClient(
    base="http://192.168.1.10:5678",  # URL GigaChat-сервера в локальной сети
    prefix="myproject",                # ваш префикс — изоляция сессий
    timeout=120
)

# Sync (для Flask/Django):
try:
    answer = giga.chat_sync("Что такое нейросети?", user_id="user42")
    print(answer)
except GigaChatError as e:
    print(f"Не удалось: {e}")

# Async (для FastAPI/aiohttp):
async def example():
    answer = await giga.chat("Привет!", user_id="user42")
    # Другие агенты:
    docs   = await giga.rag("найди в документах X", user_id="user42")
    db     = await giga.sql("сколько клиентов за месяц?", user_id="user42")
    calc   = await giga.math("корень из 2", user_id="user42")   # → dict
    routed = await giga.route("что-то непонятное", user_id="user42")  # → dict
```

## Способ 2: прокси-endpoint в Python (FastAPI)

Добавьте в свой Python-сервер тонкий прокси-endpoint:

```python
# routes/ai.py
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from giga_client import GigaChatClient, GigaChatError
from your_auth import current_user

router = APIRouter(prefix="/ai")
giga = GigaChatClient(
    base="http://192.168.1.10:5678",
    prefix="myproject"
)

class AskRequest(BaseModel):
    message: str

@router.post("/chat")
async def ai_chat(req: AskRequest, user = Depends(current_user)):
    try:
        return {"response": await giga.chat(req.message, user_id=str(user.id))}
    except GigaChatError as e:
        raise HTTPException(502, str(e))
```

Ваш HTML стучится в `POST /ai/chat`, бэк — в n8n. n8n больше не светится
в браузере.

## Способ 3: прямой fetch из HTML (только для прототипа)

Если делаете быстрый прототип без бэка:

```html
<script>
const BASE = "http://192.168.1.10:5678";

async function askGiga(message) {
  const res = await fetch(`${BASE}/webhook/chat-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: "myproject_chat_" + getUserId()
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.json()).response;
}
</script>
```

**В n8n webhook'е нужно включить CORS** (Response → Add CORS Headers),
иначе браузер заблокирует запрос.

**Минусы способа 3:** в HTML светится URL GigaChat, нет авторизации,
любой кто откроет DevTools видит шлюз. Используйте только для внутренних
прототипов.

## Способ 4: curl (для отладки и скриптов)

```bash
curl -X POST "http://192.168.1.10:5678/webhook/chat-agent" \
  -H "Content-Type: application/json" \
  -d '{"message":"Привет","session_id":"myproject_chat_user1"}'
```

## Обработка ошибок

| Код | Что значит | Что делать |
|---|---|---|
| 200 | ОК | Используйте `response` |
| 400 | Невалидный JSON / пустое поле message | Проверьте payload |
| 404 | Webhook не активирован в n8n | Сказать админу GigaChat |
| 5xx | Внутренняя ошибка n8n или GigaChat API | Повторить запрос, потом эскалировать |
| таймаут | Долгий ответ (>120s) | Большой запрос или GigaChat перегружен |

В `giga_client.py` ошибки оборачиваются в `GigaChatError`,
`GigaChatTimeout`, `GigaChatHTTPError`.

## Таймаут и долгие ответы

Math-agent с тяжёлым Python-кодом может работать 30-60 сек. По умолчанию
клиент даёт 120 сек. Не делайте таймаут меньше 60 сек.

## Логирование на стороне клиента (рекомендую)

```python
import logging, time
log = logging.getLogger("gigachat")

start = time.time()
answer = await giga.chat(message, user_id=user.id)
log.info(f"chat user={user.id} ms={int((time.time()-start)*1000)} chars={len(answer)}")
```

Поможет находить медленные запросы, аномалии нагрузки и баги.

## Rate limit (защита от зацикливания)

Если на стороне клиента случайно начнётся бесконечный цикл fetch'ей —
GigaChat поляжет. Добавьте rate limit в свой бэк:

```python
from slowapi import Limiter
limiter = Limiter(key_func=lambda r: r.state.user.id)

@router.post("/chat")
@limiter.limit("30/minute")   # не больше 30 запросов в минуту с одного юзера
async def ai_chat(req, user = Depends(current_user)):
    ...
```

## Тестирование

В дашборде GigaChat (`http://<server>/GigaChat-Platform.html`) есть кнопка
**🔌 Шлюз API** в верхнем левом углу. Откройте → вкладка **«Тест»**.
Можно выбрать агента, написать сообщение и сразу увидеть ответ. Полезно
для проверки «живой ли шлюз» и того, что ваш `session_id` принимается.

## Если что-то не работает

1. Откройте дашборд GigaChat. Если статус «офлайн» — проблема на стороне
   GigaChat-сервера. Связь с админом.
2. Если статус «онлайн», но из вашего проекта запросы валятся:
   - Проверьте URL: `curl http://<server>:5678/healthz` должен вернуть OK.
   - Проверьте имя webhook'а: должно быть точно как в таблице выше.
   - Проверьте JSON-payload: `message` и `session_id` обязательны.
3. Если ответ приходит, но «странный» — попробуйте через **вкладку Тест**
   в дашборде с тем же `session_id`. Если в дашборде нормально — баг
   в вашем коде. Если и в дашборде странно — баг в n8n workflow.

## Что НЕ нужно делать

- **Не используйте `session_id` без префикса проекта** — пересечётесь с
  сессиями GigaChat HTML.
- **Не дёргайте webhook'и в цикле** без задержки — n8n не предназначен
  для DDoS своими же запросами.
- **Не светите URL GigaChat в публичных приложениях** — это внутренний
  сервис локальной сети офиса.

---

## Контакты

- Репозиторий: https://github.com/Jorden-maker/GigaChat
- Готовый Django app: `Agents/django-example/`
- Python-клиент (общий): `Agents/giga_client.py`
- Дашборд GigaChat: `http://<gigachat-server>/GigaChat-Platform.html`
