"""URL-маршруты для GigaChat app.

Подключение в корневом urls.py проекта:

    from django.urls import path, include
    urlpatterns = [
        ...
        path('giga/', include('giga.urls')),
    ]

Получаются endpoint'ы:
    POST /giga/ask     — основной (агент в теле)
    GET  /giga/chat    — демо-страница виджета
"""
from django.urls import path
from . import views

app_name = "giga"

urlpatterns = [
    path("ask", views.ai_ask, name="ask"),
    path("chat", views.chat_page, name="chat"),
]
