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

## Поток развёртывания и обновлений

Машины и их роли:

| Машина | Сеть | Что делает |
|---|---|---|
| Дом / любая с интернетом | Интернет | `git clone`/`git pull` с GitHub, копирование на флэшку |
| Windows-ПК в офисе | LAN, нет интернета | Принимает с флэшки, гоняет локальную копию GigaChat через Caddy, перекидывает на сервер через SSH |
| Linux-сервер | LAN | Принимает по SSH, раздаёт GigaChat всем в LAN через Caddy на :8765 |

Общий поток:

```
GitHub
   ↓ git clone / git pull (машина с интернетом)
Флэшка
   ↓ copy-paste в проводнике
Windows-ПК (Caddy)
   ↓ scp -r / WinSCP по SSH
Linux-сервер (Caddy + systemd)
   ↓ открывается в LAN
Браузер у любого офисного пользователя
```

## Первичное развёртывание

### Шаг 1 — получить проект на флэшке

С машины с интернетом (дом, личный ноутбук, всё что угодно):

```bash
git clone https://github.com/Jorden-maker/GigaChat.git
# Скопировать всю папку GigaChat на флэшку (через проводник или cp -r)
```

Без `git clone` тоже можно — на странице GitHub → зелёная кнопка `Code` →
`Download ZIP`. Распакованный архив на флэшке = то же самое (но без `.git/`
истории, что для офисного флоу скорее плюс — меньше размер).

### Шаг 2 — Windows-ПК в офисе

Воткни флэшку в Windows-ПК где сейчас крутится Caddy. Скопируй папку
проекта поверх существующей (или в новое место — но тогда не забудь
поменять путь в `GigaChat-Start.bat` если на нём ярлык).

Прогон локально для проверки:
- Запустить `GigaChat-Start.bat` (даблклик)
- Открыть `http://localhost:8765/` в браузере — должна загрузиться платформа

Это нужно чтобы убедиться: обновление с GitHub ничего не сломало на твоей
рабочей машине **до того** как перекидывать на сервер.

### Шаг 3 — перекинуть с Windows-ПК на Linux-сервер по SSH

**SSH нужен ТОЛЬКО в одну сторону** — Windows → Linux. Сервер ничего не
инициирует, только принимает подключения. Это значит:
- На Linux-сервере должен быть OpenSSH-сервер: `sudo systemctl status ssh`
  (на Ubuntu 22.04 обычно из коробки).
- На Windows-ПК должен быть OpenSSH-клиент: `ssh -V` в PowerShell должен
  вернуть версию (в Windows 10/11 встроен по умолчанию).

В Windows 10/11 уже есть OpenSSH-клиент (`ssh`, `scp`), включён по умолчанию.
Проверка: `ssh -V` в PowerShell или cmd должен вернуть версию.

**Вариант A — через PowerShell/cmd (CLI):**

```powershell
# Подставь свой логин и IP сервера:
cd C:\Users\Lenovo\Desktop
scp -r GigaChat user@192.168.X.Y:/tmp/giga-upload/

# Затем зайти на сервер и переместить в /opt/:
ssh user@192.168.X.Y
sudo mkdir -p /opt/gigachat
sudo rsync -a --delete /tmp/giga-upload/GigaChat/ /opt/gigachat/
rm -rf /tmp/giga-upload
exit
```

Файлы пока принадлежат root — это нормально, ownership поправим в Шаге 6
сразу после `useradd gigachat`.

`rsync -a --delete` синхронизирует папки: новые файлы добавляются,
изменённые перезаписываются, удалённые (которые есть в `/opt/gigachat`,
но нет в `/tmp/giga-upload/GigaChat`) — удаляются. Это даёт чистое
состояние идентичное флэшке.

Промежуточная папка `/tmp/giga-upload/` нужна потому что прямой `scp` под
обычным юзером не сможет писать в `/opt/`. С `sudo rsync` уже можем.

**Вариант B — через WinSCP (GUI):**

1. Скачать WinSCP с официального сайта (~10 МБ), один раз поставить.
2. New site → SFTP → host = IP сервера, user/password.
3. Слева — твой проект `C:\Users\Lenovo\Desktop\GigaChat`, справа — `/tmp/`
   на сервере (в `/opt/` обычным юзером не пустит).
4. Перетащить папку `GigaChat` справа налево. WinSCP покажет прогресс.
5. После загрузки — открыть `Commands → Open Terminal` (внутри WinSCP),
   выполнить:
   ```bash
   sudo mkdir -p /opt/gigachat
   sudo rsync -a --delete /tmp/GigaChat/ /opt/gigachat/
   rm -rf /tmp/GigaChat
   ```
   Файлы пока принадлежат root — ownership на юзера `gigachat` поправим
   в Шаге 6 сразу после `useradd`.

### Шаг 4 — проверить Caddy-бинарник на сервере

Linux-бинарник `Linux/caddy` уже в git (50 МБ, статически слинкован, без
зависимостей). После переноса через scp/rsync он будет на месте с
правом исполнения (mode 100755 в git tree).

```bash
ssh user@server
/opt/gigachat/Linux/caddy version
# Должно вывести: v2.x.x h1:...
```

Если выдаст `Permission denied: ./caddy` — `sudo chmod +x /opt/gigachat/Linux/caddy`
(Windows-клиент мог не сохранить +x при scp в зависимости от настройки).

Если когда-нибудь захочешь обновить Caddy — скачай свежий с
https://caddyserver.com/download (linux/amd64), перепиши `Linux/caddy`
у себя на машине, закоммить и пуш. Размер не должен превышать 100 МБ
(хард-лимит GitHub на файл; нынешние ~50 МБ — впритык, мониторь).

### Шаг 5 — попробовать запуск вручную

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

### Шаг 6 — настроить автозапуск через systemd

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

Тот же поток что и первичная установка, только сокращённый — каждый раз
одинаково:

1. **Машина с интернетом:** `git pull` (или скачать свежий ZIP с GitHub) →
   скопировать на флэшку.
2. **Windows-ПК в офисе:** воткнуть флэшку, скопировать поверх локальной
   копии GigaChat. Перезапустить `GigaChat-Start.bat` чтобы Caddy подхватил
   изменения. Проверить что локально работает.
3. **С Windows-ПК на сервер по SSH:**
   ```powershell
   cd C:\Users\Lenovo\Desktop
   scp -r GigaChat user@SERVER_IP:/tmp/giga-upload/
   ssh user@SERVER_IP "sudo rsync -a --delete /tmp/giga-upload/GigaChat/ /opt/gigachat/ && sudo chown -R gigachat:gigachat /opt/gigachat && rm -rf /tmp/giga-upload && sudo systemctl restart gigachat"
   ```
   (всё в одну строку через `&&`, можно разбить на отдельные ssh-команды
   если так понятнее.)

`rsync -a --delete` — удалит из `/opt/gigachat` файлы которых нет в
обновлении (например, я удалил `INTEGRATION.md` и `Agents/django-example/` —
они исчезнут с сервера тоже, не накапливая мусор).

### После обновления — что проверить

1. `sudo systemctl status gigachat` — `Active: active (running)`
2. `curl -s http://localhost:8765/ | head -5` — должен вернуть начало HTML
3. Открыть `http://SERVER_IP:8765/` в браузере — дашборд показывает карточки

### Если что-то пошло не так — откат на предыдущую версию

Простейший вариант — держи две папки на сервере: `/opt/gigachat` (текущая)
и `/opt/gigachat-prev` (предыдущая). Перед обновлением:

```bash
ssh user@SERVER_IP "sudo rm -rf /opt/gigachat-prev && sudo cp -a /opt/gigachat /opt/gigachat-prev"
```

Если новая версия упала:

```bash
ssh user@SERVER_IP "sudo rm -rf /opt/gigachat && sudo mv /opt/gigachat-prev /opt/gigachat && sudo systemctl restart gigachat"
```

(Можно автоматизировать в скрипт `Linux/deploy.sh` на Windows-стороне —
сделаем когда понадобится.)

### Будущая миграция на git-based обновления

Текущий метод — `scp + rsync` — самый простой и работает прямо сейчас.
Когда захочешь перейти на `git pull` на сервере, есть три рабочих варианта,
все совместимы с офлайн-сервером:

| Способ | Как работает | SSH-направление |
|---|---|---|
| **Bare-репо на Windows-ПК** | Сервер делает `git pull ssh://win-pc/...` | Linux → Windows (НУЖНА доп. настройка SSH-сервера на Windows) |
| **Git bundle через флэшку** | На Windows: `git bundle create giga.bundle origin/main`. Через флэшку → сервер. На сервере: `git fetch ./giga.bundle main:main` | Никакой SSH не нужен |
| **Git push с Windows на сервер** | На сервере bare-репо в `/opt/gigachat.git`. Windows делает `git push office main`. Затем `cd /opt/gigachat && git pull` на сервере | Windows → Linux (как сейчас) |

Третий вариант — продолжение текущего одностороннего SSH-флоу, минимум
доп. настроек. Когда настанет время — допишу отдельный раздел в этом README.

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
