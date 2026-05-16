from django.apps import AppConfig


class GigaAppConfig(AppConfig):
    """Django app для интеграции с GigaChat шлюзом.

    Подключение в settings.py:
        INSTALLED_APPS = [
            ...
            'giga',  # путь к этой папке (или dotted path к app)
        ]
    """
    default_auto_field = "django.db.models.BigAutoField"
    name = "giga"
    verbose_name = "GigaChat integration"
