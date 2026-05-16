"""URL-маршруты для GigaChat app.

Подключение в корневом urls.py проекта:

    from django.urls import path, include
    urlpatterns = [
        ...
        path('giga/', include('giga.urls')),
    ]

Получаются endpoint'ы:
    POST /giga/ask     — JSON API, агент выбирается параметром body.agent
    GET  /giga/health  — liveness для дашборда GigaChat (он пингует и
                         видит «подключён ли наш проект»)
"""
from django.urls import path
from . import views

app_name = "giga"

urlpatterns = [
    path("ask", views.ai_ask, name="ask"),
    path("health", views.health, name="health"),
]
