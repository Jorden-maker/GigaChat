"""
GigaChat Client — Python-клиент для подключения внешних проектов к GigaChat
через шлюз n8n.

Установка зависимостей:
    pip install httpx

Использование:
    from giga_client import GigaChatClient

    giga = GigaChatClient(
        base="http://192.168.1.10:5678",  # URL сервера GigaChat в локальной сети
        prefix="myproject",                # ваш префикс для изоляции сессий
        timeout=120                        # таймаут одного запроса, сек
    )

    # async-вариант (рекомендую для FastAPI/aiohttp):
    async def example():
        text = await giga.chat("Привет!", user_id="user42")
        print(text)

    # sync-вариант (для Flask/Django):
    text = giga.chat_sync("Привет!", user_id="user42")
    print(text)
"""
import httpx
from typing import Optional, Dict, Any


class GigaChatError(Exception):
    """Любая ошибка взаимодействия со шлюзом GigaChat."""


class GigaChatTimeout(GigaChatError):
    """Сервер GigaChat не ответил вовремя."""


class GigaChatHTTPError(GigaChatError):
    """Сервер GigaChat вернул не-2xx код."""
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {body[:200]}")


class GigaChatClient:
    """Клиент для агентов GigaChat через единый n8n шлюз.

    Сессии изолируются по префиксу: каждый session_id получает вид
    `{prefix}_{agent_short}_{user_id}`, чтобы не пересекаться с сессиями
    самого GigaChat HTML.

    Доступные методы (async):
        chat(message, user_id)     — универсальный чат-агент
        rag(message, user_id)      — поиск по загруженным документам
        sql(message, user_id)      — запросы к БД на естественном языке
        math(message, user_id)     — генерация Python-кода для задачи (см. note)
        prompt(message, user_id)   — генерация и улучшение промптов

    Sync-варианты: те же имена с суффиксом `_sync`.

    Note про math:
        После перехода math-агента на двухфазную архитектуру (Pyodide
        в браузере) этот endpoint возвращает только СГЕНЕРИРОВАННЫЙ КОД
        для задачи, не готовое число. Поле `response` пустое, `code`
        содержит Python для исполнения. Готовый ответ с пояснением
        собирается ТОЛЬКО в Web UI через Pyodide + второй webhook
        /math-explain. Из Django:
        - либо исполняй code на своей стороне (subprocess/exec — security!)
        - либо показывай code пользователю как есть
        - либо не используй math из API, а только из Web UI

    Auto-routing (router) НЕ доступен через API: реальная маршрутизация
    живёт в router.html фронте (классифицирует сообщение и динамически
    выбирает webhook). /webhook/router в n8n — только пинг-стаб.
    Из Django: вызывай конкретного агента напрямую.
    """

    def __init__(
        self,
        base: str = "http://localhost:5678",
        prefix: str = "external",
        timeout: int = 120,
    ):
        self.base = base.rstrip("/")
        self.prefix = prefix
        self.timeout = timeout

    # ---------- helpers ----------

    def _sid(self, user_id: str, scope: str) -> str:
        """Собирает session_id с префиксом проекта.

        Пример: prefix='myapp', user_id='u42', scope='chat' →
                'myapp_chat_u42'
        """
        return f"{self.prefix}_{scope}_{user_id}"

    async def _post_async(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(f"{self.base}/webhook/{path}", json=payload)
        except httpx.TimeoutException as e:
            raise GigaChatTimeout(f"Таймаут {self.timeout}s: {e}") from e
        except httpx.RequestError as e:
            raise GigaChatError(f"Сетевая ошибка: {e}") from e
        if resp.status_code >= 400:
            raise GigaChatHTTPError(resp.status_code, resp.text)
        try:
            return resp.json()
        except ValueError as e:
            raise GigaChatError(f"Сервер вернул не-JSON: {resp.text[:200]}") from e

    def _post_sync(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(f"{self.base}/webhook/{path}", json=payload)
        except httpx.TimeoutException as e:
            raise GigaChatTimeout(f"Таймаут {self.timeout}s: {e}") from e
        except httpx.RequestError as e:
            raise GigaChatError(f"Сетевая ошибка: {e}") from e
        if resp.status_code >= 400:
            raise GigaChatHTTPError(resp.status_code, resp.text)
        try:
            return resp.json()
        except ValueError as e:
            raise GigaChatError(f"Сервер вернул не-JSON: {resp.text[:200]}") from e

    # ---------- async API ----------

    async def chat(self, message: str, user_id: str) -> str:
        data = await self._post_async("chat", {
            "message": message, "session_id": self._sid(user_id, "chat")
        })
        return data.get("response", "")

    async def rag(self, message: str, user_id: str) -> str:
        data = await self._post_async("rag", {
            "message": message, "session_id": self._sid(user_id, "rag")
        })
        return data.get("response", "")

    async def sql(self, message: str, user_id: str) -> str:
        data = await self._post_async("sql", {
            "message": message, "session_id": self._sid(user_id, "sql")
        })
        return data.get("response", "")

    async def math(self, message: str, user_id: str) -> Dict[str, Any]:
        # Возвращает {stage:'execute', code, response:'', raw_result:''}.
        # См. docstring класса: response пустой, code нужно исполнять самостоятельно.
        return await self._post_async("math", {
            "message": message, "session_id": self._sid(user_id, "math")
        })

    async def prompt(self, message: str, user_id: str) -> Dict[str, Any]:
        # prompt-engineer возвращает {response, prompt}
        return await self._post_async("prompt-engineer", {
            "message": message, "session_id": self._sid(user_id, "prompt")
        })

    # ---------- sync API (те же методы с суффиксом _sync) ----------

    def chat_sync(self, message: str, user_id: str) -> str:
        data = self._post_sync("chat", {
            "message": message, "session_id": self._sid(user_id, "chat")
        })
        return data.get("response", "")

    def rag_sync(self, message: str, user_id: str) -> str:
        data = self._post_sync("rag", {
            "message": message, "session_id": self._sid(user_id, "rag")
        })
        return data.get("response", "")

    def sql_sync(self, message: str, user_id: str) -> str:
        data = self._post_sync("sql", {
            "message": message, "session_id": self._sid(user_id, "sql")
        })
        return data.get("response", "")

    def math_sync(self, message: str, user_id: str) -> Dict[str, Any]:
        # См. docstring класса: возвращает только код, не готовый ответ.
        return self._post_sync("math", {
            "message": message, "session_id": self._sid(user_id, "math")
        })

    def prompt_sync(self, message: str, user_id: str) -> Dict[str, Any]:
        return self._post_sync("prompt-engineer", {
            "message": message, "session_id": self._sid(user_id, "prompt")
        })


# ---------- быстрая проверка из терминала ----------
if __name__ == "__main__":
    import sys
    base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5678"
    giga = GigaChatClient(base=base, prefix="test")
    try:
        answer = giga.chat_sync("Привет, кто ты?", user_id="cli")
        print("Ответ chat-agent:")
        print(answer)
    except GigaChatError as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        sys.exit(1)
