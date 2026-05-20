# Запуск GigaChat на Linux-сервере

Эта папка содержит всё необходимое для запуска GigaChat-фронтенда на Linux
(Ubuntu 22.04 и похожие). Корневой проект остаётся OS-агностичным, Windows-запуск
через `GigaChat-Start.bat` + `caddy.exe` продолжает работать как раньше.

## Что внутри Linux/

| Файл | Назначение |
|---|---|
| `GigaChat-Start.sh` | Bash-аналог `GigaChat-Start.bat` — запускает Caddy с корневым Caddyfile |
| `gigachat.service` | systemd unit для автозапуска сервера при загрузке |
| `caddy` | Линуксовый бинарник Caddy (ELF x86-64, ~50 МБ, статически слинкован) |
| `.gitattributes` | LF-окончания для `.sh` + явный `binary` для `caddy` |
| `README.md` | Этот файл |

## Что использует с корня проекта

| Файл | Зачем |
|---|---|
| `../Caddyfile` | Конфиг Caddy. Один на обе ОС, без дубликатов |
| `../Agents/` | Статика фронтенда (HTML/CSS/JS) и `lib/pyodide/` для math-агента |
| `../GigaChat-Platform.html` | Главная страница, открывается по `http://server:8765/` |
| `../Workflow/` | Не нужен для фронта — это для импорта в n8n отдельно |

## Архитектура на сервере

```
Сервер Ubuntu 22.04
├── n8n (в Docker)               :5678  ← бекенд (уже развёрнут)
├── PostgreSQL + pgvector        :5432  ← БД для n8n (уже развёрнут)
├── Caddy (этот сервис)          :8765  ← статика GigaChat + proxy
│       ├── /              → GigaChat-Platform.html
│       └── /Agents/*      → файлы фронтенда
└── (соседний Django-проект)     :другой порт  ← с него ссылка на :8765
```

Фронтенд GigaChat и Caddy крутятся на одном порту (8765). Соседний Django
живёт на своём порту, его главная страница имеет кнопку
`<a href="http://SERVER_IP:8765/">GigaChat</a>` (авторизация — на стороне Django).

n8n остаётся на :5678 — фронт стучится туда напрямую через `_config.js` →
`N8N_BASE: 'http://localhost:5678'`. Если фронт открывают НЕ с сервера
(а с другой машины в LAN) — поменяй на реальный IP сервера, см. раздел
«Конфиг фронтенда».

---

## Первичное развёртывание

### Шаг 1 — получить проект на сервере

Сервер без интернета, обновления приносятся через флешку. Один из вариантов:

**Вариант А. SSH-доступ есть, проект кладёшь через scp**

С офисной машины (где Git и интернет):
```bash
# Клонировать с GitHub на офисную машину или флешку
git clone https://github.com/Jorden-maker/GigaChat.git
# Перенести на сервер (например через scp)
scp -r GigaChat user@server:/opt/
```

**Вариант Б. Bare-репо на сервере, push с офисной машины**

На сервере один раз:
```bash
sudo mkdir -p /opt/gigachat.git
sudo chown $USER /opt/gigachat.git
cd /opt/gigachat.git
git init --bare
```

На офисной машине:
```bash
cd ~/GigaChat   # локальная копия из GitHub
git remote add office user@server:/opt/gigachat.git
git push office main
```

На сервере (рабочая копия):
```bash
sudo git clone /opt/gigachat.git /opt/gigachat
sudo chown -R gigachat:gigachat /opt/gigachat
```

При обновлении: на офисной машине `git pull origin main && git push office main`,
на сервере `cd /opt/gigachat && sudo -u gigachat git pull`.

### Шаг 2 — проверить Caddy-бинарник

Linux-бинарник `Linux/caddy` уже в git (50 МБ, статически слинкован, без зависимостей).
После git pull/clone он будет на месте. Только убедись что executable-бит выставлен:

```bash
chmod +x /opt/gigachat/Linux/caddy
/opt/gigachat/Linux/caddy version
# Должно вывести: v2.x.x h1:...
```

Если когда-нибудь захочешь обновить Caddy — скачай свежий с
https://caddyserver.com/download (linux/amd64), перепиши `Linux/caddy`,
закоммить и пуш. Размер не должен превышать 100 МБ (хард-лимит GitHub
на файл; нынешняя версия ~50 МБ — впритык, мониторь).

### Шаг 3 — попробовать запуск вручную

```bash
cd /opt/gigachat
chmod +x Linux/GigaChat-Start.sh
./Linux/GigaChat-Start.sh
```

Откроется лог Caddy. Открой в браузере с этой же машины:
```
http://localhost:8765/
```

Или с другой машины в LAN:
```
http://<IP-сервера>:8765/
```

Должен открыться дашборд GigaChat-Platform.html. Карточки агентов покажут
«проверка...» → «онлайн» (если n8n рядом отвечает на ping).

Ctrl+C останавливает Caddy.

### Шаг 4 — настроить автозапуск через systemd

```bash
# 1) Подправь пути в gigachat.service если проект НЕ в /opt/gigachat:
nano /opt/gigachat/Linux/gigachat.service
#    Замени все /opt/gigachat на свой путь

# 2) Создай юзера-сервиса (если ещё нет):
sudo useradd --system --shell /usr/sbin/nologin --home /opt/gigachat gigachat
sudo chown -R gigachat:gigachat /opt/gigachat

# 3) Установи unit-файл:
sudo cp /opt/gigachat/Linux/gigachat.service /etc/systemd/system/
sudo systemctl daemon-reload

# 4) Включи автозапуск + запусти сейчас:
sudo systemctl enable --now gigachat.service

# 5) Проверь статус:
sudo systemctl status gigachat
sudo journalctl -u gigachat -n 30   # последние 30 строк логов
```

После этого сервис будет:
- Стартовать при загрузке сервера
- Перезапускаться сам если упал
- Логировать в `journalctl -u gigachat`

---

## Обновление проекта

Поток: GitHub → офисная машина → флешка → сервер.

### Если есть bare-репо на сервере (рекомендуется)

```bash
# На офисной машине (с интернетом):
cd ~/GigaChat
git pull origin main           # подтянуть с GitHub
# Если ещё нет remote 'office':
# git remote add office user@server:/opt/gigachat.git

# Если сервер достижим по сети — push напрямую:
git push office main

# Если только через флешку — bundle:
git bundle create /flash/giga-update.bundle origin/main
# Перенести флешку на сервер, затем на сервере:
ssh user@server
cd /opt/gigachat.git
git fetch /flash/giga-update.bundle main:main
```

На сервере:
```bash
cd /opt/gigachat
sudo -u gigachat git pull
sudo systemctl restart gigachat   # перезапуск Caddy для подтягивания изменений
```

### Если без bare-репо, scp напрямую

```bash
# На офисной машине:
cd ~/GigaChat && git pull origin main
# Запаковать только нужное (без .git):
tar czf /tmp/giga-update.tar.gz \
    --exclude='.git' --exclude='Linux/caddy' \
    Agents Workflow Caddyfile GigaChat-Platform.html

# Перенести через флешку или scp:
scp /tmp/giga-update.tar.gz user@server:/tmp/

# На сервере:
cd /opt/gigachat
sudo -u gigachat tar xzf /tmp/giga-update.tar.gz
sudo systemctl restart gigachat
```

### После обновления — что проверить

1. `sudo systemctl status gigachat` — Active: active (running)
2. `curl -s http://localhost:8765/ | head -5` — должен вернуть начало HTML
3. Открыть в браузере: `http://SERVER_IP:8765/` — дашборд показывает карточки

---

## Конфиг фронтенда

Фронт по умолчанию стучится к n8n как `http://localhost:5678` (см.
`Agents/_config.js`). На сервере есть варианты:

**Вариант 1 — браузер открывают НА сервере** (не наш случай):
- `localhost` работает, ничего не менять.

**Вариант 2 — браузер открывают С ДРУГОЙ машины LAN** (наш случай):
- `localhost` указывает на машину пользователя, не на сервер → запросы не дойдут.
- Поменять `N8N_BASE` в `Agents/_config.js`:
  ```js
  N8N_BASE: 'http://192.168.X.Y:5678'
  ```
  где `192.168.X.Y` — IP сервера в LAN.
- ИЛИ настроить reverse-proxy в Caddyfile (см. ниже).

### Опционально — proxy n8n через Caddy

Так фронт стучится в `/webhook/...` (same-origin), Caddy перенаправляет на
n8n. Никакого CORS-головняка, никакой жёстко прописанный IP в `_config.js`.

Добавить в `../Caddyfile` (КОРНЕВОЙ, общий с Windows):

```
:8765 {
    root * .
    file_server
    encode gzip

    # Proxy всех webhook'ов n8n через тот же origin.
    handle_path /webhook/* {
        reverse_proxy localhost:5678
    }

    @root path /
    rewrite @root /GigaChat-Platform.html
    # ... остальное без изменений
}
```

Потом в `Agents/_config.js` поставить:
```js
N8N_BASE: ''   // пустая строка = тот же origin, что страница
```

После любой правки Caddyfile:
```bash
sudo systemctl reload gigachat   # graceful reload, без обрыва соединений
```

Внимание: эта правка повлияет и на Windows-разработку. Если на windows-машине
n8n не на 5678 — придётся отдельно условие или переменная окружения.

---

## Диагностика

### Caddy не стартует

```bash
sudo journalctl -u gigachat -n 50 --no-pager
```

Типичные причины:
- **`bind: address already in use`** — порт 8765 занят (другой процесс).
  Найти: `sudo ss -tlnp | grep 8765`. Освободить или поменять порт в Caddyfile.
- **`permission denied`** — нет прав на `Linux/caddy`. `chmod +x Linux/caddy`.
- **`bad interpreter: /usr/bin/env\r`** — .sh файл с CRLF (Windows-окончания).
  Чинить: `sed -i 's/\r$//' Linux/GigaChat-Start.sh`. Чтобы не повторялось —
  `.gitattributes` в этой папке уже форсит LF, но если что-то ломалось до
  его добавления — починить вручную раз.

### Браузер открывает, но «Создайте новую сессию» и кнопки не реагируют

Проверь DevTools (F12) → Console. Возможные ошибки:
- **`sendBtn is not defined`** — была регрессия в _shared.js до коммита 9638e97.
  Подтянуть последний main + Ctrl+F5 в браузере.
- **Network request failed for `/webhook/...`** — фронт не достучался до n8n.
  Проверь `_config.js` → `N8N_BASE` указывает правильно (см. раздел выше).

### Math-агент не загружается («Pyodide worker не инициализировался»)

- Проверь что в `Agents/lib/pyodide/` есть файлы (.whl, pyodide.js,
  python_stdlib.zip и пр.). Бандл ~100 МБ — он лежит в git, но при
  частичном rsync мог потеряться.
- Pyodide требует MIME `application/wasm` для `.wasm` файлов. Caddyfile
  это уже задаёт. Проверь что `curl -I http://localhost:8765/Agents/lib/pyodide/pyodide.asm.wasm`
  возвращает `Content-Type: application/wasm`.

### n8n возвращает 404 на webhook

- Workflow не активирован в n8n. Открой `http://server:5678/`, проверь что
  все нужные workflow в статусе «Active». Скрипт активации — `activate-workflows.ps1`
  (запускается на офисной машине, через сетевой доступ к n8n API).

---

## Удаление / откат

```bash
sudo systemctl disable --now gigachat
sudo rm /etc/systemd/system/gigachat.service
sudo systemctl daemon-reload
# Файлы проекта остаются в /opt/gigachat, можно удалить вручную если нужно
```
