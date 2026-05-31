#!/usr/bin/env bash
# ============================================================================
# Start GigaChat local HTTP server (Caddy) on Linux.
#
# Использование:
#   chmod +x Linux/GigaChat-Start.sh    # один раз после клонирования
#   ./Linux/GigaChat-Start.sh           # запуск из корня проекта
#
# Или из любого места:
#   /opt/gigachat/Linux/GigaChat-Start.sh
#
# Что делает:
#   - Поднимается в корень проекта (родительская папка скрипта)
#   - Проверяет наличие линуксового бинарника caddy в Linux/caddy
#   - Запускает caddy run с корневым Caddyfile (тот же что для Windows)
#   - Слушает http://localhost:8765 (или измени порт в Caddyfile)
#   - Логи Caddy идут в этот терминал; Ctrl+C — остановка
#
# Требуется:
#   - Linux-бинарник Caddy положенный как Linux/caddy с правами +x
#     (скачать: https://caddyserver.com/download → linux/amd64)
#   - Caddyfile в корне проекта (уже там, общий с Windows)
#
# Для запуска как daemon — см. Linux/README.md (systemd unit).
# ============================================================================

set -e

# Аргумент $0 может быть относительным («./Linux/GigaChat-Start.sh») или
# абсолютным. readlink -f нормализует к абсолютному пути. Затем поднимаемся
# на уровень вверх (из Linux/ в корень проекта).
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

CADDY_BIN="$SCRIPT_DIR/caddy"
CADDYFILE="$PROJECT_ROOT/Caddyfile"

if [ ! -x "$CADDY_BIN" ]; then
    echo
    echo "ERROR: Linux Caddy binary not found at $CADDY_BIN"
    echo
    echo "Что сделать:"
    echo "  1) Скачать Linux/amd64 бинарник: https://caddyserver.com/download"
    echo "     (или принести на флешке если сервер без интернета)"
    echo "  2) Распаковать и переименовать в 'caddy'"
    echo "  3) Положить как $CADDY_BIN"
    echo "  4) chmod +x $CADDY_BIN"
    echo
    exit 1
fi

if [ ! -f "$CADDYFILE" ]; then
    echo
    echo "ERROR: Caddyfile not found at $CADDYFILE"
    echo "Скрипт должен запускаться из проекта с корневым Caddyfile."
    echo
    exit 1
fi

cat <<EOF
============================================
 GigaChat Server (Linux)
 ----
 URL:  http://localhost:8765/
 ----
 Открой URL в браузере с любой машины LAN
 (замени localhost на IP сервера).
 Ctrl+C — остановить сервер.
============================================

EOF

exec "$CADDY_BIN" run --config "$CADDYFILE"
