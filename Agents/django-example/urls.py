"""URL-маршруты для GigaChat app.

Подключение в корневом urls.py проекта:

    from django.urls import path, include
    urlpatterns = [
        ...
        path('giga/', include('giga.urls')),
    ]

Получается endpoint:
    POST /giga/ask  — JSON API, агент выбирается параметром body.agent
"""
from django.urls import path
from . import views

app_name = "giga"

urlpatterns = [
    path("ask", views.ai_ask, name="ask"),
]
