"""Django views для GigaChat шлюза.

Универсальный код — работает на Django 3.x / 4.x / 5.x.
Используется sync-API (через httpx Client), не требует async-настроек.

Подключение URL: см. urls.py этого же app.

Безопасность:
- CSRF: используется стандартный Django-механизм. В шаблоне передаём
  X-CSRFToken (см. templates/giga/chat.html).
- Аутентификация: если у вас Django auth — берём request.user.id.
  Если пользователь анонимный — генерируем стабильный ID на основе
  session_key, чтобы у анонима всё равно была своя «история» в одной
  вкладке.

Конфиг через Django settings (необязательно — есть дефолты):
    GIGACHAT_BASE = "http://192.168.1.10:5678"
    GIGACHAT_PREFIX = "djangoapp"
    GIGACHAT_TIMEOUT = 120
"""
import json
import logging
import time

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse, HttpResponseBadRequest
from django.shortcuts import render
from django.views.decorators.http import require_POST

from .giga_client import GigaChatClient, GigaChatError, GigaChatTimeout, GigaChatHTTPError

log = logging.getLogger("giga")

# Глобальный клиент — переиспользует httpx-pool между запросами.
_giga = GigaChatClient(
    base=getattr(settings, "GIGACHAT_BASE", "http://localhost:5678"),
    prefix=getattr(settings, "GIGACHAT_PREFIX", "djangoapp"),
    timeout=getattr(settings, "GIGACHAT_TIMEOUT", 120),
)


def _user_id(request) -> str:
    """Стабильный ID для session_id GigaChat.

    Залогиненный пользователь → его django pk.
    Аноним → 'anon_<session_key первые 12 символов>' (стабильно в рамках
    одной браузерной сессии, не пересекается с другими анонимами).
    """
    if hasattr(request, "user") and request.user.is_authenticated:
        return str(request.user.pk)
    # Гарантируем что у анонима есть session_key
    if not request.session.session_key:
        request.session.save()
    return "anon_" + (request.session.session_key or "unknown")[:12]


def _parse_message(request):
    """Парсит JSON-body, возвращает text или HttpResponseBadRequest."""
    try:
        data = json.loads(request.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, HttpResponseBadRequest("Body должен быть валидным JSON")
    message = (data.get("message") or "").strip()
    if not message:
        return None, HttpResponseBadRequest("Поле 'message' обязательно")
    return message, None


def _call_giga(method_name: str, message: str, user_id: str):
    """Вызывает sync-метод клиента, логирует время и ошибки."""
    method = getattr(_giga, method_name)
    started = time.time()
    try:
        result = method(message, user_id=user_id)
        elapsed_ms = int((time.time() - started) * 1000)
        log.info("giga.%s user=%s ms=%d", method_name, user_id, elapsed_ms)
        return result, None
    except GigaChatTimeout as e:
        log.warning("giga.%s user=%s TIMEOUT %s", method_name, user_id, e)
        return None, JsonResponse({"error": "GigaChat не ответил вовремя"}, status=504)
    except GigaChatHTTPError as e:
        log.warning("giga.%s user=%s HTTP %d", method_name, user_id, e.status)
        return None, JsonResponse({"error": f"GigaChat вернул {e.status}"}, status=502)
    except GigaChatError as e:
        log.exception("giga.%s user=%s", method_name, user_id)
        return None, JsonResponse({"error": str(e)}, status=502)


# ===================== ОСНОВНОЙ ENDPOINT =====================
# Один endpoint, агент выбирается параметром.

@require_POST
def ai_ask(request):
    """POST /giga/ask
    Body: { "message": "...", "agent": "chat" | "rag" | "sql" | "math" | "route" | "prompt" }
    """
    message, err = _parse_message(request)
    if err:
        return err

    try:
        body = json.loads(request.body.decode("utf-8"))
    except ValueError:
        body = {}
    agent = (body.get("agent") or "chat").lower()
    valid = {"chat", "rag", "sql", "math", "route", "prompt"}
    if agent not in valid:
        return HttpResponseBadRequest(f"agent должен быть одним из: {', '.join(sorted(valid))}")

    # Метод клиента совпадает с именем агента: chat → chat_sync, rag → rag_sync и т.д.
    method = agent + "_sync"
    result, err_resp = _call_giga(method, message, _user_id(request))
    if err_resp:
        return err_resp

    # chat/rag/sql возвращают str; math/route/prompt возвращают dict.
    if isinstance(result, str):
        return JsonResponse({"response": result})
    return JsonResponse(result)


# ===================== СТРАНИЦА-ВИДЖЕТ =====================

def chat_page(request):
    """GET /giga/chat — простая HTML-страница с виджетом чата.
    Используйте как пример или встройте chat.html в свой шаблон.
    """
    return render(request, "giga/chat.html")
