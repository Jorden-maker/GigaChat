// GigaChat — общие утилиты для всех агентов.
// Подключать ПОСЛЕ _config.js: <script src="_config.js"></script><script src="_shared.js"></script>
(function (global) {
  var cfg = global.GIGACHAT_CONFIG || { N8N_BASE: 'http://localhost:5678' };

  var FETCH_TIMEOUT_MS = 120000;
  var MAX_RETRIES = 2;
  var RETRY_DELAY_MS = 3000;
  var PING_TIMEOUT_MS = 5000;

  // Единый whitelist форматов для скрепки. Раньше каждый HTML определял
  // свой accept-список, а canExtractInBrowser/OCR — отдельный набор. Расходились
  // в крайних случаях (xlsm/csv/md/log парсер принимал, accept не пускал).
  // ACCEPT_BROWSER — извлекаем в браузере (JSZip или прямое чтение)
  // ACCEPT_OCR     — отправляем в OCR (PDF, картинки, старые форматы)
  var SUPPORTED_FILE_EXTS = {
    browser: ['docx', 'xlsx', 'xlsm', 'txt', 'md', 'log', 'csv'],
    ocr:     ['pdf', 'doc', 'rtf', 'odt', 'xls', 'ppt', 'pptx',
              'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic', 'heif']
  };
  function acceptAttr(scope) {
    // scope: 'all' | 'browser' | 'ocr' | array of group names
    var groups = scope === 'all' || !scope
      ? ['browser', 'ocr']
      : (Array.isArray(scope) ? scope : [scope]);
    var exts = [];
    for (var i = 0; i < groups.length; i++) {
      var g = SUPPORTED_FILE_EXTS[groups[i]] || [];
      for (var j = 0; j < g.length; j++) exts.push('.' + g[j]);
    }
    return exts.join(',');
  }

  function webhookUrl(path) {
    return cfg.N8N_BASE.replace(/\/$/, '') + '/webhook/' + path.replace(/^\//, '');
  }

  // ============================================================
  // AUTH — единая аутентификация для всех агентов платформы
  // ============================================================
  // Архитектура: одна отдельная страница /login.html выдаёт session-token
  // (workflow planner-auth, таблица auth_sessions). Все защищённые агенты
  // (plane-agent) на bootstrap'е вызывают GigaChat.auth.requireAuth():
  //   - токен есть и verify прошёл → запускают свой UI
  //   - токена нет ИЛИ verify провалился → редирект на login.html?return=<url>
  //
  // Ключи в localStorage:
  //   gigachat_token    — session-token (64 hex символа)
  //   gigachat_username — имя юзера (для отображения в header'е)
  //
  // Миграция со старых ключей planner_token/planner_username делается
  // прозрачно — при первом чтении старые значения копируются под новыми
  // именами, дальше работа идёт только с gigachat_*.
  var AUTH_TOKEN_KEY = 'gigachat_token';
  var AUTH_USERNAME_KEY = 'gigachat_username';
  var AUTH_LEGACY_TOKEN_KEY = 'planner_token';
  var AUTH_LEGACY_USERNAME_KEY = 'planner_username';
  // A4 fix: _authMigrated убран — миграция выполняется при каждом get-call.
  // Идемпотентна (если в новом ключе уже что-то есть — ничего не делает),
  // но защищает от ситуации когда legacy-ключ заполнен после первого get.

  function _migrateLegacyAuthKeys() {
    try {
      var newTok = localStorage.getItem(AUTH_TOKEN_KEY);
      if (!newTok) {
        var oldTok = localStorage.getItem(AUTH_LEGACY_TOKEN_KEY);
        if (oldTok) localStorage.setItem(AUTH_TOKEN_KEY, oldTok);
      }
      var newName = localStorage.getItem(AUTH_USERNAME_KEY);
      if (!newName) {
        var oldName = localStorage.getItem(AUTH_LEGACY_USERNAME_KEY);
        if (oldName) localStorage.setItem(AUTH_USERNAME_KEY, oldName);
      }
    } catch (e) {}
  }

  function authGetToken() {
    _migrateLegacyAuthKeys();
    try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function authGetUsername() {
    _migrateLegacyAuthKeys();
    try { return localStorage.getItem(AUTH_USERNAME_KEY) || ''; } catch (e) { return ''; }
  }

  // ASCII-prefix для localStorage по имени юзера. Гарантия уникальности
  // для кириллицы — через btoa(UTF-8 bytes) (старая replace [^A-Za-z0-9_] → '_'
  // давала одинаковый prefix для 'Иванов' и 'Петров' — юзеры видели чужие
  // сессии). Используется как user-namespace во всех агентах: sessionStore
  // prefix, settings localStorage и т.п.
  //
  // BUG-FIX 2026-05-26: жёсткий потолок 20 символов. Раньше base64 от длинного
  // кириллического имени (>9 букв) давал префикс >25, после склейки с
  // agentPrefix + uuid32 итоговый session_id превышал 64 символа, бэкенд
  // отвечал «session_id содержит недопустимые символы». Теперь: берём первые
  // 12 символов base64 (различает короткие имена) + 8 hex от полного хэша
  // (различает имена с одинаковым b64-началом). Всегда ровно ≤20 символов
  // ASCII, итоговый session_id ≤ 6 (prompt) + 1 + 20 + 1 + 32 = 60 char.
  function authUserPrefix(name) {
    var s = String(name == null ? authGetUsername() : name);
    if (!s) return 'anon';
    // Простой быстрый хэш — используем и в b64-ветке (для суффикса),
    // и в fallback'е.
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    var hashHex = ('00000000' + (h >>> 0).toString(16)).slice(-8);
    try {
      var bytes = new TextEncoder().encode(s);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      var b64 = btoa(bin).replace(/[^A-Za-z0-9]/g, '');
      if (b64) {
        // Если короткое — используем как есть; если длинное — первые 12 + 8 hex.
        return b64.length <= 20 ? b64 : (b64.slice(0, 12) + hashHex);
      }
    } catch (e) { /* fallback ниже */ }
    return 'u' + hashHex;
  }
  function authSetAuth(token, username) {
    try {
      localStorage.setItem(AUTH_TOKEN_KEY, token || '');
      localStorage.setItem(AUTH_USERNAME_KEY, username || '');
      // Legacy-ключи синхронизируем для обратной совместимости со страницами,
      // которые ещё могут читать planner_token напрямую (на случай если что-то
      // не отрефакторено). Когда все агенты переедут — можно удалить.
      localStorage.setItem(AUTH_LEGACY_TOKEN_KEY, token || '');
      localStorage.setItem(AUTH_LEGACY_USERNAME_KEY, username || '');
    } catch (e) {}
  }
  function authClearAuth() {
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_USERNAME_KEY);
      localStorage.removeItem(AUTH_LEGACY_TOKEN_KEY);
      localStorage.removeItem(AUTH_LEGACY_USERNAME_KEY);
    } catch (e) {}
  }

  // POST в /webhook/planner-auth. payload — {action, ...}. Не бросает.
  // Возвращает {response:'ok'|'error', ...} или {response:'error', network:true}.
  async function authApiCall(payload) {
    try {
      var res = await fetch(webhookUrl('planner-auth'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload || {}),
      });
      if (!res.ok) return { response: 'error' };
      return await res.json();
    } catch (e) {
      if (console && console.warn) console.warn('[auth] api error', e);
      return { response: 'error', network: true };
    }
  }

  async function authVerifyToken(token) {
    var t = token || authGetToken();
    if (!t) return { ok: false, reason: 'no_token' };
    // Баг 1: при заходе на агент СРАЗУ после login.html изредка первая попытка
    // verify уходит до того, как n8n/Postgres «увидели» последний UPDATE
    // last_used_at от login. Тогда первый verify возвращает ok, но во время
    // запроса юзера сюда уже мог попасть SSO-rotate (например, авто-refresh
    // токена), и юзер видит «выкидывает с сессии одноразово».
    // Простой retry с задержкой устраняет это: первая 401-выглядящая попытка
    // ретраится через 600ms. Затраты ~600ms задержки в худшем случае.
    for (var attempt = 0; attempt < 2; attempt++) {
      var data = await authApiCall({ action: 'verify', token: t });
      if (data.response === 'ok' && !data.auth_required) {
        return { ok: true, username: data.username || authGetUsername() };
      }
      // Network error ИЛИ auth_required на ПЕРВОЙ попытке — даём один шанс.
      if (attempt === 0) {
        await new Promise(function (r) { setTimeout(r, 600); });
        continue;
      }
      return { ok: false, reason: 'invalid', network: !!data.network };
    }
    return { ok: false, reason: 'invalid' };
  }

  // Считает путь до login.html относительно текущей страницы.
  // login.html лежит в корне проекта (рядом с GigaChat-Platform.html).
  // Дашборд и login.html — оба в корне → 'login.html'.
  // Агенты в Agents/ → '../login.html'.
  function _loginHref() {
    var p = location.pathname.replace(/\\/g, '/');
    if (p.indexOf('/Agents/') !== -1) return '../login.html';
    return 'login.html';
  }

  function authRedirectToLogin(opts) {
    opts = opts || {};
    var url = _loginHref();
    var ret = opts.returnTo || location.href;
    url += '?return=' + encodeURIComponent(ret);
    if (opts.replace) location.replace(url);
    else location.href = url;
  }

  // Главный auth-gate для защищённых страниц.
  // opts.onOk(username) — вызывается если верификация прошла.
  // opts.onFail — вызывается перед редиректом (можно отменить, вернув false).
  // opts.allowOffline — true: при network-ошибке НЕ редиректить, дать onOk
  //                     (рассчитываем, что серверные запросы потом сами 401-нут).
  async function authRequireAuth(opts) {
    opts = opts || {};
    var res = await authVerifyToken();
    if (res.ok) {
      // Обновим username если сервер вернул свежий
      if (res.username) {
        try { localStorage.setItem(AUTH_USERNAME_KEY, res.username); } catch (e) {}
      }
      if (typeof opts.onOk === 'function') opts.onOk(res.username || authGetUsername());
      return true;
    }
    // Сеть отвалилась — если страница допускает offline-режим, не редиректим.
    // A6: username из cache МОЖЕТ быть устаревшим (cached от прошлой сессии),
    // если миграция planner_username отработала криво. Caller должен понимать
    // что это «best effort» и не показывать имя как авторитетное (например,
    // дописать «(оффлайн)»). Сейчас опция нигде не включена.
    if (res.network && opts.allowOffline) {
      if (console && console.warn) console.warn('[auth] offline mode — username может быть устаревшим');
      if (typeof opts.onOk === 'function') opts.onOk(authGetUsername());
      return true;
    }
    if (res.reason === 'invalid') authClearAuth();
    if (typeof opts.onFail === 'function') {
      var ret = opts.onFail(res);
      if (ret === false) return false; // caller сам разобрался
    }
    authRedirectToLogin({ replace: true });
    return false;
  }

  // Logout — серверный invalidate сессии + локальная очистка + редирект.
  // ВАЖНО: всегда location.replace (не href) — иначе юзер жмёт Back в браузере
  // и попадает обратно в защищённую страницу URL без токена → requireAuth →
  // редирект на login → Back → loop в истории.
  async function authLogout(opts) {
    opts = opts || {};
    var token = authGetToken();
    if (token) {
      // Fire-and-forget — даже если сеть упала, всё равно чистим локально
      try { await authApiCall({ action: 'logout', token: token }); } catch (e) {}
    }
    authClearAuth();
    if (opts.redirect === false) return;
    // По умолчанию редиректим на дашборд (юзер всё равно увидит «Войти»)
    var dashHref = location.pathname.replace(/\\/g, '/').indexOf('/Agents/') !== -1
      ? '../GigaChat-Platform.html'
      : 'GigaChat-Platform.html';
    location.replace(opts.redirectTo || dashHref);
  }

  // A5 fix: cross-tab logout sync. Юзер логаутится во вкладке A → вкладка B
  // (на любом агенте) ловит storage event и редиректит на login. Иначе вкладка
  // B продолжала бы работать со старым cached token до следующего apiCall.
  // Срабатывает только когда токен явно удалён (newValue === null), не на set.
  // Не реагирует если страница уже на login.html (не зацикливаемся).
  global.addEventListener('storage', function (e) {
    if (!e || e.key !== AUTH_TOKEN_KEY) return;
    if (e.newValue) return;  // login в другой вкладке — не trigger
    // На login.html — игнорируем (мы уже там)
    if (location.pathname.replace(/\\/g, '/').indexOf('/login.html') !== -1) return;
    if (location.pathname.replace(/\\/g, '/').endsWith('/login.html')) return;
    // На дашборде — просто reload (он сам редиректнет через requireAuth)
    // На агентах — redirect на login
    authRedirectToLogin({ replace: true });
  });

  // Безопасный return-url из query (?return=...). Принимаем ТОЛЬКО относительные
  // или same-origin абсолютные. Иначе — фолбэк на дашборд (защита от open-redirect).
  function authParseReturnUrl(fallback) {
    var fb = fallback || 'GigaChat-Platform.html';
    try {
      var qs = new URLSearchParams(location.search);
      var raw = qs.get('return');
      if (!raw) return fb;
      // Абсолютный URL — должен быть same-origin
      try {
        var u = new URL(raw, location.href);
        if (u.origin !== location.origin) return fb;
        return u.pathname + u.search + u.hash;
      } catch (e) {
        // Относительный — отдаём как есть, но без protocol-relative //evil.com
        if (raw.charAt(0) === '/' && raw.charAt(1) === '/') return fb;
        return raw;
      }
    } catch (e) { return fb; }
  }

  function escapeHtml(text) {
    if (text == null) return '';
    var div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  // fetch с таймаутом и повторами. opts: { timeout, retries, retryDelay }
  // ВАЖНО: при AbortError (таймаут) НЕ повторяем — сервер уже мог принять запрос
  // и продолжает его обрабатывать (особенно опасно для долгих OCR/embed).
  // Повтор делается только на сетевых ошибках (отказ соединения и т.п.).
  async function fetchWithRetry(url, options, opts) {
    opts = opts || {};
    var timeout = opts.timeout || FETCH_TIMEOUT_MS;
    var retries = (opts.retries == null) ? MAX_RETRIES : opts.retries;
    var retryDelay = opts.retryDelay || RETRY_DELAY_MS;
    var externalSignal = opts.signal || null;

    var lastErr = null;
    for (var attempt = 0; attempt <= retries; attempt++) {
      var controller = new AbortController();
      var tid = setTimeout(function () { controller.abort(); }, timeout);
      // Внешний signal (например юзер нажал «отмена») → внутренний controller
      // тоже abort'ится, fetch падает с AbortError. Если уже aborted на старте —
      // сразу abort внутренний.
      var onExternalAbort = null;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort();
        } else {
          onExternalAbort = function () { controller.abort(); };
          externalSignal.addEventListener('abort', onExternalAbort);
        }
      }
      try {
        var res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
        clearTimeout(tid);
        if (onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
        return res;
      } catch (e) {
        clearTimeout(tid);
        if (onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
        lastErr = e;
        // Юзер отменил — пробрасываем как есть, ретраи не делаем.
        if (externalSignal && externalSignal.aborted) {
          var abortErr = new Error('Запрос отменён');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        // Таймаут — сразу выходим, не плодим параллельные запросы.
        if (e.name === 'AbortError') {
          // R8.60: таймаут запроса к агенту = LLM (GigaChat) не ответил.
          // Помечаем флагом, чтобы sendMsg показал чистое сообщение без «Ошибка:».
          var _te = new Error('GigaChat не отвечает. Проверьте подключение.');
          _te.isTimeout = true;
          throw _te;
        }
        // Сетевая ошибка — пробуем ещё. Sleep между ретраями ДОЛЖЕН быть
        // прерываемым: иначе юзер нажал «отмена» в момент backoff —
        // AbortError не пробрасывается до конца retryDelay (3 сек), и UI
        // «зависает» до конца паузы. Решение: race timer + abort-listener.
        if (attempt < retries) {
          await new Promise(function (resolve, reject) {
            var tid2 = setTimeout(resolve, retryDelay);
            if (externalSignal) {
              var onAbort2 = function () {
                clearTimeout(tid2);
                externalSignal.removeEventListener('abort', onAbort2);
                var err = new Error('Запрос отменён');
                err.name = 'AbortError';
                reject(err);
              };
              if (externalSignal.aborted) { onAbort2(); return; }
              externalSignal.addEventListener('abort', onAbort2);
            }
          });
          continue;
        }
        throw e;
      }
    }
    // Цикл может выйти только через return/throw выше, но для строгости:
    throw lastErr || new Error('fetchWithRetry: исчерпаны попытки');
  }

  // Health-check конкретного workflow'а через его webhook. Каждый агент
  // и инструмент имеет свой ping-обработчик: либо ранний возврат в коде
  // валидации (chat-агенты с if (message==='ping')), либо отдельная
  // Ping?-IF нода после Webhook (4 tool-workflow'а: OCR, document-loader,
  // text-extractor, table-merger-excel). Router возвращает pong на любой POST.
  //
  // Шлём: POST {webhookUrl}?ping=1 с body {"message":"ping"} — оба
  // условия покрывают любой ping-обработчик. n8n возвращает:
  //   - 200 + JSON, если workflow активен (response может быть 'pong'
  //     или строкой ошибки валидации — нам важен только статус)
  //   - 404, если workflow отключен/не зарегистрирован
  //   - сетевая ошибка / таймаут, если n8n офлайн или DNS не отвечает
  //
  // Раньше пинговали /healthz n8n-ядра. Это работало, но не отражало
  // статус конкретного workflow'а: пользователь отключал math-workflow,
  // а индикатор по-прежнему «онлайн». Теперь каждый агент знает свой
  // реальный статус.
  function checkServerStatus(url, dotEl, textEl, opts) {
    opts = opts || {};
    var labels = opts.labels || { online: 'Онлайн', offline: 'Офлайн', checking: 'проверка...' };
    var dotClass = opts.dotClass || 'dot';
    if (dotEl) dotEl.className = dotClass + ' checking';
    if (textEl) textEl.textContent = labels.checking;

    if (!url) {
      // Без webhook'а пинговать нечего — считаем оффлайн.
      if (dotEl) dotEl.className = dotClass + ' offline';
      if (textEl) textEl.textContent = labels.offline;
      return Promise.resolve(false);
    }

    function pingOnce() {
      var controller = new AbortController();
      var tid = setTimeout(function () { controller.abort(); }, PING_TIMEOUT_MS);
      var pingUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'ping=1';
      return fetch(pingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: '{"message":"ping"}',
        signal: controller.signal
      })
        .then(function (res) { clearTimeout(tid); return res.ok; })
        .catch(function (e) { clearTimeout(tid); throw e; });
    }

    // Один retry через 2 сек на случай сетевой моргнулки. Без него одна
    // потерянная пакета → "Офлайн" на весь 30-секундный интервал между
    // следующими ping'ами → юзер думает, что workflow упал.
    // НО: на AbortError (таймаут 5 сек) не retry'им — сервер реально
    // мёртв или сильно перегружен, retry просто добавит +2 сек к "Офлайн".
    // На res.ok===false (404) тоже не retry'им — workflow отключен,
    // повтор ничего не изменит.
    return pingOnce()
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw err;
        return new Promise(function (r) { setTimeout(r, 2000); }).then(pingOnce);
      })
      .then(function (ok) {
        if (ok) {
          if (dotEl) dotEl.className = dotClass + ' online';
          if (textEl) textEl.textContent = labels.online;
          return true;
        }
        if (dotEl) dotEl.className = dotClass + ' offline';
        if (textEl) textEl.textContent = labels.offline;
        return false;
      })
      .catch(function () {
        if (dotEl) dotEl.className = dotClass + ' offline';
        if (textEl) textEl.textContent = labels.offline;
        return false;
      });
  }

  // Запускает периодический health-check со встроенным lifecycle-управлением.
  // Раньше каждый агент звал setInterval(checkServerStatus, 30000) без cleanup,
  // и при BFCache (history.back в Firefox/Safari) интервалы дублировались.
  // Эта функция:
  //   - Делает первый ping сразу + затем по интервалу
  //   - На pagehide останавливает таймер (страница ушла в BFCache)
  //   - На pageshow возобновляет, если страница вернулась
  //   - Возвращает stop() — для ручной остановки если нужно
  function startHealthCheck(url, dotEl, textEl, opts) {
    opts = opts || {};
    var interval = opts.intervalMs || 30000;
    var timerId = null;
    var stopped = false;

    function tick() { checkServerStatus(url, dotEl, textEl, opts); }
    function start() {
      if (timerId || stopped) return;
      tick();
      timerId = setInterval(tick, interval);
    }
    function pause() {
      if (timerId) { clearInterval(timerId); timerId = null; }
    }
    function stop() {
      stopped = true;
      pause();
      global.removeEventListener('pagehide', pause);
      global.removeEventListener('pageshow', start);
    }

    global.addEventListener('pagehide', pause);
    global.addEventListener('pageshow', start);
    start();

    return { stop: stop };
  }

  // Markdown-таблица → HTML <table>. Должна работать ДО конвертации \n в <br>.
  function formatMarkdownTable(text) {
    return text.replace(/((.+\|)\n(\|[-:\| ]+\|)\n((.+\|\n?)+))/g, function (match) {
      var rows = match.trim().split('\n');
      var table = '<table>';
      for (var i = 0; i < rows.length; i++) {
        if (i === 1) continue;
        var cells = rows[i].split('|').filter(function (c) { return c.trim() !== ''; });
        var tag = i === 0 ? 'th' : 'td';
        table += '<tr>';
        for (var j = 0; j < cells.length; j++) table += '<' + tag + '>' + cells[j].trim() + '</' + tag + '>';
        table += '</tr>';
      }
      return table + '</table>';
    });
  }

  // Markdown → HTML (заголовки, code, **bold**, *italic*, списки, ---, таблицы, переносы строк).
  // accentColor — цвет заголовков, чтобы агент сохранял свой стиль. Валидируем
  // как hex-цвет (#rgb/#rrggbb/#rrggbbaa) — иначе подмена через accentColor
  // даёт CSS-инъекцию ("};background:url(javascript:...)").
  function formatMarkdown(text, accentColor) {
    if (!text) return '';
    accentColor = (typeof accentColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(accentColor))
      ? accentColor : '#7c3aed';
    var html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 1) Защищаем блоки кода плейсхолдерами, чтобы \n внутри них не превращались в <br>.
    var codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (m, l, c) {
      var idx = codeBlocks.length;
      codeBlocks.push('<pre><code>' + c.trim() + '</code></pre>');
      return 'CB' + idx + '';
    });

    // 2) Markdown-таблицы → HTML (до конвертации \n в <br>, регулярка зависит от \n).
    html = formatMarkdownTable(html);

    // 3) Заголовки, жирный, курсив, инлайн-код, списки, hr.
    html = html.replace(/^#### (.+)$/gm, '<b style="font-size:14px;color:' + accentColor + '">$1</b>');
    html = html.replace(/^### (.+)$/gm, '<b style="font-size:15px;color:' + accentColor + '">$1</b>');
    html = html.replace(/^## (.+)$/gm, '<b style="font-size:16px;color:' + accentColor + '">$1</b>');
    html = html.replace(/^# (.+)$/gm, '<b style="font-size:18px;color:' + accentColor + '">$1</b>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    html = html.replace(/^- (.+)$/gm, '  • $1');
    html = html.replace(/^---$/gm, '<hr>');

    // 4) Переносы строк \n → <br>.
    html = html.replace(/\n/g, '<br>');

    // 5) Убираем лишние <br> вокруг блочных элементов (таблицы, hr).
    html = html.replace(/(<\/?(?:table|thead|tbody|tr|th|td)>)\s*<br>/g, '$1');
    html = html.replace(/<br>\s*(<\/?(?:table|thead|tbody|tr|th|td)>)/g, '$1');
    html = html.replace(/<hr><br>/g, '<hr>');

    // 6) Восстанавливаем блоки кода (их \n браузер сам сохранит внутри <pre>).
    html = html.replace(/CB(\d+)/g, function (m, i) {
      return codeBlocks[parseInt(i, 10)];
    });
    return html;
  }

  // ============================================================
  // ТЕМЫ — светлая (по умолчанию для нового юзера) и тёмная
  // ============================================================
  // Палитра задаётся inline в каждой HTML через :root и
  // :root[data-theme="light"]. Здесь — только переключение
  // data-theme + sync hljs-CSS + плавающая кнопка в углу страницы.
  // Чтобы избежать FOUC, в head каждой страницы стоит inline-скрипт,
  // который читает localStorage и ставит data-theme ДО парсинга CSS.

  var THEME_STORAGE_KEY = 'giga_theme';
  var SUN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>';
  var MOON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }

  function syncHljsTheme() {
    var dark = document.getElementById('hljs-theme-dark');
    var light = document.getElementById('hljs-theme-light');
    var isDark = getCurrentTheme() === 'dark';
    if (dark) dark.disabled = !isDark;
    if (light) light.disabled = isDark;
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (e) {}
    updateThemeToggleIcon();
    syncHljsTheme();
  }

  function toggleTheme() {
    applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark');
  }

  function updateThemeToggleIcon() {
    var btn = document.getElementById('gc-theme-toggle');
    if (!btn) return;
    var isDark = getCurrentTheme() === 'dark';
    btn.innerHTML = isDark ? SUN_SVG : MOON_SVG;
    btn.setAttribute('aria-label', isDark ? 'Светлая тема' : 'Тёмная тема');
    btn.setAttribute('title', isDark ? 'Светлая тема' : 'Тёмная тема');
  }

  function initThemeToggle() {
    if (document.getElementById('gc-theme-toggle')) return;
    if (!document.getElementById('gc-theme-toggle-css')) {
      var style = document.createElement('style');
      style.id = 'gc-theme-toggle-css';
      style.textContent =
        // --bg-hover — фон для hover-state на иконках (скрепка, отправка,
        // карандаш, крестик). Меняется по теме: на тёмной — белый 6%,
        // на светлой — чёрный 5%, чтобы оставаться видимым.
        ':root{--bg-hover:rgba(255,255,255,0.06)}' +
        ':root[data-theme="light"]{--bg-hover:rgba(0,0,0,0.05)}' +
        // Резерв места под кнопку темы в header'ах агентов и tool-страниц,
        // чтобы Экспорт/статус не уходили под кнопку. prompt-engineer
        // использует <div class="header"> внутри .main вместо <header> —
        // покрываем оба варианта.
        'header,.main > .header{padding-right:60px !important}' +
        // Hover на карандаш/крест внутри session-item: используем bg-hover,
        // он гарантированно отличается от bg-secondary (фон самого item на hover).
        '.session-item .edit:hover,.session-item .close:hover{background:var(--bg-hover) !important;color:var(--accent) !important;opacity:1 !important}' +
        // Плавающая кнопка. top задаётся динамически в positionThemeToggle()
        // под центр .btn-export (агенты) или header h1 (tools) — дефолт 10px
        // на случай если якоря на странице нет (например, дашборд).
        '#gc-theme-toggle{position:fixed;top:10px;right:14px;z-index:9999;' +
        'width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;' +
        'background:var(--bg-secondary);border:1px solid var(--border);border-radius:50%;' +
        'color:var(--text-secondary);cursor:pointer;padding:0;' +
        'transition:background .15s,color .15s,border-color .15s,transform .15s}' +
        '#gc-theme-toggle:hover{background:var(--bg-hover);color:var(--accent);' +
        'border-color:var(--accent);transform:rotate(15deg)}' +
        '#gc-theme-toggle svg{width:16px;height:16px;stroke:currentColor;fill:none;' +
        'stroke-width:2;stroke-linecap:round;stroke-linejoin:round}';
      document.head.appendChild(style);
    }
    var btn = document.createElement('button');
    btn.id = 'gc-theme-toggle';
    btn.type = 'button';
    btn.onclick = toggleTheme;
    document.body.appendChild(btn);
    updateThemeToggleIcon();
    positionThemeToggle();
    global.addEventListener('resize', positionThemeToggle);
  }

  // Выравнивает toggle по вертикали под центр кнопки «Экспорт» (чат-агенты)
  // или под центр заголовка h1 в header'е (tool-страницы). Если на странице
  // нет ни одного якоря (например, дашборд) — оставляет дефолтный top из CSS.
  function positionThemeToggle() {
    var btn = document.getElementById('gc-theme-toggle');
    if (!btn) return;
    var anchor = document.querySelector('.btn-export')
              || document.querySelector('header h1, .main > .header h1');
    if (!anchor) return;
    var rect = anchor.getBoundingClientRect();
    if (rect.height === 0) return;
    var top = Math.max(4, Math.round(rect.top + rect.height / 2 - btn.offsetHeight / 2));
    btn.style.top = top + 'px';
  }

  // Cross-tab синхронизация темы: переключил в одной вкладке — все вкладки следуют.
  global.addEventListener('storage', function (e) {
    if (e.key !== THEME_STORAGE_KEY || !e.newValue) return;
    if (e.newValue !== getCurrentTheme()) {
      document.documentElement.setAttribute('data-theme', e.newValue);
      updateThemeToggleIcon();
      syncHljsTheme();
    }
  });

  function applyHighlight(container) {
    if (typeof global.hljs === 'undefined') return;
    var scope = container || document;
    var blocks = scope.querySelectorAll('pre code:not(.hljs)');
    for (var i = 0; i < blocks.length; i++) {
      try { global.hljs.highlightElement(blocks[i]); } catch (e) {}
    }
  }

  // R8.57/R8.58: единый футер сайдбара с именем аккаунта (для ВСЕХ агентов).
  // Правила: (1) если имя длиннее 18 символов (с пробелами) — показываем
  // только ПЕРВОЕ слово целиком, иначе имя как есть; (2) если итоговое слово
  // длиннее 20 символов — обрезаем после 20-го и ставим "..." без пробела.
  function formatAccountName(name) {
    name = String(name == null ? '' : name).trim();
    if (!name) return '';
    var result = name;
    if (name.length > 18) {
      result = name.split(/\s+/)[0] || name;
    }
    if (result.length > 20) {
      result = result.slice(0, 20) + '...';
    }
    return result;
  }
  // Гарантирует .sidebar-footer (линия-разделитель) с .sidebar-account слева.
  // У Plane футер уже есть (+ кнопка «Команды» справа) — туда добавляем имя
  // слева. У остальных агентов футера нет — создаём.
  function ensureSidebarAccount() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    var footer = sidebar.querySelector('.sidebar-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'sidebar-footer';
      sidebar.appendChild(footer);
    }
    var acc = footer.querySelector('.sidebar-account');
    if (!acc) {
      acc = document.createElement('span');
      acc.className = 'sidebar-account';
      footer.insertBefore(acc, footer.firstChild);
    }
    var full = '';
    try { full = authGetUsername() || ''; } catch (e) {}
    acc.textContent = formatAccountName(full);
    if (full) acc.title = full;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      syncHljsTheme();
      initThemeToggle();
      ensureSidebarAccount();
    });
  } else {
    syncHljsTheme();
    initThemeToggle();
    ensureSidebarAccount();
  }

  // ============================================================
  // ГЛОБАЛЬНЫЙ ERROR HANDLER — страховка от молчаливого падения
  // ============================================================
  // Без этого любая uncaught ошибка в renderChat/sendMsg/typewriter
  // оставляет страницу в зависшем состоянии без объяснения. С этим
  // — юзер видит toast "Ошибка: X — Перезагрузить" вместо тишины.
  // Не ловим всё подряд: лимит 1 alert в 10 сек, чтобы не спамить
  // при cascading failures.
  var lastErrorAt = 0;
  function reportError(source, err) {
    var now = Date.now();
    if (now - lastErrorAt < 10000) return; // дедуп — не более раза в 10 сек
    lastErrorAt = now;
    var msg = (err && err.message) || String(err) || 'Неизвестная ошибка';
    if (console && console.error) console.error('[GigaChat ' + source + ']', err);
    // showToast может ещё не быть определён если ошибка в самом раннем init.
    if (typeof showToast === 'function') {
      showToast('Ошибка: ' + msg + ' — попробуйте перезагрузить страницу.', 'error');
    }
  }
  global.addEventListener('error', function (e) {
    // Игнорируем ошибки с других origin'ов (cross-origin scripts) — для них
    // e.message обычно "Script error." и нам нечего сообщить юзеру.
    if (!e || e.message === 'Script error.') return;
    // Игнорируем ошибки из расширений браузера (chrome-extension://, etc.)
    // и сторонних доменов — это не наш баг, юзер ничего сделать не сможет.
    if (e.filename) {
      var fname = String(e.filename);
      var ourOrigin = location.origin;
      var sameOrigin = fname.indexOf(ourOrigin) === 0 || fname.indexOf('://') === -1;
      if (!sameOrigin) return;
    }
    reportError('window.error', e.error || e.message);
  });
  global.addEventListener('unhandledrejection', function (e) {
    if (!e) return;
    var reason = e.reason;
    // AbortError — не баг, юзер сам отменил.
    if (reason && reason.name === 'AbortError') return;
    reportError('unhandledrejection', reason);
  });

  // ============================================================
  // TOAST — короткие уведомления внизу экрана
  // ============================================================
  // Используется для quota-warning, network-fail, fatal-init и т.д.
  // Один toast стоит ~4 сек, потом fade-out. Несколько подряд кладутся
  // в стек снизу вверх.
  function showToast(text, kind) {
    if (!document.getElementById('gc-toast-css')) {
      var style = document.createElement('style');
      style.id = 'gc-toast-css';
      style.textContent =
        '#gc-toast-stack{position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none;max-width:calc(100vw - 40px)}' +
        '.gc-toast{background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:10px 16px;font-size:13px;line-height:1.4;box-shadow:0 4px 12px rgba(0,0,0,0.15);pointer-events:auto;max-width:380px;animation:gcToastIn .2s ease}' +
        '.gc-toast.warn{border-left-color:#f59e0b;background:rgba(245,158,11,0.08)}' +
        '.gc-toast.error{border-left-color:#ef4444;background:rgba(239,68,68,0.08)}' +
        '.gc-toast.fade{opacity:0;transition:opacity .25s}' +
        '@keyframes gcToastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}';
      document.head.appendChild(style);
    }
    var stack = document.getElementById('gc-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'gc-toast-stack';
      document.body.appendChild(stack);
    }
    var toast = document.createElement('div');
    toast.className = 'gc-toast' + (kind ? ' ' + kind : '');
    toast.textContent = text;
    stack.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('fade');
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 250);
    }, 4000);
  }

  // ============================================================
  // БРАУЗЕРНЫЕ ПАРСЕРЫ — извлечение текста БЕЗ OCR
  // ============================================================
  // docx, xlsx, txt/md/log/csv парсим прямо в браузере через JSZip
  // и DOMParser. Это в 10-100 раз быстрее OCR и не нагружает n8n.
  // Требует подключённый jszip.min.js (для docx/xlsx). Для txt-like
  // достаточно нативного file.text().

  function fileExt(name) {
    return (name || '').split('.').pop().toLowerCase();
  }

  function canExtractInBrowser(name) {
    var ext = fileExt(name);
    // docx/xlsx требуют JSZip. txt-like — нет.
    if (ext === 'docx' || ext === 'xlsx' || ext === 'xlsm') {
      return typeof global.JSZip !== 'undefined';
    }
    return ['txt','md','log','csv'].indexOf(ext) !== -1;
  }

  async function extractDocxText(file) {
    var buf = await file.arrayBuffer();
    var zip = await global.JSZip.loadAsync(buf);
    var xmlFile = zip.file('word/document.xml');
    if (!xmlFile) throw new Error('В .docx нет word/document.xml — файл повреждён.');
    var xml = await xmlFile.async('string');
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var pe = doc.getElementsByTagName('parsererror')[0];
    if (pe) throw new Error('Не удалось разобрать XML в .docx');

    // Утилита: суффикс XML-тега без namespace.
    // tagName в DOMParser/XML сохраняет полный префикс ('w:p', 'w:tbl').
    function tagSuffix(el) {
      var t = el.tagName || '';
      var i = t.indexOf(':');
      return i === -1 ? t : t.substring(i + 1);
    }

    // Текст одного параграфа: собираем w:t (текст) + w:tab (\t) + w:br (\n).
    // Идём по всем потомкам, чтобы поймать вложенные runs внутри hyperlinks и т.п.
    function paragraphText(p) {
      var nodes = p.getElementsByTagName('*');
      var line = '';
      for (var i = 0; i < nodes.length; i++) {
        var s = tagSuffix(nodes[i]);
        if (s === 't') line += nodes[i].textContent || '';
        else if (s === 'tab') line += '\t';
        else if (s === 'br') line += '\n';
      }
      return line;
    }

    // Текст одной ячейки таблицы (w:tc): склеиваем параграфы через пробел
    // (а не через \n — внутри ячейки переносы сломают TSV-структуру строки).
    function cellText(tc) {
      var paras = tc.getElementsByTagName('w:p');
      var bits = [];
      for (var i = 0; i < paras.length; i++) {
        var t = paragraphText(paras[i]).replace(/\s+/g, ' ').trim();
        if (t) bits.push(t);
      }
      return bits.join(' ');
    }

    // Таблица → TSV: каждая строка w:tr — это \t-разделённые ячейки w:tc.
    function tableText(tbl) {
      var rows = [];
      var trs = tbl.getElementsByTagName('w:tr');
      for (var i = 0; i < trs.length; i++) {
        var tcs = trs[i].getElementsByTagName('w:tc');
        var cells = [];
        for (var j = 0; j < tcs.length; j++) cells.push(cellText(tcs[j]));
        // Пропускаем полностью пустые строки.
        var has = false;
        for (var k = 0; k < cells.length; k++) if (cells[k]) { has = true; break; }
        if (has) rows.push(cells.join('\t'));
      }
      return rows.join('\n');
    }

    // Обходим только верхнеуровневые блоки body (параграфы и таблицы),
    // НЕ рекурсивно — иначе параграфы внутри таблиц задвоятся (как было
    // раньше с getElementsByTagName('w:p')).
    var body = doc.getElementsByTagName('w:body')[0];
    if (!body) return '';
    var blocks = [];
    var children = body.childNodes;
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node.nodeType !== 1) continue;
      var s = tagSuffix(node);
      if (s === 'p') {
        var pText = paragraphText(node);
        if (pText) blocks.push(pText);
      } else if (s === 'tbl') {
        var tText = tableText(node);
        if (tText) blocks.push(tText);
      }
    }
    return blocks.join('\n');
  }

  async function extractXlsxText(file) {
    var buf = await file.arrayBuffer();
    var zip = await global.JSZip.loadAsync(buf);

    // sharedStrings (если есть)
    var sharedStrings = [];
    var ssFile = zip.file('xl/sharedStrings.xml');
    if (ssFile) {
      var ssXml = await ssFile.async('string');
      var ssDoc = new DOMParser().parseFromString(ssXml, 'application/xml');
      var siList = ssDoc.getElementsByTagName('si');
      for (var i = 0; i < siList.length; i++) {
        var ts = siList[i].getElementsByTagName('t');
        var s = '';
        for (var j = 0; j < ts.length; j++) s += ts[j].textContent || '';
        sharedStrings.push(s);
      }
    }

    // Первый лист. Если sheet1.xml отсутствует (юзер удалил первый лист в Excel),
    // ищем все sheetN.xml и берём с минимальным N — иначе JSZip может вернуть
    // их в произвольном порядке, и каждый раз будет открываться другой лист.
    var sheetFile = zip.file('xl/worksheets/sheet1.xml');
    if (!sheetFile) {
      var sheets = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/);
      if (!sheets || sheets.length === 0) throw new Error('В .xlsx не найдено листов.');
      sheets.sort(function (a, b) {
        var na = parseInt((a.name.match(/sheet(\d+)\.xml$/) || [0,0])[1], 10);
        var nb = parseInt((b.name.match(/sheet(\d+)\.xml$/) || [0,0])[1], 10);
        return na - nb;
      });
      sheetFile = sheets[0];
    }
    var sheetXml = await sheetFile.async('string');
    var sheetDoc = new DOMParser().parseFromString(sheetXml, 'application/xml');
    var rows = sheetDoc.getElementsByTagName('row');

    var lines = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].getElementsByTagName('c');
      var cellTexts = [];
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        var type = cell.getAttribute('t');
        var value = '';
        if (type === 's') {
          var vEl = cell.getElementsByTagName('v')[0];
          if (vEl) {
            var idx = parseInt(vEl.textContent, 10);
            value = (sharedStrings[idx] != null) ? sharedStrings[idx] : '';
          }
        } else if (type === 'inlineStr') {
          var isEl = cell.getElementsByTagName('is')[0];
          if (isEl) {
            var its = isEl.getElementsByTagName('t');
            for (var k = 0; k < its.length; k++) value += its[k].textContent || '';
          }
        } else {
          var vEl2 = cell.getElementsByTagName('v')[0];
          value = vEl2 ? (vEl2.textContent || '') : '';
        }
        cellTexts.push(value);
      }
      var hasContent = false;
      for (var x = 0; x < cellTexts.length; x++) {
        if (String(cellTexts[x]).trim() !== '') { hasContent = true; break; }
      }
      if (hasContent) lines.push(cellTexts.join('\t'));
    }

    return lines.join('\n');
  }

  // Превращает TSV-текст (колонки через \t) в моноширинно-выровненную «таблицу».
  // Полезно для UI text-extractor — TSV технически правилен, но визуально жмётся.
  // Файл при скачивании можно отдавать в любом виде; результат padTabularText
  // предназначен только для отображения в textarea (моноширинный шрифт).
  // Параметр maxColWidth ограничивает ширину колонки, чтобы один очень длинный
  // абзац не растягивал всю строку.
  function padTabularText(text, maxColWidth) {
    if (!text || text.indexOf('\t') === -1) return text;
    var maxW = (typeof maxColWidth === 'number' && maxColWidth > 0) ? maxColWidth : 60;
    var lines = text.split('\n');
    var rows = [];
    for (var i = 0; i < lines.length; i++) rows.push(lines[i].split('\t'));
    var widths = [];
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < rows[r].length; c++) {
        var v = rows[r][c] == null ? '' : String(rows[r][c]);
        var len = Math.min(v.length, maxW);
        if (widths[c] == null || widths[c] < len) widths[c] = len;
      }
    }
    var out = [];
    for (var r2 = 0; r2 < rows.length; r2++) {
      var cells = rows[r2];
      var parts = [];
      for (var c2 = 0; c2 < cells.length; c2++) {
        var val = cells[c2] == null ? '' : String(cells[c2]);
        var w = widths[c2] || 0;
        if (val.length > w) {
          parts.push(val);
        } else {
          var pad = w - val.length;
          parts.push(val + new Array(pad + 1).join(' '));
        }
      }
      out.push(parts.join('  ').replace(/\s+$/, ''));
    }
    return out.join('\n');
  }

  async function extractBrowserText(file) {
    var ext = fileExt(file.name);
    if (ext === 'docx') return await extractDocxText(file);
    if (ext === 'xlsx' || ext === 'xlsm') return await extractXlsxText(file);
    if (['txt','md','log','csv'].indexOf(ext) !== -1) {
      return await file.text();
    }
    throw new Error('Расширение не поддерживается браузерным парсером: ' + ext);
  }

  // ============================================================
  // ВЛОЖЕНИЯ К СООБЩЕНИЯМ
  // ============================================================
  // Одна скрепка в поле ввода, один файл за раз, любой формат.
  // Под капотом текст извлекается через webhook /extract-text, затем
  // зашивается в сообщение разделителями [ВЛОЖЕНИЕ:filename]...[/ВЛОЖЕНИЕ].
  // На бэке (в SQL-узле «Сохранить вопрос») этот блок вырезается
  // регексом, в БД лежит «[прикреплён файл]».
  // CSS инжектится один раз при первом вызове setupAttachment.

  var ATTACH_CSS_INJECTED = false;
  function injectAttachCss() {
    if (ATTACH_CSS_INJECTED) return;
    ATTACH_CSS_INJECTED = true;
    var css = ''
      // Единое поле ввода всех 6 агентов: textarea с иконкой отправки ВНУТРИ
      // (правый нижний угол), а скрепка ВЫНЕСЕНА справа от поля и
      // выровнена по центру высоты. См. inputs section ниже.
      //
      // Скрепка плоская, без рамки, маленькая. Размеры 32×32 + margin-bottom:6px
      // зеркально с .gc-send-icon (bottom:6px внутри wrap), чтобы центры
      // обеих иконок совпадали по вертикали при flex-end в .gc-input-row.
      + '.gc-attach-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;margin-bottom:6px;background:transparent;border:none;border-radius:8px;color:var(--text-secondary);cursor:pointer;transition:all .15s;flex-shrink:0;padding:0}'
      + '.gc-attach-btn:hover:not(:disabled){color:var(--accent);background:var(--bg-hover)}'
      // pointer-events:none — гарантия что disabled-кнопка вообще не реагирует
      // на клики/тапы. На случай если CSS внешнего агента переопределит cursor.
      + '.gc-attach-btn:disabled{opacity:.35;cursor:not-allowed;pointer-events:none}'
      + '.gc-attach-btn.has-file{color:var(--accent)}'
      + '.gc-attach-btn svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
      // Обёртка textarea + иконка-отправки (иконка absolute в правом нижнем углу).
      // padding-right у textarea — место под иконку.
      + '.gc-input-wrap{position:relative;flex:1;display:flex;align-items:stretch;min-width:0}'
      + '.gc-input-wrap > textarea{flex:1;width:100%;padding-right:48px !important}'
      // R8.56: единая рамка поля ввода для ВСЕХ агентов. Толщина одинаковая
      // (1px) в обоих состояниях. До фокуса — рамка #3d3d3b. На фокусе —
      // #4a4a48 + мягкий едва заметный «неон» (box-shadow в акцентном тоне).
      // !important перебивает per-agent #msg / #msg:focus.
      + '.gc-input-wrap > textarea{border:1px solid #3d3d3b !important;transition:border-color .2s,box-shadow .2s !important}'
      + '.gc-input-wrap > textarea:focus{border-color:#4a4a48 !important;box-shadow:0 0 4px rgba(212,165,116,.07) !important}'
      // Кнопка-отправка как иконка внутри поля: квадратная, акцентный фон, ↵.
      + '.gc-send-icon{position:absolute;right:11px;bottom:6px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;background:transparent;color:var(--text-secondary);border:none;border-radius:8px;cursor:pointer;padding:0;transition:color .15s,background .15s,opacity .15s;z-index:2}'
      + '.gc-send-icon:hover:not(:disabled){color:var(--accent);background:var(--bg-hover)}'
      + '.gc-send-icon:disabled{opacity:.35;cursor:not-allowed;pointer-events:none}'
      // Стрелка — только stroke, fill принудительно none (чтобы не была
      // белой при возможных hover-стилях). Stop-квадрат рисуется тем же
      // currentColor через fill (отдельное правило ниже).
      + '.gc-send-icon svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
      + '.gc-send-icon svg rect{fill:none;stroke:currentColor}'
      // Внешний контейнер всего ряда: [wrap с textarea+send] + [скрепка].
      // align-items:flex-end — скрепка пришпилена к нижнему краю поля
      // (на одном уровне с кнопкой отправки), чтобы при растягивании
      // textarea она не уплывала в середину.
      + '.gc-input-row{display:flex;gap:8px;align-items:flex-end;width:100%}'
      // Чипы с именами файлов над input-area.
      + '.gc-attach-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 8px 0}'
      + '.gc-attach-chips:empty{display:none}'
      + '.gc-attach-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-input,#1b2230);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text-primary);max-width:280px}'
      + '.gc-attach-chip .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.gc-attach-chip .x{cursor:pointer;color:var(--text-secondary);font-size:14px;line-height:1;padding:0 2px;background:transparent;border:none;font-family:inherit}'
      + '.gc-attach-chip .x:hover,.gc-attach-chip .x:focus{color:#ff6666;outline:none}'
      + '.gc-attach-chip.error{border-color:#cc4444;color:#ff8888}'
      + '.gc-attach-chip.bot{background:var(--bg-hover)}'
      // Подсветка drop-зоны: пунктирная рамка + псевдо-overlay с
      // подсказкой. position:fixed (не absolute), чтобы оверлей не
      // уезжал со скроллом контейнера и не обрезался overflow'ом
      // родителя (#chat имеет overflow-y:auto). Текст ярко-синий
      // чтобы выделяться на фоне любых пользовательских сообщений
      // (которые иногда тоже peach-цвета).
      + '.gc-drop-active::after{content:"Отпустите, чтобы прикрепить файл";position:fixed;top:20px;left:20px;right:20px;bottom:20px;border:2px dashed #2563eb;border-radius:12px;background:rgba(37,99,235,0.06);display:flex;align-items:center;justify-content:center;color:#2563eb;font-size:18px;font-weight:600;pointer-events:none;z-index:9998;letter-spacing:0.5px;text-shadow:0 1px 2px rgba(255,255,255,0.6)}'
      // Переносы строк в user-сообщении должны сохраняться визуально.
      + '.msg.user, .msg-user-body{white-space:pre-wrap;word-wrap:break-word}'
      // Таймер в loader'е с отступом 10px от точек.
      + '.loading .timer{margin-left:10px}'
      // Copy-кнопка живёт ВНЕ .msg.user — справа от неё, 5px gap, низ
      // выровнен с низом .msg.user. Цвет иконки = текст в запросе (peach),
      // hover background = фон запроса (bg-user). Появляется при hover
      // на .msg.user. Возможно из-за position:absolute right:-27px она
      // выходит за пределы .msg.user — overflow:visible на родителях
      // позволяет это (но #chat имеет overflow-y:auto и overflow-x:visible
      // по умолчанию). На случай переполнения по ширине — padding-right
      // у #chat достаточный.
      + '.msg.user,.msg.bot{position:relative}'
      + '.gc-msg-copy{position:absolute;left:0;top:calc(100% + 2px);display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;background:transparent;border:none;border-radius:4px;color:var(--accent);cursor:pointer;opacity:0;transition:opacity .15s,background .15s}'
      + '.msg:hover .gc-msg-copy,.msg:focus-within .gc-msg-copy,.gc-msg-copy:focus{opacity:1}'
      + '.gc-msg-copy:hover{background:var(--bg-user)}'
      // На bot-msg иконка и hover-фон в нейтральных тонах: цвет = текст ответа,
      // hover-фон = generic bg-hover (а не peach как у user, чтобы не выглядело
      // как продолжение user-msg по цвету).
      + '.msg.bot .gc-msg-copy{color:var(--text-primary)}'
      + '.msg.bot .gc-msg-copy:hover{background:var(--bg-hover)}'
      + '.gc-msg-copy svg{width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
      + '.gc-msg-copy.copied{opacity:1}'
      // Время «N сек/мин назад» правее copy-btn. Показывается тоже только
      // на hover (как и copy). Цвет = text-muted, мелкий шрифт.
      + '.gc-msg-time{position:absolute;left:26px;top:calc(100% + 2px);line-height:20px;font-size:11px;color:var(--text-muted);opacity:0;transition:opacity .15s;white-space:nowrap;pointer-events:none}'
      + '.msg:hover .gc-msg-time{opacity:1}'
      + '';
    var style = document.createElement('style');
    style.setAttribute('data-gc-attach', '1');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Иконка скрепки (Feather paperclip)
  var PAPERCLIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

  // Иконка отправки (Feather corner-down-left — стрелка ↵). Используется как
  // содержимое .gc-send-icon кнопки внутри поля ввода.
  var SEND_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>';

  // Добавляет copy-кнопку под каждым user-сообщением (появляется при hover).
  // Иконка clipboard внутри элемента .msg.user, клик → копирует data-content
  // (берётся либо из data-attribute, либо из textContent самого блока).
  // Делается через MutationObserver — каждый раз когда renderMessages
  // перерисовывает чат, новые .msg.user получают кнопку.
  var COPY_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var COPIED_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

  // Форматирует «время назад» в коротком формате: «5 сек», «3 мин», «2 ч».
  function formatTimeSince(ts) {
    if (!ts) return '';
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return diff + ' сек назад';
    if (diff < 3600) return Math.floor(diff / 60) + ' мин назад';
    if (diff < 86400) return Math.floor(diff / 3600) + ' ч назад';
    return Math.floor(diff / 86400) + ' дн назад';
  }

  function attachCopyButtons(rootOrEl) {
    if (!rootOrEl) rootOrEl = document;
    // Принимаем либо контейнер (scope для querySelectorAll), либо одиночный
    // .msg элемент — typewriter вызывает с single-element после каждого
    // innerHTML rewrite чтобы вернуть copy/time на место.
    var msgs;
    if (rootOrEl.classList && rootOrEl.classList.contains('msg')) {
      msgs = [rootOrEl];
    } else {
      msgs = rootOrEl.querySelectorAll('.msg.user, .msg.bot');
    }
    for (var i = 0; i < msgs.length; i++) {
      var msg = msgs[i];
      if (!msg.querySelector('.gc-msg-copy')) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gc-msg-copy';
        btn.setAttribute('aria-label', 'Копировать');
        btn.innerHTML = COPY_ICON_SVG;
        msg.appendChild(btn);
      }
      // Если есть data-ts — добавляем .gc-msg-time правее copy-btn.
      var ts = parseInt(msg.getAttribute('data-ts'), 10);
      if (ts && !msg.querySelector('.gc-msg-time')) {
        var time = document.createElement('span');
        time.className = 'gc-msg-time';
        time.setAttribute('data-ts', String(ts));
        time.textContent = formatTimeSince(ts);
        msg.appendChild(time);
      }
    }
  }

  // Глобальный тикер для .gc-msg-time — обновляет текст каждые 30 сек,
  // чтобы «5 сек» превратилось в «1 мин» без перезагрузки. Один на страницу.
  if (!global.__gcMsgTimeTicker) {
    global.__gcMsgTimeTicker = setInterval(function () {
      var times = document.querySelectorAll('.gc-msg-time[data-ts]');
      for (var i = 0; i < times.length; i++) {
        var t = parseInt(times[i].getAttribute('data-ts'), 10);
        if (t) times[i].textContent = formatTimeSince(t);
      }
    }, 30000);
  }

  // Глобальный делегат: один listener на body, обрабатывает клики по
  // любой .gc-msg-copy. Копируется ТОЛЬКО введённый юзером текст —
  // из клона .msg.user вырезаются служебные элементы (copy-кнопка,
  // time-бэйдж, inflight-agent-бэйдж и чипы прикреплённых файлов с
  // именами). Содержимое самих файлов НЕ копируется (это поведение
  // by design — юзер просил видеть в буфере только свой ввод).
  if (!global.__gcCopyDelegate) {
    global.__gcCopyDelegate = true;
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.gc-msg-copy');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      // Поддерживаем оба типа сообщений — user и bot.
      var parent = btn.closest('.msg.user, .msg.bot');
      if (!parent) return;
      var clone = parent.cloneNode(true);
      // Срезаем служебные элементы: саму copy-кнопку, time-бэйдж, agent-бэйдж,
      // attachment-чипы, а также вложенные copy-кнопки (.btn-copy в prompt-block,
      // .copy-btn в math .code-block) — иначе в буфер попадёт слово «Копировать».
      var junk = clone.querySelectorAll('.gc-msg-copy, .gc-msg-time, .inflight-agent-badge, .gc-attach-chip, .btn-copy, .copy-btn');
      for (var ji = 0; ji < junk.length; ji++) junk[ji].remove();
      var text = (clone.textContent || '').trim();
      if (!text) return;
      copyTextToClipboard(text).then(function (ok) {
        if (!ok) return;
        btn.innerHTML = COPIED_ICON_SVG;
        btn.classList.add('copied');
        setTimeout(function () {
          btn.innerHTML = COPY_ICON_SVG;
          btn.classList.remove('copied');
        }, 1200);
      });
    });
  }

  // Универсальная копировалка: navigator.clipboard (secure context) или
  // document.execCommand('copy') через временный textarea (HTTP, file://).
  // navigator.clipboard НЕ работает по http:// в LAN — это и был баг.
  function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
        return execCommandCopy(text);
      });
    }
    // HTTP в LAN, file:// — clipboard API недоступен. Fallback.
    return Promise.resolve(execCommandCopy(text));
  }

  function execCommandCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      // Прячем за viewport, чтобы не моргало
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  // Кнопка «прокрутить вниз» — появляется когда юзер отскроллил вверх.
  // Центрируется над input-area, кликом доезжает до низа чата.
  // opts: { scrollable, inputArea }
  function initScrollToBottomButton(opts) {
    var scrollEl = opts.scrollable;
    var inputArea = opts.inputArea;
    if (!scrollEl || !inputArea) return;
    if (inputArea.querySelector('.gc-scroll-bottom-btn')) return;

    if (!document.getElementById('gc-scroll-btn-css')) {
      var style = document.createElement('style');
      style.id = 'gc-scroll-btn-css';
      style.textContent =
        // Кнопка позиционируется в inputArea абсолютно — чтобы стрелка
        // выровнялась горизонтально по центру поля ввода и торчала ~14px
        // над верхней границей поля.
        '.gc-input-area-wrap{position:relative}' +
        '.gc-scroll-bottom-btn{position:absolute;left:50%;top:-44px;transform:translateX(-50%) translateY(8px);width:32px;height:32px;display:none;align-items:center;justify-content:center;background:var(--bg-secondary);border:1px solid var(--border);border-radius:50%;color:var(--text-secondary);cursor:pointer;padding:0;z-index:5;opacity:0;transition:opacity .2s,transform .2s,background .15s,color .15s,border-color .15s}' +
        '.gc-scroll-bottom-btn.visible{display:flex;opacity:1;transform:translateX(-50%) translateY(0)}' +
        '.gc-scroll-bottom-btn:hover{background:var(--bg-input);color:var(--accent);border-color:var(--accent)}' +
        '.gc-scroll-bottom-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}';
      document.head.appendChild(style);
    }

    // Обёртку inputArea помечаем классом (для position:relative якоря).
    inputArea.classList.add('gc-input-area-wrap');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gc-scroll-bottom-btn';
    btn.setAttribute('aria-label', 'Прокрутить вниз');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
    btn.addEventListener('click', function () {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
    });
    inputArea.appendChild(btn);

    function update() {
      var distFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      if (distFromBottom > 80) btn.classList.add('visible');
      else btn.classList.remove('visible');
    }
    scrollEl.addEventListener('scroll', update, { passive: true });
    // Контент может расти асинхронно (typewriter, push'ы) — лёгкий interval
    // и MutationObserver чтобы вовремя реагировать.
    var mo = new MutationObserver(update);
    mo.observe(scrollEl, { childList: true, subtree: true, characterData: true });
    update();
  }

  // Плавный переход между шапкой и чатом через mask-image fade:
  // верхние 24px скролл-контейнера плавно прозрачные → плавное
  // увеличение прозрачности контента к шапке. Никаких теней или линий.
  // Принимает только { scrollable } — сам хедер без изменений.
  function initHeaderShadowOnScroll(opts) {
    var scrollEl = opts.scrollable;
    if (!scrollEl) return;
    if (!document.getElementById('gc-header-fade-css')) {
      var style = document.createElement('style');
      style.id = 'gc-header-fade-css';
      style.textContent =
        // Маска делает первые 24px контента прогрессивно прозрачными.
        '.gc-chat-fade{-webkit-mask-image:linear-gradient(to bottom, transparent 0, black 24px, black 100%);mask-image:linear-gradient(to bottom, transparent 0, black 24px, black 100%)}';
      document.head.appendChild(style);
    }
    scrollEl.classList.add('gc-chat-fade');
  }

  // Делает сайдбар агента ресайзабельным. Создаёт невидимую полоску у
  // правого края, за которую можно тащить мышью. Ширина сохраняется в
  // localStorage по ключу storageKey — у каждого агента свой ключ.
  //
  // opts:
  //   sidebar      (Element)   — .sidebar
  //   initialWidth (number)    — стартовая ширина (по умолч. 240)
  //   minWidth     (number)    — минимум при перетаскивании (по умолч. 220)
  //   maxWidth     (number)    — максимум (по умолч. 2 × min)
  // Параметр storageKey удалён: by design ширина не сохраняется между
  // открытиями страницы (см. строку «Не сохраняем в localStorage» ниже).
  function initSidebarResize(opts) {
    var sidebar = opts.sidebar;
    if (!sidebar) return;
    // Защита от повторной инициализации: handle уже есть → выходим.
    if (sidebar.querySelector('.gc-sidebar-resize-handle')) return;
    var initialW = opts.initialWidth || 240;
    var minW = opts.minWidth || 220;
    var maxW = opts.maxWidth || (minW * 2);

    // CSS инжектится один раз для всех агентов на странице.
    if (!document.getElementById('gc-sidebar-resize-css')) {
      var style = document.createElement('style');
      style.id = 'gc-sidebar-resize-css';
      style.textContent =
        '.sidebar{position:relative}' +
        // Hot-zone узкая — 6px у самого правого контура (только на нём ловим
        // hover/drag, чтобы юзер не задевал случайно). Индикатор — 1px
        // тонкая peach-линия, появляется только при hover.
        '.gc-sidebar-resize-handle{position:absolute;top:0;right:0;bottom:0;width:6px;cursor:col-resize;z-index:100;background:transparent;user-select:none}' +
        '.gc-sidebar-resize-handle::after{content:"";position:absolute;top:50%;right:0;transform:translateY(-50%);height:40px;width:1px;background:var(--accent);opacity:0;transition:opacity .15s,width .15s}' +
        '.gc-sidebar-resize-handle:hover::after,.gc-sidebar-resize-handle.dragging::after{opacity:1;width:2px}';
      document.head.appendChild(style);
    }

    // Каждое открытие страницы — стартуем с дефолтной ширины. Если юзер
    // растянул в этой сессии и ушёл/вернулся, ширина возвращается к
    // initialW. localStorage не используем (юзер хочет именно сброс).
    sidebar.style.width = initialW + 'px';

    // Хэндл создаём как ребёнка sidebar. У sidebar overflow:hidden (для
    // border-radius), поэтому хэндл должен лежать ВНУТРИ правого края.
    var handle = document.createElement('div');
    handle.className = 'gc-sidebar-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    sidebar.appendChild(handle);

    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var startX = e.clientX;
      var startW = sidebar.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      function onMove(ev) {
        var newW = Math.max(minW, Math.min(maxW, startW + (ev.clientX - startX)));
        sidebar.style.width = newW + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Не сохраняем в localStorage — при следующем открытии страницы
        // ширина возвращается к initialW.
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Иконка «стоп» — квадратик. Показывается на месте стрелки отправки во
  // время LLM-запроса; клик отменяет запрос.
  var STOP_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor"/></svg>';

  // Реестр активных AbortController'ов по session_id. Нужен чтобы при
  // переключении сессий sync'ать состояние кнопки отправки: если в
  // целевой сессии есть активный запрос — показать квадрат-стоп, иначе
  // стрелку. Closure makeCancellableSend изолирует controller, и без
  // реестра onSwitch не может узнать состояние других сессий.
  var __gcActive = {}; // sid -> AbortController

  function registerSendController(sid, controller) {
    if (sid) __gcActive[sid] = controller;
  }
  function unregisterSendController(sid) {
    if (sid) delete __gcActive[sid];
  }
  function getSendController(sid) {
    return sid ? __gcActive[sid] : null;
  }

  // Синхронизирует иконку кнопки с состоянием inflight у session_id.
  // Если controller активен в ЭТОЙ вкладке (фактический запрос) ИЛИ
  // isInflight=true (есть маркер в localStorage, запрос в другой вкладке
  // или повис без controller'а) — показываем STOP. Иначе ARROW.
  // Клик по STOP без локального controller'а обрабатывается в sendMsg
  // через clearInflight (signals другую вкладку).
  function syncSendButton(btn, sid, isInflight) {
    if (!btn) return;
    btn.innerHTML = (__gcActive[sid] || isInflight) ? STOP_ICON_SVG : SEND_ICON_SVG;
  }

  // Переключает кнопку отправки в режим «отмена»: меняет иконку на квадрат,
  // снимает disabled, вешает onclick → controller.abort(). Возвращает
  // объект с методами signal/aborted/restore для использования в sendMsg.
  //
  // Использование:
  //   var sendCtrl = GigaChat.makeCancellableSend(btn);
  //   try {
  //     var res = await fetchWithRetry(url, opts, { signal: sendCtrl.signal });
  //   } catch (e) {
  //     if (sendCtrl.aborted()) { /* user cancelled */ }
  //     else { /* real error */ }
  //   } finally {
  //     sendCtrl.restore();
  //   }
  function makeCancellableSend(btn, sid) {
    var controller = new AbortController();
    btn.disabled = false;
    btn.innerHTML = STOP_ICON_SVG;
    // ВАЖНО: onclick НЕ переписываем (он остаётся=sendMsg). sendMsg в
    // начале проверяет getSendController(activeSessionId) — если есть,
    // вызывает abort(). Так клик по стоп-кнопке работает в любой сессии
    // и не ломается при переключении.
    if (sid) registerSendController(sid, controller);
    return {
      signal: controller.signal,
      aborted: function () { return controller.signal.aborted; },
      restore: function () {
        if (sid) unregisterSendController(sid);
        btn.disabled = false;
        // Не перетираем иконку если typewriter сейчас печатает (он уже
        // переключил на STOP-иконку через .streaming class). Иначе
        // restore() из finally{} перебил бы typewriter'у его STOP-режим
        // обратно на стрелку, и нажатие «остановить» не работало бы.
        if (!btn.classList.contains('streaming')) {
          btn.innerHTML = SEND_ICON_SVG;
        }
      }
    };
  }

  // Создаёт контроллер вложений (поддерживает несколько файлов одновременно).
  // Возвращает объект:
  //   hasFile() / hasFiles() -> bool
  //   getFile() (первый) / getFiles() -> File[]
  //   clear()                     — сбросить все
  //   removeAt(idx)               — убрать один
  //   cancel()                    — отменить идущие экстракции
  //   extract(onProgress)         — Promise<Array<{text, fileName, error}>>
  //                                  (если файл один — также можно использовать
  //                                  old-style как массив с одним элементом)
  //
  // Опции:
  //   buttonContainer (DOM) — куда воткнуть кнопку-скрепку
  //   chipsContainer (DOM)  — куда показывать чипы с именами файлов
  //   inputElement (DOM)    — textarea (для focus после выбора, опционально)
  //   dropZone (DOM)        — элемент, на который можно перетащить файлы (drag-and-drop)
  //   onChange()            — колбэк когда файл добавлен/удалён
  //   maxFiles (number)     — максимум файлов одновременно (по умолчанию 5)
  //   maxFileSize (number)  — лимит размера каждого в байтах (по умолчанию 50 МБ)
  function setupAttachment(opts) {
    injectAttachCss();
    var buttonContainer = opts.buttonContainer;
    var chipsContainer = opts.chipsContainer;
    var inputElement = opts.inputElement;
    var dropZone = opts.dropZone;
    var onChange = opts.onChange || function () {};
    var MAX_FILES = opts.maxFiles || 5;
    var MAX_FILE_SIZE = opts.maxFileSize || 50 * 1024 * 1024;

    var selectedFiles = [];
    var abortCtrls = []; // массив контроллеров активных n8n-запросов (по одному на файл)

    // Скрытый input file
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.accept = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.log,.rtf,.odt,.jpg,.jpeg,.png,.tiff,.tif,.bmp,.webp,.gif,.heic';
    document.body.appendChild(fileInput);

    // Кнопка-скрепка
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gc-attach-btn';
    btn.setAttribute('aria-label', 'Прикрепить файл(ы)');
    btn.innerHTML = PAPERCLIP_SVG;
    btn.addEventListener('click', function () { fileInput.click(); });
    buttonContainer.appendChild(btn);

    // Общий путь добавления файлов — используется и из <input change>,
    // и из drop-листенера, и (потенциально) из вызывающего кода.
    function addFiles(fileList) {
      if (!fileList || !fileList.length) return;
      function isDuplicate(f) {
        for (var i = 0; i < selectedFiles.length; i++) {
          if (selectedFiles[i].name === f.name && selectedFiles[i].size === f.size) return true;
        }
        return false;
      }
      var rejected = [];
      for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        if (selectedFiles.length >= MAX_FILES) {
          rejected.push(f.name + ' (лимит ' + MAX_FILES + ' файлов)');
          continue;
        }
        if (f.size > MAX_FILE_SIZE) {
          rejected.push(f.name + ' (больше ' + Math.round(MAX_FILE_SIZE / 1024 / 1024) + ' МБ)');
          continue;
        }
        if (isDuplicate(f)) {
          rejected.push(f.name + ' (уже добавлен)');
          continue;
        }
        selectedFiles.push(f);
      }
      if (rejected.length) showToast('Не удалось добавить:\n' + rejected.join('\n'), 'warn');
      renderChips();
      onChange();
      if (inputElement) inputElement.focus();
    }

    fileInput.addEventListener('change', function () {
      addFiles(fileInput.files);
      fileInput.value = '';
    });

    // Drag-and-drop на указанный элемент (обычно — область чата). При
    // dragover подсвечиваем зону через .gc-drop-active. Слушатели не
    // вешаем если dropZone disabled (setDisabled(true)).
    var dropDisabled = false;
    if (dropZone) {
      dropZone.addEventListener('dragenter', function (e) {
        if (dropDisabled || !e.dataTransfer || !e.dataTransfer.types) return;
        if (e.dataTransfer.types.indexOf('Files') === -1) return;
        e.preventDefault();
        dropZone.classList.add('gc-drop-active');
      });
      dropZone.addEventListener('dragover', function (e) {
        if (dropDisabled || !e.dataTransfer || !e.dataTransfer.types) return;
        if (e.dataTransfer.types.indexOf('Files') === -1) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      dropZone.addEventListener('dragleave', function (e) {
        // dragleave срабатывает при переходе на child элементы — снимаем
        // подсветку только когда курсор реально вышел за пределы dropZone.
        if (e.target === dropZone || !dropZone.contains(e.relatedTarget)) {
          dropZone.classList.remove('gc-drop-active');
        }
      });
      dropZone.addEventListener('drop', function (e) {
        if (dropDisabled) return;
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        dropZone.classList.remove('gc-drop-active');
        addFiles(e.dataTransfer.files);
      });
    }

    // Перерисовка чипов всех прикреплённых файлов + индикатор кнопки.
    function renderChips() {
      chipsContainer.innerHTML = '';
      if (selectedFiles.length === 0) {
        btn.classList.remove('has-file');
        return;
      }
      btn.classList.add('has-file');
      for (var i = 0; i < selectedFiles.length; i++) {
        (function (idx) {
          var f = selectedFiles[idx];
          var chip = document.createElement('span');
          chip.className = 'gc-attach-chip';
          var name = document.createElement('span');
          name.className = 'name';
          name.textContent = '📎 ' + f.name;
          var x = document.createElement('button');
          x.type = 'button';
          x.className = 'x';
          x.textContent = '×';
          x.setAttribute('aria-label', 'Убрать файл');
          x.addEventListener('click', function () {
            selectedFiles.splice(idx, 1);
            renderChips();
            onChange();
          });
          chip.appendChild(name);
          chip.appendChild(x);
          chipsContainer.appendChild(chip);
        })(i);
      }
    }

    function hasFiles() { return selectedFiles.length > 0; }
    function hasFile() { return hasFiles(); } // legacy
    function getFiles() { return selectedFiles.slice(); }
    function getFile() { return selectedFiles[0] || null; } // legacy
    function clear() {
      selectedFiles = [];
      renderChips();
    }
    function removeAt(idx) {
      if (idx >= 0 && idx < selectedFiles.length) {
        selectedFiles.splice(idx, 1);
        renderChips();
        onChange();
      }
    }
    function cancel() {
      for (var i = 0; i < abortCtrls.length; i++) {
        try { abortCtrls[i].abort(); } catch (e) {}
      }
      abortCtrls = [];
    }
    function setDisabled(disabled) {
      btn.disabled = !!disabled;
      chipsContainer.style.display = disabled ? 'none' : '';
      dropDisabled = !!disabled;
      if (disabled && dropZone) dropZone.classList.remove('gc-drop-active');
    }

    // Извлечь один файл — внутренний helper.
    async function extractOne(file, onProgress) {
      var fileName = file.name;
      if (canExtractInBrowser(fileName)) {
        try {
          if (typeof onProgress === 'function') onProgress('Извлекаю «' + fileName + '»...');
          var text = await extractBrowserText(file);
          if (!text || !text.trim()) {
            return { text: '', fileName: fileName, error: 'Из файла не удалось извлечь текст (пустой).' };
          }
          return { text: text, fileName: fileName, error: '' };
        } catch (e) {
          return { text: '', fileName: fileName, error: 'Ошибка извлечения: ' + (e.message || e) };
        }
      }
      // OCR-путь через n8n.
      var url = cfg.N8N_BASE.replace(/\/$/, '') + '/webhook/extract-text';
      var ctrl = new AbortController();
      abortCtrls.push(ctrl);
      var tid = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 180000);
      try {
        if (typeof onProgress === 'function') onProgress('OCR «' + fileName + '»...');
        var fd = new FormData();
        fd.append('file', file);
        var res = await fetch(url, { method: 'POST', body: fd, signal: ctrl.signal });
        clearTimeout(tid);
        if (!res.ok) return { text: '', fileName: fileName, error: 'Сервер вернул ' + res.status };
        var data;
        try { data = await res.json(); }
        catch (parseErr) { return { text: '', fileName: fileName, error: 'Некорректный ответ (не JSON)' }; }
        if (data.success === false || !data.response) {
          return { text: '', fileName: fileName, error: data.response || 'Не удалось извлечь текст' };
        }
        return { text: String(data.response), fileName: fileName, error: '' };
      } catch (e) {
        clearTimeout(tid);
        if (e.name === 'AbortError') return { text: '', fileName: fileName, error: 'Извлечение отменено или превысило таймаут (3 мин)' };
        return { text: '', fileName: fileName, error: 'Ошибка: ' + e.message };
      }
    }

    // Извлечь все файлы. Возвращает массив результатов (тот же порядок).
    // Браузерные парсеры быстрые — гоняем последовательно. OCR-запросы шлём
    // параллельно (в очереди не запускаем — n8n сам разрулит).
    async function extract(onProgress) {
      if (selectedFiles.length === 0) return [];
      var files = selectedFiles.slice();
      abortCtrls = [];
      var promises = files.map(function (f, i) {
        return extractOne(f, function (msg) {
          if (typeof onProgress === 'function') {
            onProgress('[' + (i + 1) + '/' + files.length + '] ' + msg);
          }
        });
      });
      var results = await Promise.all(promises);
      abortCtrls = [];
      return results;
    }

    return {
      hasFile: hasFile,
      hasFiles: hasFiles,
      getFile: getFile,
      getFiles: getFiles,
      addFiles: addFiles,
      clear: clear,
      removeAt: removeAt,
      cancel: cancel,
      setDisabled: setDisabled,
      extract: extract
    };
  }

  // Утилита: TSV-блоки (несколько подряд идущих строк с одинаковым числом
  // табов) превращаем в markdown-таблицы. LLM лучше понимает табличные
  // данные в формате `| a | b |`, чем «текст со табуляциями».
  // =============================================================
  // === Table-merger helpers: parse/merge/build table data ======
  // =============================================================
  // Используются Excel- и Word-мерджерами (один источник истины
  // для нормализации заголовков, union колонок и опций dedup/sort/ignore).

  // Нормализация заголовка: схлопывает регистр, пробелы и пунктуацию.
  // «ФИО», «Ф.И.О.», «ф и о» → один и тот же ключ.
  function normalizeMergeHeader(h) {
    return String(h == null ? '' : h).trim().toLowerCase()
      .replace(/[\s._\-(){}\[\]\\\/:;,!?'\"]+/g, '');
  }

  // Объединение таблиц.
  //   tables: [{name, headers: [...], rows: [[...], ...]}, ...]
  //   opts:   { dedup, sortColumn (idx после union), sortDir ('asc'|'desc'),
  //             ignoreColumns (Set индексов после union) }
  // Возвращает { headers, rows, sourceMap[ rowIdx → fileName ] }
  function mergeTables(tables, opts) {
    opts = opts || {};
    // 1) Считаем частоту каждого варианта написания (для majority vote).
    //    Раньше брали ПЕРВЫЙ встреченный вариант — «ФИО» против 9×«Ф.И.О.»
    //    давал «ФИО». Теперь побеждает наиболее частый написания.
    var columnOrder = [];
    var variantCounts = {};  // norm → { variantText: count }
    for (var i = 0; i < tables.length; i++) {
      var hs = tables[i].headers || [];
      for (var j = 0; j < hs.length; j++) {
        var norm = normalizeMergeHeader(hs[j]);
        if (!norm) continue;
        if (!variantCounts[norm]) {
          variantCounts[norm] = {};
          columnOrder.push(norm);  // порядок по первому появлению
        }
        var variant = hs[j];
        variantCounts[norm][variant] = (variantCounts[norm][variant] || 0) + 1;
      }
    }
    // 2) Для каждого norm выбираем вариант с max count (при равенстве —
    //    первый по алфавиту, для стабильности).
    var canonical = {};
    for (var c = 0; c < columnOrder.length; c++) {
      var n = columnOrder[c];
      var variants = variantCounts[n];
      var best = null, bestCount = -1;
      var keys = Object.keys(variants).sort();
      for (var k = 0; k < keys.length; k++) {
        if (variants[keys[k]] > bestCount) { bestCount = variants[keys[k]]; best = keys[k]; }
      }
      canonical[n] = best;
    }
    var mergedHeaders = columnOrder.map(function (k) { return canonical[k]; });

    var mergedRows = [];
    var sourceMap = [];
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var localMap = {};
      var hs = t.headers || [];
      for (var j = 0; j < hs.length; j++) {
        var norm = normalizeMergeHeader(hs[j]);
        if (norm && !(norm in localMap)) localMap[norm] = j;
      }
      var rs = t.rows || [];
      for (var k = 0; k < rs.length; k++) {
        var row = rs[k];
        var newRow = [];
        for (var c = 0; c < columnOrder.length; c++) {
          var idx = localMap[columnOrder[c]];
          newRow.push((idx != null && row[idx] != null) ? row[idx] : '');
        }
        mergedRows.push(newRow);
        sourceMap.push(t.name || ('file-' + i));
      }
    }

    // Dedup (по контенту строки)
    if (opts.dedup) {
      var seen = Object.create(null);
      var keptRows = [];
      var keptSrc = [];
      for (var i = 0; i < mergedRows.length; i++) {
        var key = mergedRows[i].join('');
        if (seen[key]) continue;
        seen[key] = true;
        keptRows.push(mergedRows[i]);
        keptSrc.push(sourceMap[i]);
      }
      mergedRows = keptRows;
      sourceMap = keptSrc;
    }

    // Sort
    if (typeof opts.sortColumn === 'number' && opts.sortColumn >= 0 && opts.sortColumn < mergedHeaders.length) {
      var col = opts.sortColumn;
      var dir = opts.sortDir === 'desc' ? -1 : 1;
      // Числоподобное: строго число (опц. знак, цифры, опц. дробь). Не пускает
      // 25.01.2019 — для дат отдельная ветка ниже.
      var numericRe = /^-?\d+(?:[.,]\d+)?(?:[eE][+\-]?\d+)?$/;
      // DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY
      var dateRe = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/;
      function tryDate(s) {
        var m = s.match(dateRe);
        if (!m) return null;
        var d = +m[1], mo = +m[2], y = +m[3];
        if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
        if (y < 100) y += 2000;
        return new Date(y, mo - 1, d).getTime();
      }
      // orig — для stable sort при равных ключах.
      var indexed = mergedRows.map(function (r, i) { return { r: r, src: sourceMap[i], orig: i }; });
      indexed.sort(function (a, b) {
        var as = String(a.r[col] == null ? '' : a.r[col]).trim();
        var bs = String(b.r[col] == null ? '' : b.r[col]).trim();

        // Пустые значения ВСЕГДА в конец (как в Excel/Google Sheets) —
        // независимо от направления. Иначе пустые забивают начало и кажется,
        // что сортировка не работает.
        if (!as && !bs) return a.orig - b.orig;
        if (!as) return 1;
        if (!bs) return -1;

        // Даты ДД.ММ.ГГГГ
        var ad = tryDate(as), bd = tryDate(bs);
        if (ad !== null && bd !== null) return dir * (ad - bd);

        // Числа — снимаем пробелы (русские разделители тысяч) и запятую→точку
        var aClean = as.replace(/\s/g, '').replace(',', '.');
        var bClean = bs.replace(/\s/g, '').replace(',', '.');
        if (numericRe.test(aClean) && numericRe.test(bClean)) {
          return dir * (parseFloat(aClean) - parseFloat(bClean));
        }

        // Строки. numeric:true → естественный порядок «1, 2, 10», не «1, 10, 2».
        return dir * as.localeCompare(bs, 'ru', { numeric: true, sensitivity: 'base' });
      });
      mergedRows = indexed.map(function (x) { return x.r; });
      sourceMap = indexed.map(function (x) { return x.src; });
    }

    // Ignore columns
    if (opts.ignoreColumns && opts.ignoreColumns.size > 0) {
      var keep = [];
      for (var i = 0; i < mergedHeaders.length; i++) {
        if (!opts.ignoreColumns.has(i)) keep.push(i);
      }
      mergedHeaders = keep.map(function (i) { return mergedHeaders[i]; });
      mergedRows = mergedRows.map(function (r) { return keep.map(function (i) { return r[i]; }); });
    }

    return { headers: mergedHeaders, rows: mergedRows, sourceMap: sourceMap };
  }

  // === Парсинг XLSX (через JSZip + DOMParser) ===
  // Возвращает [{ name, headers, rows }, ...] — по одному на каждый лист.
  // Поддерживает shared strings (t="s"), inline strings (t="inlineStr"), числа.
  // Excel serial date → JS Date. Excel epoch = 1899-12-30 (учитывает баг 1900
  // как leap year). Целая часть = дни, дробная = время суток.
  function _excelSerialToDate(serial) {
    var days = Math.floor(serial);
    var ms = Math.round((serial - days) * 86400 * 1000);
    return new Date(Date.UTC(1899, 11, 30 + days, 0, 0, 0, ms));
  }
  function _padZero(n) { return (n < 10 ? '0' : '') + n; }
  function _formatExcelDate(serial, code) {
    var d = _excelSerialToDate(serial);
    if (isNaN(d.getTime())) return String(serial);
    var Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
    var h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
    var c = (code || '').toLowerCase();
    var hasTime = c.indexOf('h') !== -1 || c.indexOf('s') !== -1;
    var hasDate = c.indexOf('y') !== -1 || c.indexOf('d') !== -1 ||
                  c.indexOf('м') !== -1 || c.indexOf('д') !== -1 || c.indexOf('г') !== -1;
    if (!hasDate && hasTime) {
      return _padZero(h) + ':' + _padZero(m) + (s ? ':' + _padZero(s) : '');
    }
    var date = _padZero(D) + '.' + _padZero(M) + '.' + Y;
    if (hasTime) return date + ' ' + _padZero(h) + ':' + _padZero(m);
    return date;
  }
  // Встроенные numFmtId, которые означают дату/время в OOXML (§18.8.30).
  var XLSX_BUILTIN_DATE_FMT = {
    14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
    18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
    22: 'm/d/yyyy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0'
  };

  async function parseXlsxFile(file) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip не загружен');
    var buf = await file.arrayBuffer();
    var zip = await JSZip.loadAsync(buf);

    // Shared strings
    var sst = [];
    var sstFile = zip.file('xl/sharedStrings.xml');
    if (sstFile) {
      var sstXml = await sstFile.async('string');
      var sstDoc = new DOMParser().parseFromString(sstXml, 'application/xml');
      var sis = sstDoc.getElementsByTagName('si');
      for (var i = 0; i < sis.length; i++) {
        var ts = sis[i].getElementsByTagName('t');
        var s = '';
        for (var j = 0; j < ts.length; j++) s += ts[j].textContent || '';
        sst.push(s);
      }
    }

    // Styles → cellXfs → numFmt. Каждой ячейке с s="N" соответствует
    // cellXfs[N] (по порядку <xf>). Берём из xf атрибут numFmtId. Если
    // numFmtId есть в встроенных дат-форматах или среди custom <numFmt code="..yyyy.."/>
    // — флаг isDate. parseXlsx тогда конвертит serial → DD.MM.YYYY.
    // Иначе число с дробью — оставляем как раньше (str via textContent).
    var styleIsDate = []; // index — cellXfs id, value — boolean
    var styleCode = [];   // index — cellXfs id, value — format code (for time/date variants)
    var stylesFile = zip.file('xl/styles.xml');
    if (stylesFile) {
      try {
        var stXml = await stylesFile.async('string');
        var stDoc = new DOMParser().parseFromString(stXml, 'application/xml');
        // Custom numFmt из <numFmts>
        var customFmt = {};
        var nfEls = stDoc.getElementsByTagName('numFmt');
        for (var i = 0; i < nfEls.length; i++) {
          var idAttr = parseInt(nfEls[i].getAttribute('numFmtId') || '0', 10);
          var codeAttr = nfEls[i].getAttribute('formatCode') || '';
          customFmt[idAttr] = codeAttr;
        }
        // cellXfs — массив <xf>. Берём только из непосредственного потомка
        // <cellXfs>, не из <cellStyleXfs> (иначе индексы съедутся).
        var cellXfsEl = stDoc.getElementsByTagName('cellXfs')[0];
        if (cellXfsEl) {
          var xfEls = cellXfsEl.getElementsByTagName('xf');
          for (var i = 0; i < xfEls.length; i++) {
            var nf = parseInt(xfEls[i].getAttribute('numFmtId') || '0', 10);
            var code = customFmt[nf] || XLSX_BUILTIN_DATE_FMT[nf] || '';
            var c = code.toLowerCase();
            // Признаём датой если builtin date или custom с y/d/h/s (но не просто
            // «0.00» — там нет этих букв). Защищаем «General», «#,##0», «0%».
            var isDate = !!XLSX_BUILTIN_DATE_FMT[nf] ||
                         (code && /[yYdDhHsS]|[мдгчс]/.test(code) && !/^[#0,.\- _%₽$€]+$/.test(code));
            styleIsDate.push(!!isDate);
            styleCode.push(code);
          }
        }
      } catch (e) { /* styles parse fail → дальше без дат */ }
    }

    // Workbook → sheet names
    var wbFile = zip.file('xl/workbook.xml');
    if (!wbFile) throw new Error('В «' + file.name + '» нет xl/workbook.xml');
    var wbXml = await wbFile.async('string');
    var wbDoc = new DOMParser().parseFromString(wbXml, 'application/xml');
    var sheetEls = wbDoc.getElementsByTagName('sheet');

    // workbook.xml.rels → r:id → target
    var relsFile = zip.file('xl/_rels/workbook.xml.rels');
    var relMap = {};
    if (relsFile) {
      var relsXml = await relsFile.async('string');
      var relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
      var relEls = relsDoc.getElementsByTagName('Relationship');
      for (var i = 0; i < relEls.length; i++) {
        relMap[relEls[i].getAttribute('Id')] = relEls[i].getAttribute('Target');
      }
    }

    var sheets = [];
    for (var s = 0; s < sheetEls.length; s++) {
      var sheetName = sheetEls[s].getAttribute('name') || ('Лист ' + (s + 1));
      // Найти target через r:id или fallback на sheetN.xml
      var rid = sheetEls[s].getAttribute('r:id') || sheetEls[s].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      var target = rid && relMap[rid] ? relMap[rid] : 'worksheets/sheet' + (s + 1) + '.xml';
      var sheetPath = target.indexOf('/') === 0 ? target.slice(1) : 'xl/' + target;
      var sheetFile = zip.file(sheetPath);
      if (!sheetFile) continue;

      var sxml = await sheetFile.async('string');
      var sdoc = new DOMParser().parseFromString(sxml, 'application/xml');
      var rowEls = sdoc.getElementsByTagName('row');

      var grid = [];
      for (var i = 0; i < rowEls.length; i++) {
        var cells = rowEls[i].getElementsByTagName('c');
        var rowArr = [];
        for (var j = 0; j < cells.length; j++) {
          var cell = cells[j];
          var ref = cell.getAttribute('r') || '';
          var letters = ref.replace(/\d+/g, '');
          var colIdx;
          if (letters) {
            colIdx = 0;
            for (var k = 0; k < letters.length; k++) colIdx = colIdx * 26 + (letters.charCodeAt(k) - 64);
            colIdx--;
          } else {
            // Fallback: атрибут r= отсутствует (валидно по OOXML §18.3.1.4 —
            // openpyxl/LibreOffice могут опустить для компактности). Считаем
            // по позиции среди <c>-элементов в строке.
            colIdx = j;
          }
          var t = cell.getAttribute('t');
          var sAttr = cell.getAttribute('s');
          var sIdx = sAttr ? parseInt(sAttr, 10) : -1;
          var value = '';
          if (t === 's') {
            var vEl = cell.getElementsByTagName('v')[0];
            if (vEl) value = sst[parseInt(vEl.textContent, 10)] || '';
          } else if (t === 'inlineStr') {
            var isEl = cell.getElementsByTagName('is')[0];
            if (isEl) {
              var its = isEl.getElementsByTagName('t');
              for (var k = 0; k < its.length; k++) value += its[k].textContent || '';
            }
          } else {
            var vEl2 = cell.getElementsByTagName('v')[0];
            if (vEl2) {
              var raw = vEl2.textContent || '';
              // Баг 14: если ячейка стилизована под дату — конвертим serial
              // в DD.MM.YYYY. Без этой ветки 45413 → выходило «45413» вместо
              // «01.05.2024», числа-проценты также теряли %.
              if (sIdx >= 0 && styleIsDate[sIdx] && raw && !isNaN(parseFloat(raw))) {
                value = _formatExcelDate(parseFloat(raw), styleCode[sIdx]);
              } else if (sIdx >= 0 && styleCode[sIdx] &&
                         /%/.test(styleCode[sIdx]) && raw && !isNaN(parseFloat(raw))) {
                // Проценты: Excel хранит 0.5, отображает 50%. Конвертим.
                value = (parseFloat(raw) * 100).toFixed(
                  (styleCode[sIdx].match(/0\.0+/) || [''])[0].length > 2
                    ? (styleCode[sIdx].match(/0\.0+/)[0].length - 2) : 0
                ) + '%';
              } else {
                value = raw;
              }
            }
          }
          while (rowArr.length < colIdx) rowArr.push('');
          rowArr.push(value);
        }
        grid.push(rowArr);
      }

      // Headers — первая НЕпустая строка (xlsx часто имеет титульную пустую
      // или merge-cell сверху). Раньше брали grid[0]: пустые headers → лист
      // тихо отбрасывался в collectParsedSheets.
      var headerRowIdx = -1;
      for (var hi = 0; hi < grid.length; hi++) {
        if (grid[hi].some(function (c) { return String(c == null ? '' : c).trim() !== ''; })) {
          headerRowIdx = hi; break;
        }
      }
      var headers = headerRowIdx >= 0 ? grid[headerRowIdx] : [];
      var dataRows = (headerRowIdx >= 0 ? grid.slice(headerRowIdx + 1) : []).filter(function (r) {
        return r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; });
      });

      sheets.push({ name: sheetName, headers: headers, rows: dataRows });
    }

    return sheets;
  }

  // === Сборка XLSX из headers + rows ===
  // Минимальный валидный xlsx через inline strings (без shared strings table).
  // Возвращает Promise<Blob>.
  async function buildXlsxBlob(headers, rows, sheetName) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip не загружен');
    sheetName = (sheetName || 'Объединение').slice(0, 31).replace(/[\\\/?*\[\]:]/g, '_');

    function colLetter(idx) {
      var s = '';
      idx += 1;
      while (idx > 0) {
        var rem = (idx - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        idx = Math.floor((idx - 1) / 26);
      }
      return s;
    }
    function escXml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    }

    var zip = new JSZip();
    zip.file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>');
    zip.file('_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>');
    zip.file('xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>');
    zip.file('xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + escXml(sheetName) + '" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>');

    // Авто-расчёт ширины колонок по максимальной длине контента (включая
    // header). Excel меряет ширину в characters (~ кол-во цифр '0' что
    // помещаются + padding). Берём max(header.length, max(row[col].length)),
    // ограничиваем 8..60 чтобы не было микро- или гипер-широких колонок.
    var colsXml = '<cols>';
    for (var ci = 0; ci < headers.length; ci++) {
      var maxLen = String(headers[ci] || '').length;
      for (var ri = 0; ri < rows.length; ri++) {
        var cellStr = String(rows[ri][ci] == null ? '' : rows[ri][ci]);
        // Если в ячейке многострочный текст — берём самую длинную строку.
        var lines = cellStr.split(/\r?\n/);
        for (var li = 0; li < lines.length; li++) {
          if (lines[li].length > maxLen) maxLen = lines[li].length;
        }
      }
      // +2 для небольшого padding; clamp 8..60
      var w = Math.min(60, Math.max(8, maxLen + 2));
      colsXml += '<col min="' + (ci + 1) + '" max="' + (ci + 1) + '" width="' + w.toFixed(2) + '" customWidth="1"/>';
    }
    colsXml += '</cols>';

    var sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      colsXml +
      '<sheetData>';
    sheetXml += '<row r="1">';
    for (var i = 0; i < headers.length; i++) {
      sheetXml += '<c r="' + colLetter(i) + '1" t="inlineStr"><is><t xml:space="preserve">' +
        escXml(headers[i]) + '</t></is></c>';
    }
    sheetXml += '</row>';
    // Числоподобное: чисто целое или десятичное (опц. знак, опц. экспонента).
    // Запятая в качестве дес. разделителя поддерживается (русская локаль).
    // Если значение — число, пишем как numeric (<v>123</v>) чтобы Excel при
    // открытии распознал тип. Раньше всё писалось inlineStr и числовые
    // колонки сортировались/суммировались как текст.
    var xlsxNumRe = /^-?\d+(?:[.,]\d+)?(?:[eE][+\-]?\d+)?$/;
    for (var r = 0; r < rows.length; r++) {
      sheetXml += '<row r="' + (r + 2) + '">';
      for (var c = 0; c < headers.length; c++) {
        var v = rows[r][c];
        var vs = String(v == null ? '' : v).trim();
        if (vs && xlsxNumRe.test(vs.replace(/\s/g, ''))) {
          // Numeric ячейка: <v>123.45</v>, точка как дес. разделитель
          var num = vs.replace(/\s/g, '').replace(',', '.');
          sheetXml += '<c r="' + colLetter(c) + (r + 2) + '"><v>' + num + '</v></c>';
        } else {
          sheetXml += '<c r="' + colLetter(c) + (r + 2) + '" t="inlineStr"><is><t xml:space="preserve">' +
            escXml(v) + '</t></is></c>';
        }
      }
      sheetXml += '</row>';
    }
    sheetXml += '</sheetData></worksheet>';
    zip.file('xl/worksheets/sheet1.xml', sheetXml);

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE'
    });
  }

  // === Парсинг ВСЕХ таблиц из docx ===
  // Возвращает { zip, doc, tablesEls, tables: [{headers, rows, tableIndex}, ...] }
  // Каждая таблица — отдельный кандидат на слияние.
  async function parseDocxAllTables(file) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip не загружен');
    var buf = await file.arrayBuffer();
    var zip = await JSZip.loadAsync(buf);
    var xmlFile = zip.file('word/document.xml');
    if (!xmlFile) throw new Error('В «' + file.name + '» нет word/document.xml');
    var xml = await xmlFile.async('string');
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var pe = doc.getElementsByTagName('parsererror')[0];
    if (pe) throw new Error('Файл «' + file.name + '»: XML не разобрать');

    var tablesEls = doc.getElementsByTagName('w:tbl');
    var results = [];
    for (var t = 0; t < tablesEls.length; t++) {
      var tbl = tablesEls[t];
      var rows = tbl.getElementsByTagName('w:tr');
      if (rows.length < 1) continue;
      var headers = extractDocxRowText(rows[0]);
      var dataRows = [];
      for (var i = 1; i < rows.length; i++) {
        var rowText = extractDocxRowText(rows[i]);
        if (rowText.some(function (c) { return String(c || '').trim() !== ''; })) {
          dataRows.push(rowText);
        }
      }
      results.push({ tableIndex: t, headers: headers, rows: dataRows });
    }
    return { zip: zip, doc: doc, tablesEls: tablesEls, tables: results };
  }

  function extractDocxRowText(tr) {
    var tcs = tr.getElementsByTagName('w:tc');
    var out = [];
    for (var i = 0; i < tcs.length; i++) {
      var tc = tcs[i];
      // Многострочные ячейки: каждый <w:p> = параграф, разделяем \n.
      // <w:br/> внутри = тоже \n. Раньше все <w:t> склеивались join(''),
      // переводы строк терялись.
      var paragraphs = tc.getElementsByTagName('w:p');
      var lines = [];
      for (var p = 0; p < paragraphs.length; p++) {
        var par = paragraphs[p];
        var parts = [];
        // Обходим только прямых потомков <w:r>/<w:t>/<w:br> в этом параграфе
        var walker = par.firstChild;
        while (walker) {
          var name = walker.nodeName;
          if (name === 'w:r' || (walker.getElementsByTagName && walker.getElementsByTagName('w:t').length)) {
            var ts = walker.getElementsByTagName('w:t');
            for (var j = 0; j < ts.length; j++) parts.push(ts[j].textContent || '');
            var brs = walker.getElementsByTagName('w:br');
            for (var b = 0; b < brs.length; b++) parts.push('\n');
          }
          walker = walker.nextSibling;
        }
        lines.push(parts.join(''));
      }
      out.push(lines.join('\n'));
    }
    return out;
  }

  // Не-TSV строки (заголовки секций, plain text) остаются как есть.
  function tsvBlocksToMarkdownTables(text) {
    if (!text || text.indexOf('\t') === -1) return text;
    var lines = text.split('\n');
    var result = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var tabCount = (line.match(/\t/g) || []).length;
      if (tabCount > 0) {
        var block = [line];
        var j = i + 1;
        while (j < lines.length && (lines[j].match(/\t/g) || []).length === tabCount) {
          block.push(lines[j]);
          j++;
        }
        if (block.length >= 2) {
          var rows = block.map(function (r) { return r.split('\t'); });
          var md = '| ' + rows[0].map(function (c) { return (c || '').replace(/\|/g, '\\|') || ' '; }).join(' | ') + ' |\n';
          md += '|' + rows[0].map(function () { return '---'; }).join('|') + '|';
          for (var k = 1; k < rows.length; k++) {
            md += '\n| ' + rows[k].map(function (c) { return (c || '').replace(/\|/g, '\\|') || ' '; }).join(' | ') + ' |';
          }
          result.push(md);
          i = j;
          continue;
        }
      }
      result.push(line);
      i++;
    }
    return result.join('\n');
  }

  // Утилита: собрать сообщение для агента и описание для UI.
  // Принимает массив extracted (или один объект — для обратной совместимости).
  // Каждый элемент: {text, fileName, error}.
  //
  // Возвращает:
  //   messageForAgent — текст для отправки агенту, с блоками [ВЛОЖЕНИЕ:f1]...[/ВЛОЖЕНИЕ]
  //   attachmentSummary — сводка по одному файлу (legacy: 'name (1234 симв.)')
  //   attachments — массив сводок по каждому файлу (для рендера множества чипов)
  function buildMessageWithAttachment(userText, extracted) {
    var list = Array.isArray(extracted) ? extracted : (extracted ? [extracted] : []);
    if (list.length === 0) {
      return { messageForAgent: userText || '', attachmentSummary: '', attachments: [] };
    }
    var blocks = [];
    var attachments = [];
    var summaryParts = [];
    var anySuccess = false;
    var anyError = false;
    for (var i = 0; i < list.length; i++) {
      var ex = list[i] || {};
      var fname = ex.fileName || ('файл-' + (i + 1));
      var hasText = ex.text && ex.text.length > 0;
      var hasError = ex.error && ex.error.length > 0;
      if (hasText) {
        // Если в тексте есть TSV-блоки (от docx/xlsx/csv через браузерные
        // парсеры) — конвертим их в markdown-таблицы. LLM лучше понимает
        // структуру и может отвечать таблично.
        var textForAgent = tsvBlocksToMarkdownTables(ex.text);
        blocks.push('[ВЛОЖЕНИЕ:' + fname + ']\n' + textForAgent + '\n[/ВЛОЖЕНИЕ]');
        attachments.push({ fileName: fname, error: false });
        summaryParts.push(fname + ' (' + ex.text.length.toLocaleString('ru-RU') + ' симв.)');
        anySuccess = true;
      } else if (hasError) {
        // OCR упал — текст не зашиваем, но добавляем заметку.
        blocks.push('[не удалось обработать файл: ' + fname + ' — ' + ex.error + ']');
        attachments.push({ fileName: fname, error: true });
        summaryParts.push(fname + ' (ошибка: ' + ex.error + ')');
        anyError = true;
      }
    }
    var trimmedUser = (userText || '').trim();
    var prefix = blocks.join('\n\n');
    var msg;
    if (prefix && trimmedUser) msg = prefix + '\n\n' + userText;
    else if (prefix && anySuccess) msg = prefix + '\n\nПроанализируй прикреплённые файлы.';
    else if (prefix) msg = prefix + (userText ? '\n\n' + userText : '');
    else msg = userText || '';
    return {
      messageForAgent: msg,
      attachmentSummary: summaryParts.join('; '),
      attachments: attachments
    };
  }

  // ============================================================
  // ХРАНИЛИЩЕ СЕССИЙ — единый код для сайдбара всех чат-агентов
  // ============================================================
  // Раньше каждый из 6 агентов содержал ~200 строк дублированного кода
  // (sessions/save/load/switch/delete/rename/render). Теперь — фабрика.
  //
  // opts:
  //   prefix         (string)   — префикс ключей в localStorage ('chat', 'rag'...)
  //   idPrefix       (string)   — префикс id новой сессии ('chat_', 'rag_'...)
  //   namePrefix     (string)   — префикс имени новой сессии ('Чат-', 'Документ-'...)
  //   sessionList    (Element)  — куда рисовать сайдбар
  //   renderMessages (function) — агент рисует чат сам (вызывается при смене сессии / push)
  //   loadHistory    (function) async (sessionId) — опц. подгрузка истории с сервера
  //   isProcessing   (function) → bool — нужно ли беречь attachment (sendMsg идёт)
  //   onAttachmentClear (function) — клиент сам сбрасывает скрепку при безопасном свитче
  //   onEmpty        (function) — после удаления последней сессии (зачистить UI)
  //   onSwitch       (function) (sessionId, opts) — после переключения (для focus, scroll)
  function createSessionStore(opts) {
    opts = opts || {};
    var prefix = opts.prefix;
    var idPrefix = opts.idPrefix || (prefix + '_');
    var namePrefix = opts.namePrefix || 'Сессия-';
    var sessionList = opts.sessionList;
    var renderMessages = opts.renderMessages || function () {};
    var loadHistory = opts.loadHistory || null;
    // Backend-синхронизация sessions через /webhook/sessions-sync.
    // syncWithBackend — флаг включения, agentKey — значение поля agent в БД
    // (одно из: chat, sql, rag, math, prompt, plane). Один аккаунт
    // на разных ПК → все ПК видят одни сессии (LS — кеш, сервер — truth).
    var syncWithBackend = opts.syncWithBackend === true;
    var agentKey = opts.agentKey || prefix;
    // isProcessing определяется per-session через getInflight маркер.
    // Опция-callback можно переопределить для legacy-кода, но дефолт смотрит
    // в localStorage — единый источник правды «идёт ли в сессии обработка».
    var isProcessing = opts.isProcessing || function () {
      return !!getInflight(store.activeSessionId);
    };
    var onAttachmentClear = opts.onAttachmentClear || function () {};
    var onEmpty = opts.onEmpty || function () {};
    var onSwitch = opts.onSwitch || function () {};
    // onBeforeSwitch(newId, oldId) — вызывается ДО смены activeSessionId.
    // Используется createChatAgent для отмены активного typewriter'а в
    // ТЕКУЩЕЙ сессии (sendBtn._typewriterController) — нельзя делать это
    // напрямую из switchTo, потому что sendBtn живёт в scope createChatAgent,
    // а createSessionStore определён выше и эту переменную не видит.
    // Раньше ссылка на sendBtn здесь давала ReferenceError при переключении
    // в другую сессию — выглядело как «не могу открыть сессию» в toast'е.
    var onBeforeSwitch = opts.onBeforeSwitch || function () {};

    var KEY_SESSIONS = prefix + '_sessions';
    var KEY_ACTIVE = prefix + '_active';
    var KEY_COUNTER = prefix + '_counter';
    var KEY_VIEW = prefix + '_view_';
    var KEY_INFLIGHT = prefix + '_inflight_';
    var KEY_DRAFT = prefix + '_draft_';

    var store = {
      sessions: [],
      activeSessionId: null,
      sessionCounter: 0,
      displayMessages: [],
      editingSessionId: null
    };

    var PENCIL_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';

    // ─── Search input: вставляется ПЕРЕД sessionList (внутри sidebar). При
    // вводе фильтрует session-item по name (case-insensitive). Filter
    // применяется и при каждом renderList. Сам state хранится в sessionFilter.
    // Внутри обёртки .gc-session-search-wrap ещё кнопка × — появляется когда
    // в поле есть текст, клик очищает поле и сбрасывает фильтр.
    var sessionFilter = '';
    var searchInput = null;
    var searchClearBtn = null;
    if (sessionList) {
      var searchWrap = document.createElement('div');
      searchWrap.className = 'gc-session-search-wrap';
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'gc-session-search';
      searchInput.placeholder = 'Поиск...';
      searchInput.setAttribute('aria-label', 'Поиск по сессиям');
      searchClearBtn = document.createElement('button');
      searchClearBtn.type = 'button';
      searchClearBtn.className = 'gc-session-search-clear';
      searchClearBtn.setAttribute('aria-label', 'Очистить поиск');
      // SVG вместо текстового × — у × разные метрики в зависимости от шрифта,
      // не центрируется попиксельно. SVG-крестик идентичен .session-item .close
      // и точно центрируется через flex align-items:center.
      searchClearBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="10" height="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      searchInput.addEventListener('input', function () {
        sessionFilter = (this.value || '').toLowerCase().trim();
        applySessionFilter();
        searchClearBtn.classList.toggle('show', this.value.length > 0);
      });
      searchClearBtn.addEventListener('click', function () {
        searchInput.value = '';
        sessionFilter = '';
        applySessionFilter();
        searchClearBtn.classList.remove('show');
        searchInput.focus();
      });
      searchWrap.appendChild(searchInput);
      searchWrap.appendChild(searchClearBtn);
      sessionList.parentNode.insertBefore(searchWrap, sessionList);
    }
    function applySessionFilter() {
      if (!sessionList) return;
      var items = sessionList.querySelectorAll('.session-item');
      var q = sessionFilter;
      for (var i = 0; i < items.length; i++) {
        var nameEl = items[i].querySelector('.name');
        var nm = nameEl ? (nameEl.textContent || '').toLowerCase() : '';
        items[i].style.display = (!q || nm.indexOf(q) !== -1) ? '' : 'none';
      }
    }

    function save() {
      try {
        localStorage.setItem(KEY_SESSIONS, JSON.stringify(store.sessions));
        localStorage.setItem(KEY_ACTIVE, store.activeSessionId || '');
        localStorage.setItem(KEY_COUNTER, String(store.sessionCounter));
      } catch (e) {}
    }

    function load() {
      try {
        var s = localStorage.getItem(KEY_SESSIONS);
        var a = localStorage.getItem(KEY_ACTIVE);
        var c = localStorage.getItem(KEY_COUNTER);
        if (s) store.sessions = JSON.parse(s) || [];
        if (a) store.activeSessionId = a || null;
        if (c) store.sessionCounter = parseInt(c, 10) || 0;
      } catch (e) {}
    }
    // Чистка stale inflight-маркеров. Вынесена ОТДЕЛЬНО от load() — её нужно
    // делать ТОЛЬКО при инициальной загрузке страницы (вызов load() из
    // агентского кода). НЕ из handleStorageEvent, иначе при переименовании
    // сессии в одной вкладке мы могли бы убить активный inflight в другой
    // вкладке (если запрос идёт >10 мин — реалистично для длинных OCR).
    function pruneStaleInflightMarkers() {
      var STALE_INFLIGHT_MS = 10 * 60 * 1000;
      var now = Date.now();
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(KEY_INFLIGHT) !== 0) continue;
        try {
          var raw = localStorage.getItem(k);
          var data = raw ? JSON.parse(raw) : null;
          if (data && data.startedAt && (now - data.startedAt > STALE_INFLIGHT_MS)) {
            toRemove.push(k);
          }
        } catch (e) {}
      }
      for (var j = 0; j < toRemove.length; j++) {
        try { localStorage.removeItem(toRemove[j]); } catch (e) {}
      }
    }
    // Запускаем ОДИН раз при создании сессии-стора (по сути при загрузке
    // страницы) — реликты вкладок, закрытых без clearInflight, очистятся.
    pruneStaleInflightMarkers();

    // Чистка orphan snapshot'ов: KEY_VIEW записи от сессий, которых уже
    // нет в KEY_SESSIONS. Без чистки localStorage накапливает мусор и
    // упирается в quota при больших длинных сессиях.
    //
    // ВАЖНО: чистим ТОЛЬКО KEY_VIEW. KEY_INFLIGHT и KEY_DRAFT — короткоживущие
    // и могут быть установлены другой вкладкой в момент между чтением
    // KEY_SESSIONS и iteration (race). Стирать их орфановыми — рискованно
    // и почти не даёт экономии места. Snapshot — тяжёлый (десятки KB) и
    // долгоживущий, его уборка реально полезна.
    function pruneOrphanedSnapshots() {
      try {
        var rawSessions = localStorage.getItem(KEY_SESSIONS);
        var sessions = rawSessions ? JSON.parse(rawSessions) : [];
        var valid = {};
        for (var i = 0; i < sessions.length; i++) valid[sessions[i].id] = true;
        var toRemove = [];
        for (var j = 0; j < localStorage.length; j++) {
          var k = localStorage.key(j);
          if (!k || k.indexOf(KEY_VIEW) !== 0) continue;
          var sid = k.slice(KEY_VIEW.length);
          if (sid && !valid[sid]) toRemove.push(k);
        }
        for (var r = 0; r < toRemove.length; r++) {
          try { localStorage.removeItem(toRemove[r]); } catch (e) {}
        }
      } catch (e) {}
    }
    // Откладываем в idle-callback (или setTimeout) чтобы не блокировать
    // init createSessionStore — обход всего localStorage может занять
    // десяток ms при много открытых вкладок с большим storage.
    var deferIdle = global.requestIdleCallback || function (fn) { return setTimeout(fn, 0); };
    deferIdle(pruneOrphanedSnapshots);

    // Сохранение snapshot с защитой от переполнения localStorage.
    // Стратегия при QuotaExceededError:
    //   1) Урезаем displayMessages до последних 50 сообщений и пробуем снова.
    //   2) Если опять — удаляем все snapshot'ы других сессий этого же агента
    //      (они уже не активны, юзер при возврате подгрузит с сервера).
    //   3) Если и это не помогло — оставляем последние 20 сообщений.
    //   4) Если уж совсем — тихо отказываемся (next saveSnapshot повторит).
    var MAX_SNAPSHOT_MESSAGES = 100;
    // Базовая запись для конкретной сессии — используется и для активной,
    // и для чужой через pushToSession.
    function trySaveSnapshotTo(sid, messages) {
      try {
        localStorage.setItem(KEY_VIEW + sid, JSON.stringify(messages));
        return true;
      } catch (e) {
        return false;
      }
    }
    function pruneOtherSnapshots(keepSid) {
      var prefixView = KEY_VIEW;
      var current = KEY_VIEW + keepSid;
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefixView) === 0 && k !== current) toRemove.push(k);
      }
      for (var j = 0; j < toRemove.length; j++) {
        try { localStorage.removeItem(toRemove[j]); } catch (e) {}
      }
    }
    function saveSnapshot() {
      if (!store.activeSessionId) return;
      var sid = store.activeSessionId;
      var msgs = store.displayMessages;
      if (msgs.length > MAX_SNAPSHOT_MESSAGES) {
        msgs = msgs.slice(-MAX_SNAPSHOT_MESSAGES);
        store.displayMessages = msgs;
      }
      if (trySaveSnapshotTo(sid, msgs)) return;
      // Дошли сюда → quota exceeded на полном msgs. Дальше fallback'и
      // с уменьшением объёма. Юзеру показываем toast только один раз
      // на сессию, чтобы не спамить.
      var trimmed = msgs.slice(-50);
      if (trySaveSnapshotTo(sid, trimmed)) {
        store.displayMessages = trimmed;
        notifyQuotaWarning('История обрезана до последних 50 сообщений — хранилище заполнено.');
        return;
      }
      pruneOtherSnapshots(sid);
      if (trySaveSnapshotTo(sid, trimmed)) {
        store.displayMessages = trimmed;
        notifyQuotaWarning('Освобождено место: удалены snapshot\'ы других сессий.');
        return;
      }
      var minimal = msgs.slice(-20);
      if (trySaveSnapshotTo(sid, minimal)) {
        store.displayMessages = minimal;
        notifyQuotaWarning('История критично обрезана (20 сообщений) — хранилище переполнено.');
        return;
      }
      notifyQuotaWarning('Не удалось сохранить историю — хранилище переполнено.');
    }
    // Toast о quota — показываем не чаще раза в минуту.
    var lastQuotaWarn = 0;
    function notifyQuotaWarning(text) {
      var now = Date.now();
      if (now - lastQuotaWarn < 60000) return;
      lastQuotaWarn = now;
      showToast(text, 'warn');
    }

    function loadSnapshot(sid) {
      try {
        var s = localStorage.getItem(KEY_VIEW + sid);
        return s ? JSON.parse(s) : null;
      } catch (e) { return null; }
    }

    function clearSnapshot(sid) {
      try { localStorage.removeItem(KEY_VIEW + sid); } catch (e) {}
    }

    // Inflight-маркер: «в этой сессии идёт фоновая обработка».
    // Хранится в отдельном ключе localStorage, чтобы:
    //   1) не загрязнять snapshot (который попадает в renderMessages как сообщения)
    //   2) при возврате юзера в сессию A показать спиннер, даже если он
    //      переключался на B пока работало sendMsg.
    //
    // Тикающий «X сек» обновляется живым setInterval, который запускается на
    // setInflight и останавливается на clearInflight (или при switchTo в
    // сессию без inflight). Renderer (агентский renderChat) сам читает
    // getInflight() и рисует спиннер в конце чата.
    var inflightTimer = null;
    // Тикер обновляет ТОЛЬКО текст таймера в уже существующем DOM-элементе
    // loader'а — не дёргает renderMessages, иначе chat.innerHTML переписывался
    // бы каждую секунду и весь чат моргал.
    // Агентский renderChat при отрисовке loader'а должен:
    //   - повесить класс `gc-inflight-loader` на сам блок
    //   - сохранить startedAt в `data-started-at`
    //   - положить таймер в `<span class="timer">`
    function tickInflightDom() {
      var loaders = document.querySelectorAll('.gc-inflight-loader');
      for (var i = 0; i < loaders.length; i++) {
        var el = loaders[i];
        var startedAt = parseInt(el.getAttribute('data-started-at') || '0', 10);
        if (!startedAt) continue;
        var elapsed = Math.floor((Date.now() - startedAt) / 1000);
        var timerEl = el.querySelector('.timer');
        if (timerEl) timerEl.textContent = elapsed + ' сек';
      }
    }
    function startInflightTicker() {
      if (inflightTimer) return;
      inflightTimer = setInterval(tickInflightDom, 1000);
    }
    function stopInflightTicker() {
      // Не останавливаем тикер если в активной сессии ещё есть inflight
      // (multi-tab/multi-session: clearInflight чужой сессии не должен
      // ломать счётчик активного loader'а).
      if (store.activeSessionId && getInflight(store.activeSessionId)) return;
      if (inflightTimer) { clearInterval(inflightTimer); inflightTimer = null; }
    }
    function setInflight(sid, label) {
      if (!sid) return;
      // Защита от race: если сессия была удалена за время await
      // (extract длится секунды), не восстанавливаем inflight-маркер —
      // иначе он зависнет в localStorage до pruneStaleInflightMarkers (10 мин)
      // и будет показываться как «осиротевший» loader на другой сессии.
      if (!findSession(sid)) return;
      try {
        localStorage.setItem(KEY_INFLIGHT + sid, JSON.stringify({
          label: String(label || 'Обработка'),
          startedAt: Date.now()
        }));
      } catch (e) {}
      // Сразу обновляем UI и запускаем тикер.
      renderMessages(store.displayMessages);
      startInflightTicker();
    }
    function clearInflight(sid) {
      if (!sid) return;
      // R7.2: минимальное время показа loader'а 700мс. Если LLM отдаёт
      // ошибку моментально (network fail → пустой ответ → "Не удалось получить
      // ответ от LLM"), весь цикл проходил за ~100мс и юзер не успевал
      // увидеть таймер. Без этого юзеры жалуются «куда таймер пропал».
      var inflight = getInflight(sid);
      var MIN_VISIBLE_MS = 700;
      if (inflight && inflight.startedAt) {
        var elapsed = Date.now() - inflight.startedAt;
        if (elapsed < MIN_VISIBLE_MS) {
          var remaining = MIN_VISIBLE_MS - elapsed;
          setTimeout(function () { _doClearInflight(sid); }, remaining);
          return;
        }
      }
      _doClearInflight(sid);
    }
    function _doClearInflight(sid) {
      try { localStorage.removeItem(KEY_INFLIGHT + sid); } catch (e) {}
      stopInflightTicker();
      var loaders = document.querySelectorAll('.gc-inflight-loader');
      for (var i = 0; i < loaders.length; i++) loaders[i].remove();
    }
    function getInflight(sid) {
      if (!sid) return null;
      try {
        var raw = localStorage.getItem(KEY_INFLIGHT + sid);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    // Draft — текст, который юзер начал писать, но ещё не отправил.
    // Сохраняем за каждой сессией отдельно: переключился на другую и
    // вернулся — текст в input восстанавливается.
    function setDraft(sid, text) {
      if (!sid) return;
      try {
        if (text) localStorage.setItem(KEY_DRAFT + sid, text);
        else localStorage.removeItem(KEY_DRAFT + sid);
      } catch (e) {}
    }
    function clearDraft(sid) {
      if (!sid) return;
      try { localStorage.removeItem(KEY_DRAFT + sid); } catch (e) {}
    }
    function getDraft(sid) {
      if (!sid) return '';
      try {
        return localStorage.getItem(KEY_DRAFT + sid) || '';
      } catch (e) { return ''; }
    }

    // Утилита: пуш сообщения в активную сессию ИЛИ в snapshot чужой
    // (если юзер ушёл в другую сессию, пока шла обработка).
    // Возвращает true если push реально применён; false если сессия
    // была удалена. typewriteAssistant использует это чтобы НЕ начинать
    // печатать в чужой DOM, когда последний .msg.bot — не наш.
    function pushToSession(sid, msg) {
      if (!sid) return false;
      if (!findSession(sid)) return false; // сессия удалена — игнорируем
      if (sid === store.activeSessionId) {
        store.displayMessages.push(msg);
        saveSnapshot();
        renderMessages(store.displayMessages);
        applyHighlight();
      } else {
        var snap = loadSnapshot(sid) || [];
        snap.push(msg);
        if (snap.length > MAX_SNAPSHOT_MESSAGES) snap = snap.slice(-MAX_SNAPSHOT_MESSAGES);
        trySaveSnapshotTo(sid, snap);
      }
      return true;
    }

    function findSession(id) {
      for (var i = 0; i < store.sessions.length; i++) {
        if (store.sessions[i].id === id) return store.sessions[i];
      }
      return null;
    }

    // ============== Backend sync (sessions-sync.json workflow) ==============
    // Все мутации (create/rename/delete) уходят туда fire-and-forget.
    // Сетевые ошибки игнорируются — LS остаётся source-of-truth для UI.
    // При логине на новом ПК — pullFromBackend() подтянет сессии аккаунта.
    async function _syncPost(payload) {
      if (!syncWithBackend) return null;
      var token = (window.GigaChat && GigaChat.auth) ? GigaChat.auth.getToken() : '';
      if (!token) return null;
      payload.token = token;
      payload.agent = agentKey;
      try {
        var res = await fetch(webhookUrl('sessions-sync'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) return null;
        var data = await res.json();
        // auth_required при синхронизации — НЕ редиректим (вторичный feature).
        if (data && data.auth_required) return null;
        return data;
      } catch (e) {
        return null;
      }
    }
    function syncCreate(id, name, sortOrder) {
      _syncPost({ action: 'upsert', session_id: id, name: name, sort_order: sortOrder || 0 });
    }
    function syncRename(id, newName) {
      var s = findSession(id);
      if (!s) return;
      // S3 fix: sort_order НЕ шлём при rename — на backend COALESCE(NULLIF(0)) сохраняет старое.
      // Иначе любой rename перезатирал бы порядок на сервере на 0.
      _syncPost({ action: 'upsert', session_id: id, name: newName });
    }
    function syncDelete(id) {
      _syncPost({ action: 'delete', session_id: id });
    }
    // ============== pullFromBackend (S1+S2 fix) ==============
    // Tombstones через sync_seen Map в LS: id который мы УЖЕ ВИДЕЛИ на сервере.
    // Если он перестал приходить с сервера → удалён на другом ПК → удаляем локально.
    // Если id никогда не было на сервере (LS-only, юзер создал офлайн до sync)
    // → push upsert (back-fill). Это устраняет «воскрешение» удалённых сессий.
    // ВАЖНО: prefix (а не basePrefix — basePrefix живёт в scope createChatAgent,
    // здесь не виден). prefix = opts.prefix = basePrefix в caller'е, тот же
    // эффект, ту же изоляцию per-user.
    var KEY_SYNC_SEEN = prefix + '_sync_seen';
    function loadSyncSeen() {
      try {
        var raw = localStorage.getItem(KEY_SYNC_SEEN);
        return raw ? JSON.parse(raw) : {};
      } catch (e) { return {}; }
    }
    function saveSyncSeen(seenMap) {
      try { localStorage.setItem(KEY_SYNC_SEEN, JSON.stringify(seenMap)); } catch (e) {}
    }
    async function pullFromBackend() {
      if (!syncWithBackend) return;
      var data = await _syncPost({ action: 'list' });
      if (!data || data.response !== 'ok' || !Array.isArray(data.sessions)) return;
      var server = data.sessions;
      var serverIds = {};
      var changed = false;
      var seen = loadSyncSeen();
      // 1. Сервер → LS: добавляем что нет локально, обновляем имена при расхождении
      server.forEach(function (srv) {
        serverIds[srv.session_id] = true;
        seen[srv.session_id] = 1;  // отметить как «синхронизированный»
        var local = findSession(srv.session_id);
        if (!local) {
          store.sessions.push({ id: srv.session_id, name: srv.name });
          changed = true;
        } else if (local.name !== srv.name) {
          local.name = srv.name;  // server-wins
          changed = true;
        }
      });
      // 2. LS → сервер ИЛИ LS-cleanup:
      //    Был seen на сервере + сейчас отсутствует → удалён удалённо, удаляем локально.
      //    Никогда не был seen → новая локальная (back-fill upsert на сервер).
      var toRemove = [];
      store.sessions.forEach(function (loc) {
        if (serverIds[loc.id]) return;  // на сервере есть — ничего
        if (seen[loc.id]) {
          // Tombstone: был, но исчез → удалён на другом ПК
          toRemove.push(loc.id);
          delete seen[loc.id];
        } else {
          // Никогда не было на сервере → back-fill (push upsert)
          _syncPost({ action: 'upsert', session_id: loc.id, name: loc.name, sort_order: 0 });
        }
      });
      if (toRemove.length) {
        var removeSet = {};
        toRemove.forEach(function (id) { removeSet[id] = true; });
        store.sessions = store.sessions.filter(function (s) { return !removeSet[s.id]; });
        toRemove.forEach(function (id) {
          // Чистим всё связанное (snapshots, drafts, inflight)
          clearSnapshot(id); clearInflight(id); clearDraft(id);
          // Если активная — переключаем
          if (store.activeSessionId === id) {
            store.activeSessionId = store.sessions.length ? store.sessions[store.sessions.length - 1].id : null;
            if (!store.activeSessionId) onEmpty();
          }
        });
        changed = true;
      }
      saveSyncSeen(seen);
      if (changed) {
        save();
        renderList();
        renderMessages(store.displayMessages);
      }
    }
    // S1 fix: pullFromBackend больше НЕ запускается из конструктора через setTimeout.
    // Caller (createChatAgent) вызывает sessionStore.pullFromBackend() ЯВНО после
    // load() — гарантированно ПОСЛЕ заполнения store.sessions из LS, без race.

    function createNew() {
      store.sessionCounter++;
      // S7: crypto.randomUUID даёт 122 бита энтропии (vs 52 у Math.random),
      // коллизия при двойном клике/race практически невозможна. Fallback на
      // timestamp+random для старых браузеров без crypto.randomUUID.
      var uniq;
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        uniq = crypto.randomUUID().replace(/-/g, '');
      } else {
        uniq = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      }
      var id = idPrefix + uniq;
      var name = namePrefix + store.sessionCounter;
      store.sessions.push({ id: id, name: name });
      syncCreate(id, name, 0);
      // Сбрасываем фильтр поиска — иначе новая сессия может быть скрыта
      // существующим фильтром, юзер увидит чат но не сессию в сайдбаре.
      if (searchInput) {
        searchInput.value = '';
        sessionFilter = '';
        if (searchClearBtn) searchClearBtn.classList.remove('show');
      }
      return switchTo(id, { skipHistoryLoad: true });
    }

    async function switchTo(id, switchOpts) {
      switchOpts = switchOpts || {};
      var sameSession = (id === store.activeSessionId);
      // Если в текущей сессии активен typewriter — финализируем его ДО
      // смены сессии. Иначе после switchTo lastBot становится detached
      // (renderMessages destroy'ит old DOM), typewriter тихо умирает на
      // следующем тике, но snapshot уже содержит полный текст → при
      // возврате в сессию юзер видит «всё разом», без анимации.
      // Доступ к sendBtn — через callback (см. onBeforeSwitch выше),
      // чтобы не таскать сюда переменную из чужого scope.
      if (!sameSession) {
        try { onBeforeSwitch(id, store.activeSessionId); } catch (_) {}
      }
      store.activeSessionId = id;
      // Скрепку трогаем ТОЛЬКО если это переход в ДРУГУЮ сессию И
      // в фоне нет обработки. Иначе клик по уже-активной сессии в
      // сайдбаре терял прицепленный файл.
      if (!sameSession && !isProcessing()) onAttachmentClear();
      store.displayMessages = loadSnapshot(id) || [];
      renderList();
      save();
      renderMessages(store.displayMessages);
      applyHighlight();
      // Если в новой сессии есть inflight (обработка в фоне) — запускаем тикер
      // для живого «X сек», иначе останавливаем (бережём CPU).
      if (getInflight(id)) startInflightTicker();
      else stopInflightTicker();
      onSwitch(id, switchOpts);
      if (switchOpts.skipHistoryLoad) return;
      // ВАЖНО: пока в сессии идёт обработка (inflight), НЕ перезаписываем
      // displayMessages с сервера. Сервер может ещё не иметь свежего userMsg.
      if (loadHistory && !getInflight(id)) {
        try {
          var msgs = await loadHistory(id);
          if (store.activeSessionId !== id || getInflight(id)) return;
          if (Array.isArray(msgs)) {
            // Защита от потери локально-свежих сообщений: если на сервере
            // МЕНЬШЕ сообщений чем в локальном snapshot — значит БД ещё не
            // успела зафиксировать последний обмен (запись асинхронна).
            // В этом случае оставляем кэш — лучше показать пользователю
            // его сообщение, даже если оно «отстаёт» от сервера на 1-2 секунды.
            //
            // R7.37: skip rerender, если backend вернул столько же msgs,
            // сколько уже отрисовано из snapshot. На F5 это типичный кейс —
            // мы уже отрендерили локальный snapshot, и второй rerender
            // переигрывает stagger-анимацию карточек: юзер видит как поля
            // задач «прыгают» — появляются дважды. При msgs.length > snapshot
            // (реально прибавилось) — rerender нужен.
            if (msgs.length > store.displayMessages.length) {
              store.displayMessages = msgs;
              saveSnapshot();
              renderMessages(store.displayMessages);
              applyHighlight();
            }
          }
        } catch (e) {
          // тихо: оставляем кэш видимым
        }
      }
    }

    function remove(id, opts) {
      opts = opts || {};
      // По умолчанию спрашиваем подтверждение — клик по × раньше стирал
      // сессию вместе с историей мгновенно, промах = потеря. Передать
      // {skipConfirm:true} можно для программных вызовов (cleanup).
      if (!opts.skipConfirm) {
        var sess = findSession(id);
        var name = sess ? sess.name : 'сессию';
        if (!window.confirm('Удалить «' + name + '»?\nИстория и черновик будут удалены безвозвратно.')) return;
      }
      // Если в удаляемой сессии активный AbortController — отменяем fetch
      // и снимаем регистрацию, иначе pushToSession после resolve запишет
      // orphan-snapshot в удалённую сессию.
      var ctrl = getSendController(id);
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      unregisterSendController(id);
      store.sessions = store.sessions.filter(function (s) { return s.id !== id; });
      syncDelete(id);  // fire-and-forget удаление с сервера
      clearSnapshot(id);
      clearInflight(id);
      clearDraft(id);
      if (store.activeSessionId === id) {
        if (store.sessions.length > 0) {
          switchTo(store.sessions[store.sessions.length - 1].id);
        } else {
          store.activeSessionId = null;
          store.displayMessages = [];
          onEmpty();
        }
      }
      renderList();
      save();
    }

    function startRename(id) {
      store.editingSessionId = id;
      renderList();
      setTimeout(function () {
        if (!sessionList) return;
        var inp = sessionList.querySelector('.session-item.editing .name-edit');
        if (inp) { inp.focus(); inp.select(); }
      }, 0);
    }

    function finishRename(id, newName) {
      if (store.editingSessionId !== id) return;
      var s = findSession(id);
      if (s && newName && newName.trim()) {
        s.name = newName.trim();
        syncRename(id, s.name);  // fire-and-forget upsert на сервер
      }
      store.editingSessionId = null;
      save();
      renderList();
    }

    function cancelRename() {
      store.editingSessionId = null;
      renderList();
    }

    // Рендер сайдбара через createElement + addEventListener (без onclick-строк).
    // Это устраняет потенциальный XSS через id с кавычкой и упрощает дебаг.
    function renderList() {
      if (!sessionList) return;
      sessionList.innerHTML = '';
      for (var i = 0; i < store.sessions.length; i++) {
        var s = store.sessions[i];
        var item = document.createElement('div');
        item.className = 'session-item' +
          (s.id === store.activeSessionId ? ' active' : '') +
          (s.id === store.editingSessionId ? ' editing' : '');
        (function (sess) {
          item.addEventListener('click', function () { switchTo(sess.id); });
        })(s);

        if (s.id === store.editingSessionId) {
          var inp = document.createElement('input');
          inp.className = 'name-edit';
          inp.value = s.name;
          inp.addEventListener('click', function (e) { e.stopPropagation(); });
          (function (sess) {
            inp.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') { e.preventDefault(); finishRename(sess.id, inp.value); }
              else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
            });
            inp.addEventListener('blur', function () { finishRename(sess.id, inp.value); });
          })(s);
          item.appendChild(inp);
        } else {
          var name = document.createElement('span');
          name.className = 'name';
          name.textContent = s.name;
          item.appendChild(name);

          var edit = document.createElement('span');
          edit.className = 'edit';
          edit.setAttribute('aria-label', 'Переименовать');
          edit.innerHTML = PENCIL_SVG;
          (function (sess) {
            edit.addEventListener('click', function (e) { e.stopPropagation(); startRename(sess.id); });
          })(s);
          item.appendChild(edit);

          var close = document.createElement('span');
          close.className = 'close';
          close.setAttribute('aria-label', 'Удалить');
          // SVG-крестик 12px — визуально совпадает с pencil (тоже 12px svg),
          // тогда как textContent '×' выглядит выше из-за font-baseline.
          close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
          (function (sess) {
            close.addEventListener('click', function (e) { e.stopPropagation(); remove(sess.id); });
          })(s);
          item.appendChild(close);
        }
        sessionList.appendChild(item);
      }
      applySessionFilter(); // re-apply фильтра после перерисовки списка
    }

    // Multi-tab sync: если в другой вкладке этого же агента поменялся список
    // сессий, активная сессия или snapshot — реагируем.
    //   - sessions/active/counter изменились: перечитываем и перерисовываем
    //     сайдбар. Если активная сессия удалена в другой вкладке — переходим
    //     к последней доступной (или onEmpty).
    //   - snapshot активной сессии изменился: обновляем displayMessages.
    //
    // НЕ ловим события от собственной вкладки — браузер этого делать и не
    // должен (storage event только cross-tab).
    function handleStorageEvent(e) {
      if (!e.key) return;
      if (e.key === KEY_SESSIONS || e.key === KEY_ACTIVE || e.key === KEY_COUNTER) {
        // Другая вкладка изменила список или активную — перечитываем.
        var prevActive = store.activeSessionId;
        load();
        renderList();
        // Активная сессия исчезла → переключиться на последнюю или onEmpty.
        if (prevActive && !findSession(prevActive)) {
          if (store.sessions.length > 0) {
            switchTo(store.sessions[store.sessions.length - 1].id, { skipHistoryLoad: true });
          } else {
            store.activeSessionId = null;
            store.displayMessages = [];
            onEmpty();
          }
        }
      } else if (e.key === KEY_VIEW + store.activeSessionId) {
        // Активная сессия — её snapshot изменился в другой вкладке.
        store.displayMessages = loadSnapshot(store.activeSessionId) || [];
        renderMessages(store.displayMessages);
      } else if (e.key.indexOf(KEY_INFLIGHT) === 0) {
        // Inflight-маркер изменился в другой вкладке. Реагируем только если
        // это активная сессия — иначе loader просто появится при switchTo.
        var iSid = e.key.substring(KEY_INFLIGHT.length);
        if (iSid !== store.activeSessionId) return;
        if (e.newValue === null) {
          // Запрос завершён/отменён в другой вкладке → убираем loader и тикер.
          stopInflightTicker();
          var loaders = document.querySelectorAll('.gc-inflight-loader');
          for (var i = 0; i < loaders.length; i++) loaders[i].remove();
        } else {
          // Запрос начался в другой вкладке → перерисовываем чат (loader появится).
          renderMessages(store.displayMessages);
          startInflightTicker();
        }
      }
    }
    // Идемпотентность: если createChatAgent вызвали дважды (или встроили
    // двух агентов на одну страницу), хранить только последний handler.
    // Без этого старый listener живёт + новый = двойной switchTo на storage event.
    var handlerKey = '__gcStorageHandler_' + (opts.prefix || 'default');
    if (global[handlerKey]) {
      window.removeEventListener('storage', global[handlerKey]);
    }
    global[handlerKey] = handleStorageEvent;
    window.addEventListener('storage', handleStorageEvent);

    return {
      state: store,                              // прямой доступ к sessions/activeSessionId/displayMessages
      load: load,
      save: save,
      saveSnapshot: saveSnapshot,
      loadSnapshot: loadSnapshot,
      clearSnapshot: clearSnapshot,
      setInflight: setInflight,
      clearInflight: clearInflight,
      getInflight: getInflight,
      setDraft: setDraft,
      clearDraft: clearDraft,
      getDraft: getDraft,
      createNew: createNew,
      switchTo: switchTo,
      remove: remove,
      startRename: startRename,
      finishRename: finishRename,
      cancelRename: cancelRename,
      renderList: renderList,
      pushToSession: pushToSession,
      findSession: findSession,
      pullFromBackend: pullFromBackend  // S1 fix: caller вызывает после load()
    };
  }

  // ============================================================
  // ПСЕВДО-СТРИМИНГ (TYPEWRITER) ответа агента — markdown-aware
  // ============================================================
  // Универсальный паттерн для всех агентов:
  //   GigaChat.typewriteAssistant(sessionStore, sid, msg, { cps, containerSelector })
  //
  // Поведение:
  // 1. msg сразу пушится в snapshot и отрисовывается через formatBotHtml.
  //    Сохраняем результат как finalHtml (нужен в конце для extras: code-block
  //    у math, prompt-block у prompt-engineer, корректный highlight code).
  // 2. Очищаем DOM последнего .msg.bot и каждый тик 30fps пересобираем
  //    innerHTML через formatMarkdown(plainText.substring(0, i)).
  //    Незакрытые блоки (```code без закрытия, |table| без data-row,
  //    **bold без закрытия) отрисуются как raw text — это нормально,
  //    как только блок завершён в потоке, regex сразу его подхватит и
  //    отрендерит как настоящий HTML (таблицу, code-блок и т.п.).
  // 3. В конце i >= length — финальный swap на finalHtml (с extras и
  //    подсветкой синтаксиса через applyHighlight).
  //
  // Если юзер переключился на другую сессию во время typewriter — печать
  // прерывается тихо; при возврате он увидит полный текст из snapshot.
  // trimUnsafeMarkdown — отрезает от конца текста незавершённые markdown-блоки.
  // Зачем: пока поток пишет таблицу или код-блок по символам, парсер видит
  // незакрытый `|...|` или ```, не понимает что это, и отдаёт как сырые
  // символы. Юзер видит «мусор MD». Решение: пока блок не дописан до
  // безопасной точки, его символы скрываются. Когда поток допишет
  // закрывающую часть — блок появится сразу целиком (или построчно у
  // больших таблиц, по мере добавления строк).
  function trimUnsafeMarkdown(text) {
    // 1. Незакрытый код-блок (нечётное число ```)
    var ticks = (text.match(/```/g) || []).length;
    if (ticks % 2 === 1) {
      var lastTicks = text.lastIndexOf('```');
      text = text.substring(0, lastTicks);
    }
    // 2. Незавершённая таблица в конце: подряд идущие `|...|`-строки без
    //    separator-row `|---|`. Тогда это незаконченная разметка таблицы —
    //    прячем эти строки до появления separator'а.
    var lines = text.split('\n');
    var i = lines.length - 1;
    // Считаем сколько с конца идёт `|...|` строк подряд
    while (i >= 0 && lines[i].trim().startsWith('|')) i--;
    var tableStart = i + 1;
    if (tableStart < lines.length) {
      var hasSeparator = false;
      for (var j = tableStart; j < lines.length; j++) {
        if (/^\s*\|[-:|\s]+\|\s*$/.test(lines[j])) { hasSeparator = true; break; }
      }
      if (!hasSeparator) lines = lines.slice(0, tableStart);
    }
    return lines.join('\n');
  }

  // typewriteAssistant — псевдо-стриминг ответа с поддержкой:
  //   - smart auto-scroll (sticky bottom, при ручном скролле вверх — пауза)
  //   - stop-кнопка во время печати (sendBtn становится квадратом-стопом)
  //   - input разблокирован, юзер может писать новый запрос
  //   - при stop — отображаемый текст ОБРЕЗАЕТСЯ (полный есть в chat_memory)
  //   - trimUnsafeMarkdown скрывает партиальные таблицы/код-блоки
  //
  // Options:
  //   cps        — символов в секунду (default 200)
  //   sendBtn    — DOM-элемент кнопки «Отправить» (станет «Стоп» во время печати)
  //   input      — textarea ввода (не блокируется, чтобы юзер мог печатать)
  function typewriteAssistant(sessionStore, sid, msg, options) {
    options = options || {};
    var cps = options.cps || 200;
    var containerSelector = options.containerSelector || '.msg.bot';
    var sendBtn = options.sendBtn || null;
    var inputEl = options.input || null;
    // Цвет акцента для заголовков во время псевдо-стриминга. Без него
    // formatMarkdown подставляет дефолтный фиолетовый (#7c3aed), что не
    // совпадает с золотистым стилем prompt-engineer и других агентов.
    var accentColor = options.accentColor || null;
    var tickFps = 30;
    var tickIntervalMs = 1000 / tickFps;
    var charsPerTick = Math.max(1, Math.round(cps / tickFps));

    // Плавный auto-scroll через requestAnimationFrame — заменяет резкий
    // scrollTop = scrollHeight, который дёргал чат при появлении таблиц
    // и переносов строк во время typewriter.
    var scrollRafId = null;
    function smoothScrollToBottom(chatEl) {
      if (!chatEl) return;
      if (scrollRafId) cancelAnimationFrame(scrollRafId);
      function step() {
        var target = chatEl.scrollHeight - chatEl.clientHeight;
        var current = chatEl.scrollTop;
        var distance = target - current;
        if (distance < 1) { scrollRafId = null; return; }
        // 30% дистанции за кадр → ~10 кадров до цели = 166ms при 60fps
        var delta = Math.max(1, distance * 0.3);
        chatEl.scrollTop = current + delta;
        scrollRafId = requestAnimationFrame(step);
      }
      scrollRafId = requestAnimationFrame(step);
    }
    function focusInputIfPossible() {
      // Возвращаем фокус в поле ввода после завершения/остановки печати —
      // чтобы юзер мог сразу набирать следующее без клика по input.
      if (!inputEl) return;
      try { inputEl.focus(); } catch (e) {}
    }

    // 1) Положить в snapshot и отрисовать. После этого последний .msg.bot
    //    содержит финальный HTML (markdown отрендерен, extras на месте).
    var pushed = sessionStore.pushToSession(sid, msg);
    if (!pushed) return null;
    if (sid !== sessionStore.state.activeSessionId) return null;

    var botEls = document.querySelectorAll(containerSelector);
    var lastBot = botEls[botEls.length - 1];
    if (!lastBot) return null;

    var finalHtml = lastBot.innerHTML;
    var plainText = msg.content || msg.text || '';
    if (!plainText) return null;

    lastBot.innerHTML = '';

    // Auto-scroll: липкое дно. Перед каждым re-render запоминаем — был ли
    // юзер у дна. Если был — скроллим. Если нет (скроллил вверх) — не
    // трогаем. Возврат к низу автоматически возобновляет sticky-режим.
    var chatEl = lastBot.closest('#chat') || document.getElementById('chat');
    function isAtBottom() {
      if (!chatEl) return false;
      // 100px порог — устойчивее к разговорам с таблицами/кодом: пока юзер не
      // сильно отскроллил вверх, считаем что он «у дна» и продолжаем
      // auto-scroll. Иначе при появлении таблицы 200px чат «терялся» — порог
      // в 30px нарушался → следующий scroll не подтягивал → потом скачок.
      return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 100;
    }

    // Ручной скролл вверх юзером — БЛОКИРУЕТ auto-scroll до возврата к низу.
    // Без этого auto-scroll «возвращал» юзера в низ каждый тик, и читать
    // сообщение во время стриминга было невозможно. Возврат к низу
    // (естественный или явный scroll) снимает блок и возобновляет sticky.
    //
    // ВАЖНО: слушаем ТОЛЬКО `wheel` + `touchmove` — это примитивы реального
    // user input. Событие `scroll` НЕЛЬЗЯ использовать: оно срабатывает и на
    // программный `chatEl.scrollTop = X` (наш же `smoothScrollToBottom`),
    // `event.isTrusted` его не отличает. Если повесить на `scroll`, то наш
    // же RAF режет сам себя: каждый кадр меняет scrollTop → летит scroll →
    // distance > 30px → `userScrolledUp = true` → отмена RAF → анимация
    // обрывается посередине. Регрессия из BUG 4 fix.
    var userScrolledUp = false;
    function onUserScroll() {
      if (!chatEl) return;
      var atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 30;
      if (atBottom) {
        userScrolledUp = false;
      } else {
        userScrolledUp = true;
        // Отменяем текущую RAF-анимацию автоскролла — иначе юзер скроллит
        // вверх, а scrollTop возвращается обратно «рывками» по 30% за кадр.
        if (scrollRafId) { cancelAnimationFrame(scrollRafId); scrollRafId = null; }
      }
    }
    if (chatEl) {
      chatEl.addEventListener('wheel', onUserScroll, { passive: true });
      chatEl.addEventListener('touchmove', onUserScroll, { passive: true });
    }
    function cleanupScrollListeners() {
      if (!chatEl) return;
      chatEl.removeEventListener('wheel', onUserScroll);
      chatEl.removeEventListener('touchmove', onUserScroll);
    }

    // Stop-кнопка: подменяем send-icon на stop-icon, меняем aria-label.
    // При клике sendMsg в фабрике увидит class='streaming' и вызовет stop.
    // ВАЖНО: origSendIcon фиксируем как SEND_ICON_SVG, а не sendBtn.innerHTML
    // — потому что к моменту вызова typewriteAssistant фабрика sendMsg уже
    // вызвала makeCancellableSend, который установил STOP_ICON_SVG. Если
    // считать «оригинал» из DOM — после typewriter restoreSendButton вернёт
    // STOP_ICON_SVG, кнопка останется квадратом навсегда.
    var origSendLabel = sendBtn ? sendBtn.getAttribute('aria-label') : null;
    if (sendBtn) {
      sendBtn.classList.add('streaming');
      sendBtn.setAttribute('aria-label', 'Остановить печать');
      sendBtn.innerHTML = STOP_ICON_SVG;
    }
    var stopped = false;
    function restoreSendButton() {
      if (!sendBtn) return;
      sendBtn.classList.remove('streaming');
      if (origSendLabel) sendBtn.setAttribute('aria-label', origSendLabel);
      sendBtn.innerHTML = SEND_ICON_SVG;
      // Возвращаем фокус в input — после восстановления кнопки юзер сразу
      // может набирать следующее сообщение без лишнего клика.
      focusInputIfPossible();
    }

    var i = 0;
    var lastRendered = -1;
    var intervalId = setInterval(function () {
      if (sid !== sessionStore.state.activeSessionId) {
        clearInterval(intervalId);
        cleanupScrollListeners();
        restoreSendButton();
        return;
      }
      if (!lastBot.isConnected) {
        clearInterval(intervalId);
        cleanupScrollListeners();
        restoreSendButton();
        return;
      }
      if (stopped) {
        // Юзер нажал Стоп — оставляем то что уже видно, дальше не рисуем.
        clearInterval(intervalId);
        cleanupScrollListeners();
        attachCopyButtons(lastBot);
        applyHighlight(lastBot);
        restoreSendButton();
        return;
      }
      if (i >= plainText.length) {
        clearInterval(intervalId);
        cleanupScrollListeners();
        // Финальный swap: переключаемся на finalHtml с extras + highlight.
        lastBot.innerHTML = finalHtml;
        applyHighlight(lastBot);
        attachCopyButtons(lastBot);
        if (chatEl && isAtBottom() && !userScrolledUp) smoothScrollToBottom(chatEl);
        restoreSendButton();
        return;
      }
      var wasAtBottom = isAtBottom();
      i = Math.min(i + charsPerTick, plainText.length);
      if (i === lastRendered) return;
      lastRendered = i;
      var prefix = plainText.substring(0, i);
      // Прячем партиальные таблицы/код-блоки — иначе юзер видит сырой MD
      var safePrefix = trimUnsafeMarkdown(prefix);
      lastBot.innerHTML = formatMarkdown(safePrefix, accentColor);
      // attachCopyButtons был тут на каждый тик (30 fps) — на длинных ответах
      // (10K+ символов) это лишние allocations querySelector + DOM-mutations.
      // Код-блоки во время typing всё равно incomplete (trimUnsafeMarkdown их
      // скрывает), кнопки появятся в финальной фазе ниже.
      // Плавный scroll через RAF — без него чат дёргался скачками при появлении
      // таблиц (200px высоты сразу) и переносов строк.
      // userScrolledUp блокирует scroll если юзер сейчас читает выше — без
      // этой проверки чат возвращал в низ каждый тик, читать было невозможно.
      if (chatEl && wasAtBottom && !userScrolledUp) smoothScrollToBottom(chatEl);
    }, tickIntervalMs);

    var controller = {
      // cancel — внешняя отмена (свитч сессии и т.п.) — показывает полный текст
      cancel: function () {
        clearInterval(intervalId);
        cleanupScrollListeners();
        if (lastBot && lastBot.isConnected) {
          lastBot.innerHTML = finalHtml;
          applyHighlight(lastBot);
        }
        restoreSendButton();
      },
      // stop — юзер нажал стоп-кнопку — оставляет обрезанный текст
      stop: function () {
        stopped = true;
        cleanupScrollListeners();
      },
      isRunning: function () { return !stopped && i < plainText.length; }
    };

    // Сохраняем controller на sendBtn чтобы фабрика sendMsg могла его дёрнуть
    if (sendBtn) sendBtn._typewriterController = controller;

    return controller;
  }

  // ============================================================
  // ОБЩИЙ CSS для статус-индикаторов — переиспользуется в чат-агентах,
  // tool-страницах и дашборде. Один источник цветов/анимаций.
  // ============================================================
  var STATUS_CSS_INJECTED = false;
  function injectStatusDotCss() {
    if (STATUS_CSS_INJECTED) return;
    STATUS_CSS_INJECTED = true;
    var css =
      // gcPulse — пульсация статус-точек. gcBlink — мигание точек загрузки
      // в .loading .dots (используется в OCR-search-FIO и других tool-страницах).
      // Оба keyframe-а в одном месте, чтобы и agent-страницы (через injectAgentCss),
      // и tool-страницы (через injectToolCss) имели доступ.
      '@keyframes gcPulse{0%,100%{opacity:1}50%{opacity:.4}}' +
      '@keyframes gcBlink{0%,100%{opacity:.2}50%{opacity:1}}' +
      // Дефолтное (нейтральное) состояние всех точек — оранжевая пульсация.
      // Контейнер задаёт размер: header .status .dot (5px), .status-bar .dot (6px),
      // .status-dot (8px), .card-status (8px). Здесь — только цвет + анимация.
      '.dot,.status-dot,.card-status{background:#f0ad4e;animation:gcPulse 1s infinite}' +
      '.dot.online,.status-dot.online,.card-status.online{background:#4caf50;box-shadow:0 0 8px rgba(76,175,80,.5);animation:gcPulse 2s infinite}' +
      '.dot.offline,.status-dot.offline,.card-status.offline{background:#cc4444;box-shadow:0 0 8px rgba(204,68,68,.4);animation:none}' +
      '.dot.checking,.status-dot.checking,.card-status.checking{background:#f0ad4e;animation:gcPulse 1s infinite}';
    var style = document.createElement('style');
    style.setAttribute('data-gc-status-css', '1');
    style.textContent = css;
    if (document.head.firstChild) {
      document.head.insertBefore(style, document.head.firstChild);
    } else {
      document.head.appendChild(style);
    }
  }

  // ============================================================
  // ОБЩИЙ CSS tool-страниц — drop-zone, intro, btn-primary, status-bar,
  // result-box и т.п. Вызывается явно из каждой tool-страницы.
  // ============================================================
  var TOOL_CSS_INJECTED = false;
  function injectToolCss() {
    if (TOOL_CSS_INJECTED) return;
    TOOL_CSS_INJECTED = true;
    injectStatusDotCss(); // tool-страницы тоже используют .status-bar .dot
    var css =
      '*{margin:0;padding:0;box-sizing:border-box}' +
      'body{font-family:Segoe UI,Tahoma,sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh;display:flex;flex-direction:column}' +
      // Кнопка "домой" (та же что и в agent CSS, но tool body НЕ flex row)
      '.btn-home{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);text-decoration:none;flex-shrink:0;transition:background .15s,color .15s,border-color .15s}' +
      '.btn-home:hover{background:var(--bg-input);color:var(--text-primary);border-color:var(--text-muted)}' +
      '.btn-home svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
      // Header tool-страниц: padding больше чем у agent (14 vs 10)
      'header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;flex-shrink:0;position:relative;z-index:2}' +
      '.header-left{display:flex;align-items:center;gap:14px}' +
      '.header-right{display:flex;align-items:center;gap:12px}' +
      'header .btn-home{margin:0}' +
      'header h1{font-family:Consolas,monospace;font-size:20px;font-weight:600;color:var(--accent);letter-spacing:2px}' +
      // main колонка с центрированием на 900px (tool-страницы — пошаговые операции)
      'main{flex:1;padding:32px 24px;max-width:900px;width:100%;margin:0 auto}' +
      // .intro — описание инструмента сверху
      '.intro{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-bottom:24px}' +
      '.intro h2{font-size:15px;color:var(--text-primary);margin-bottom:10px;font-weight:600}' +
      '.intro p{color:var(--text-secondary);font-size:13.5px;line-height:1.6}' +
      '.intro p + p{margin-top:8px}' +
      '.intro code{background:var(--bg-input);padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;font-size:12px;color:var(--accent)}' +
      // .drop-zone — зона перетаскивания файла
      '.drop-zone{display:block;border:2px dashed var(--border);border-radius:12px;padding:40px 24px;text-align:center;transition:all .2s;cursor:pointer;background:var(--bg-card);margin-bottom:16px}' +
      '.drop-zone > *{pointer-events:none}' +
      '.drop-zone:hover,.drop-zone.dragging{border-color:var(--accent);background:var(--accent-light,rgba(212,165,116,.12))}' +
      '.drop-zone .icon{width:48px;height:48px;margin:0 auto 12px;color:var(--accent);opacity:.6}' +
      '.drop-zone .icon svg{width:100%;height:100%;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}' +
      '.drop-zone .title{font-size:15px;color:var(--text-primary);margin-bottom:6px;font-weight:500}' +
      '.drop-zone .hint{font-size:12px;color:var(--text-muted)}' +
      '.drop-zone .filename{color:var(--accent);font-size:14px;margin-top:12px;font-weight:600;word-break:break-all}' +
      '.drop-zone .filesize{color:var(--text-muted);font-size:12px;margin-top:4px;font-family:Consolas,monospace}' +
      // .btn-primary — основная кнопка действия (большая, акцентная)
      '.btn-primary{width:100%;padding:14px 28px;background:var(--accent);color:#0a0e15;border:none;border-radius:10px;cursor:pointer;font-size:14.5px;font-weight:600;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-bottom:16px}' +
      '.btn-primary:hover:not(:disabled){background:var(--accent-hover);transform:translateY(-1px)}' +
      '.btn-primary:disabled{opacity:.4;cursor:not-allowed;transform:none}' +
      // .loading panel (tool-вариант: блок с paddings, отображается через .show)
      '.loading{display:none;text-align:center;color:var(--text-secondary);font-size:14px;padding:20px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;margin-bottom:16px}' +
      '.loading.show{display:block}' +
      '.loading .timer{margin-top:8px;font-family:Consolas,monospace;font-size:14px;color:var(--accent)}' +
      // .progress-bar — индикатор прогресса
      '.progress-bar{width:100%;height:6px;background:var(--bg-input);border-radius:3px;margin-top:12px;overflow:hidden;display:none}' +
      '.progress-bar.show{display:block}' +
      '.progress-bar .fill{height:100%;background:var(--accent);border-radius:3px;transition:width .3s;width:0%}' +
      // .error-box — блок ошибки
      '.error-box{display:none;padding:14px 18px;border-radius:12px;line-height:1.6;font-size:14px;background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.4);color:#cc4444;white-space:pre-wrap;margin-bottom:16px}' +
      // .result-box family — панель результата с действиями
      '.result-box{display:none;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px}' +
      '.result-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--bg-input);flex-wrap:wrap;gap:8px}' +
      '.result-meta{font-size:12px;color:var(--text-secondary)}' +
      '.result-meta b{color:var(--text-primary)}' +
      '.result-actions{display:flex;gap:8px}' +
      '.btn-action{padding:6px 14px;background:transparent;border:1px solid var(--border);color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;transition:all .2s}' +
      '.btn-action:hover{border-color:var(--accent);color:var(--accent)}' +
      // .reset-btn — финальная зона "сбросить и начать заново"
      '.reset-btn{display:none;gap:10px;justify-content:flex-end}' +
      '.reset-btn.show{display:flex}' +
      '.reset-btn button{padding:10px 20px;background:transparent;color:var(--text-secondary);border:1px solid var(--border);border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;transition:all .2s}' +
      '.reset-btn button:hover{background:var(--accent-light,rgba(212,165,116,.15));color:var(--accent);border-color:var(--accent)}' +
      // .status-bar (контейнер статуса в шапке tool-страниц). Цвета точки — из injectStatusDotCss.
      '.status-bar{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);letter-spacing:.5px}' +
      '.status-bar .dot{width:6px;height:6px;border-radius:50%}';
    var style = document.createElement('style');
    style.setAttribute('data-gc-tool-css', '1');
    style.textContent = css;
    if (document.head.firstChild) {
      document.head.insertBefore(style, document.head.firstChild);
    } else {
      document.head.appendChild(style);
    }
  }

  // ============================================================
  // ОБЩИЙ CSS чат-агентов — устраняет ~150 строк копипаста в каждом HTML
  // ============================================================
  // Инжектится автоматически из createChatAgent (один раз на страницу).
  // Каждый чат-агент в HTML оставляет только специфичные правила:
  //   :root (переменные темы), #chat (контейнер с конкретным ID),
  //   #msg/#input-area (поле ввода с конкретным ID + размер),
  //   .empty-chat/.history-loading (если они в этом HTML),
  //   агент-специфика (code-block, agent-hint, prompt-block и т.п.).
  var AGENT_CSS_INJECTED = false;
  function injectAgentCss() {
    if (AGENT_CSS_INJECTED) return;
    AGENT_CSS_INJECTED = true;
    injectStatusDotCss(); // status-dot colors + gcPulse @keyframes
    var css =
      '*{margin:0;padding:0;box-sizing:border-box}' +
      'body{font-family:Segoe UI,Tahoma,sans-serif;background:var(--bg-primary);color:var(--text-primary);height:100vh;display:flex;overflow:hidden}' +
      // Кнопка "домой" в сайдбаре
      '.btn-home{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);text-decoration:none;flex-shrink:0;transition:background .15s,color .15s,border-color .15s}' +
      '.btn-home:hover{background:var(--bg-input);color:var(--text-primary);border-color:var(--text-muted)}' +
      '.btn-home svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
      // Sidebar (--sidebar-width per-page, fallback 270 — стандарт для чат-агентов)
      '.sidebar{width:var(--sidebar-width,270px);height:calc(100vh - 24px);margin:12px 0 12px 12px;background:var(--bg-sidebar);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}' +
      '.sidebar-header{padding:0 16px 12px}' +
      '.sidebar-header h3{font-size:13px;color:var(--text-secondary);letter-spacing:1px;text-transform:uppercase}' +
      '.sidebar-add{padding:10px 16px;border-bottom:1px solid var(--border)}' +
      '.sidebar-add button{width:100%;padding:8px;background:var(--bg-secondary);border:1px solid var(--border);color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:13px;text-align:center}' +
      '.sidebar-add button:hover{border-color:var(--accent);color:var(--accent)}' +
      // Search над списком сессий: обёртка для абсолютного позиционирования
      // крестика-clear. Сам input занимает всю ширину обёртки минус padding
      // справа под кнопку.
      '.gc-session-search-wrap{position:relative;margin:8px 16px}' +
      '.gc-session-search{display:block;width:100%;padding:6px 26px 6px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:12px;font-family:inherit;outline:none;transition:border-color .15s}' +
      '.gc-session-search:focus{border-color:var(--accent)}' +
      '.gc-session-search::placeholder{color:var(--text-muted)}' +
      // Кнопка × — справа в поле, появляется только когда есть текст (.show).
      // Hover-эффект совпадает с .session-item .close: bg=var(--bg-hover),
      // color=var(--accent). Размер 18×18 центрируется в поле (~28px высота)
      // через top:50% + translateY(-50%). SVG внутри центрируется через flex.
      '.gc-session-search-clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:18px;height:18px;display:none;align-items:center;justify-content:center;background:transparent;border:none;cursor:pointer;color:var(--text-secondary);border-radius:4px;opacity:.7;padding:0;transition:opacity .15s,background .15s,color .15s}' +
      '.gc-session-search-clear.show{display:flex}' +
      '.gc-session-search-clear:hover{background:var(--bg-hover);color:var(--accent);opacity:1}' +
      '.gc-session-search-clear svg{display:block}' + // убирает baseline-зазор у inline-SVG
      '.gc-session-search-clear:focus{outline:none}' +
      // Session list + items
      '.session-list{flex:1;overflow-y:auto;padding:8px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}' +
      '.session-item{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;margin:2px 0;border-radius:8px;cursor:pointer;font-size:13px;color:var(--text-secondary);transition:background 0.15s}' +
      '.session-item:hover{background:var(--bg-secondary)}' +
      '.session-item.active{background:var(--bg-secondary);color:var(--text-primary)}' +
      '.session-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.session-item .close,.session-item .edit{width:18px;height:18px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:var(--text-secondary);font-size:14px;flex-shrink:0;margin-left:4px;cursor:pointer;opacity:.7;transition:opacity .15s,background .15s,color .15s}' +
      '.session-item .edit{opacity:0}' +
      '.session-item:hover .edit{opacity:.8}' +
      '.session-item .edit svg,.session-item .close svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
      '.session-item .name-edit{flex:1;min-width:0;background:var(--bg-input,var(--bg-tertiary));border:1px solid var(--accent);color:var(--text-primary);font-size:13px;padding:4px 6px;border-radius:4px;outline:none;font-family:inherit}' +
      // R8.57: единый футер сайдбара (линия-разделитель + имя аккаунта слева).
      // Одинаковый отступ (padding 8px 10px) у всех агентов.
      '.sidebar-footer{border-top:1px solid var(--border);padding:8px 10px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.sidebar-account{font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}' +
      // Main column
      '.main{flex:1;min-width:0;display:flex;flex-direction:column;height:100vh}' +
      // Header bar (в prompt-engineer .header — div с тем же набором правил)
      'header,.main > .header{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;flex-shrink:0;position:relative;z-index:2}' +
      '.header-left{display:flex;align-items:center;gap:12px}' +
      '.header-right{display:flex;align-items:center;gap:12px}' +
      'header h1,.main > .header h1{font-family:Consolas,monospace;font-size:20px;font-weight:600;color:var(--accent);letter-spacing:2px}' +
      // Status indicator (только размер и контейнер; цвета и анимация
      // — в injectStatusDotCss, вызывается из injectAgentCss выше).
      'header .status{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:1;color:var(--text-secondary);letter-spacing:.5px}' +
      'header .status .dot{width:5px;height:5px;border-radius:50%;transform:translate(-4px,1px)}' +
      '.status-dot{width:8px;height:8px;border-radius:50%}' +
      // Кнопка экспорта (общая)
      '.btn-export{padding:6px 16px;background:var(--bg-secondary);border:1px solid var(--border);color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:12px;transition:all .2s}' +
      '.btn-export:hover{background:var(--accent-light,rgba(212,165,116,.15));color:var(--accent);border-color:var(--accent)}' +
      // .msg общие
      '.msg{animation:gcFadeIn .25s ease;line-height:1.55;font-size:14px;color:var(--text-primary);word-wrap:break-word;overflow-wrap:anywhere}' +
      '.msg + .msg{margin-top:40px}' +
      '@keyframes gcFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}' +
      '.msg.user{background:var(--bg-user);color:var(--accent);padding:10px 14px;border-radius:8px;word-break:break-all;font-size:14px;display:block;width:fit-content;max-width:min(720px,80%)}' +
      '.msg.bot{padding:0 4px;font-size:14px;display:block}' +
      '.bot b{color:var(--text-primary)}' +
      '.bot i{color:var(--text-secondary)}' +
      '.bot p{margin:0 0 12px 0}' +
      '.bot p:last-child{margin-bottom:0}' +
      '.bot code{background:var(--bg-secondary);padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;font-size:13.5px;color:var(--accent)}' +
      '.bot pre{background:var(--bg-secondary);padding:14px 16px;border-radius:8px;overflow-x:auto;margin:12px 0;white-space:pre;border:1px solid var(--border)}' +
      '.bot pre code{background:transparent;padding:0;color:var(--text-primary);font-size:13px}' +
      '.bot hr{border:none;border-top:1px solid var(--border);margin:16px 0}' +
      '.bot table{border-collapse:collapse;margin:12px 0;width:100%;font-size:13.5px}' +
      '.bot th,.bot td{border:1px solid var(--border);padding:8px 12px;text-align:left}' +
      '.bot th{background:var(--bg-secondary);color:var(--accent);font-weight:600}' +
      // Loading spinner общий
      '.loading{display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:13px;padding:14px 18px;font-style:italic}' +
      '.loading .dots span{display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--text-secondary);animation:gcBlink 1.4s infinite}' +
      '.loading .dots span:nth-child(2){animation-delay:.2s}' +
      '.loading .dots span:nth-child(3){animation-delay:.4s}' +
      // @keyframes gcBlink — в injectStatusDotCss (выше) чтобы tool-страницы тоже имели.
      // Inflight-loader (после user-msg во время LLM-запроса): сдвигаем под
      // слот copy-кнопки (которая absolute at top:100%+6, height 22) — иначе
      // hover-copy перекрывает текст dots+timer. margin-top:34px = 6 (gap до copy)
      // + 22 (высота copy) + 6 (gap после copy). padding-left:0 чтобы dots
      // стартовали на той же вертикали что и copy и user-msg.
      '.gc-inflight-loader{margin-top:34px;padding-left:0}' +
      // .error box
      '.error{background:rgba(239,68,68,.10);border:1px solid #cc4444;color:#cc4444;padding:12px 16px;border-radius:10px;margin:10px 0;font-size:13px}' +
      '.timer{font-family:Consolas,monospace;font-size:11px;color:var(--text-secondary);margin-left:8px}' +
      // .history-loading — состояние "Загружаю историю...". Используется дефолтным
      // historyLoadingHtml фабрики; раньше дублировался per-page в 2 файлах.
      '.history-loading{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:14px;font-style:italic}' +
      // .empty-chat — стартовое состояние «Создайте новую сессию для начала работы».
      // Раньше дублировалось в каждом HTML per-page (math/chat/rag/sql/router),
      // а prompt-engineer забыли — там текст висел в левом верхнем углу.
      // flex-direction:column + gap:8px — чтобы chat/router c многоэлементным
      // empty-state (memory-note, hint) корректно расставляли дочерние элементы.
      // Локальные :empty-chat в HTML агента переопределят дефолты (color/padding/
      // text-align в router и т.п.) — shared CSS вставлен в начало head, инлайн
      // в HTML идёт после, выигрывает каскад.
      '.empty-chat{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:14px;gap:8px}';
    var style = document.createElement('style');
    style.setAttribute('data-gc-agent-css', '1');
    style.textContent = css;
    // Вставляем В НАЧАЛО head, чтобы локальные :root и per-page правила
    // в HTML перекрывали наши дефолты (особенно цвет/размер, если автор
    // намеренно переопределил).
    if (document.head.firstChild) {
      document.head.insertBefore(style, document.head.firstChild);
    } else {
      document.head.appendChild(style);
    }
  }

  // ============================================================
  // CHAT-AGENT FACTORY — устраняет ~700 строк дубликата в 5+ HTML
  // ============================================================
  // Шаблонная фабрика, инкапсулирующая всё что общее у chat/rag/sql/math:
  //   - sessionStore с правильным префиксом и колбэками
  //   - renderChat (user-msg с чипами + bot-msg через formatBotHtml)
  //   - sendMsg (push user → setInflight → extract files → fetch → typewriter)
  //   - exportChat (.txt дамп)
  //   - attachment setup с drop-zone, sidebar resize, scroll-to-bottom
  //   - keydown (Enter=отправить, Shift+Enter=перенос), input autosize, draft
  //   - health-check + интервал
  //
  // Опции:
  //   webhookPath          — путь для основного webhook ('chat', 'rag-search' и т.п.)
  //   historyPath          — путь для истории (default 'history')
  //   prefix/idPrefix/namePrefix — для sessionStore
  //   inflightLabel        — лейбл спиннера во время LLM-запроса ('Думаю', 'Считаю', ...)
  //   exportAgentName      — имя в [тэге] .txt экспорта ('GigaChat Talk' и т.п.)
  //   emptyChatHtml        — HTML пустого состояния
  //   historyErrorHtml     — HTML при провале loadHistory
  //   sidebarInitialWidth/Min/Max — параметры initSidebarResize
  //   formatBotHtml(msg)   — кастомный рендер bot-сообщения (default = formatMarkdown(content))
  //   parseBotMessage(data) — превратить response JSON в msg-объект
  //   parseHistoryMessage(m) — мапер для loadHistory ответа
  //   useTypewriter        — bool, default true
  //
  // DOM IDs (можно переопределить через ...El опции):
  //   #chat, #msg, #send, #sessionList, #statusDot, #statusText,
  //   #attachBtn, #attachChips, .sidebar, .bottom-area
  function createChatAgent(opts) {
    opts = opts || {};
    injectAgentCss();
    // R7 BUG #11/#12 fix: захватываем markdownAccent в outer scope.
    // Иначе внутри sendMsg(opts) параметр перекрывает outer opts → opts.markdownAccent
    // падает с «Cannot read properties of undefined» при отправке без args.
    var __agentMarkdownAccent = opts.markdownAccent || null;
    var chat = opts.chatEl || document.getElementById('chat');
    var input = opts.inputEl || document.getElementById('msg');
    var sendBtn = opts.sendBtn || document.getElementById('send');
    var sessionListEl = opts.sessionListEl || document.getElementById('sessionList');
    var statusDot = opts.statusDot || document.getElementById('statusDot');
    var statusText = opts.statusText || document.getElementById('statusText');
    // Защитная диагностика: без этих узлов factory тихо сломается на
    // первом innerHTML/onclick. Лучше явный throw — будет понятно что
    // на странице нет нужного ID (опечатка в HTML или подключение из
    // неподходящего контекста).
    var missing = [];
    if (!chat) missing.push('chat (chatEl)');
    if (!input) missing.push('input (inputEl)');
    if (!sendBtn) missing.push('send button (sendBtn)');
    if (!sessionListEl) missing.push('session list (sessionListEl)');
    if (missing.length) {
      throw new Error('GigaChat.createChatAgent: на странице не найдены DOM-узлы: ' + missing.join(', '));
    }

    var WEBHOOK_URL = opts.webhookPath ? webhookUrl(opts.webhookPath) : null;
    var HISTORY_URL = webhookUrl(opts.historyPath || 'history');
    // resolveSendUrl(): динамический URL для каждого sendMsg (router использует
    // его для маршрутизации в выбранный агент). Если не передан — статический.
    var resolveSendUrl = opts.resolveSendUrl || function () { return WEBHOOK_URL; };
    var inflightLabel = opts.inflightLabel || 'Обработка';
    // exportBotLabel(msg): динамический лейбл бота в [тэге] экспорта.
    // Router возвращает AGENT_LABELS[msg.agent] (каждое сообщение — свой агент).
    var exportBotLabel = opts.exportBotLabel || function () { return exportAgentName; };
    // getInflightLabel(phase): 'extract' (извлечение файлов) или 'send' (LLM-запрос).
    // Router возвращает AGENT_LABELS[currentAgent] для фазы 'send'.
    var getInflightLabel = opts.getInflightLabel || function (phase) {
      return phase === 'extract' ? 'Извлекаю файлы' : inflightLabel;
    };
    // enrichUserMsg/enrichBotMsg: мутаторы перед pushToSession. Router
    // добавляет `agent: currentAgent` чтобы каждое сообщение помнило свой агент.
    var enrichUserMsg = opts.enrichUserMsg || function () {};
    var enrichBotMsg = opts.enrichBotMsg || function () {};
    // userBadgeHtml(m, nextMsg): HTML который вставляется в user-msg справа.
    // Router рендерит inflight-agent-badge с именем агента.
    var userBadgeHtml = opts.userBadgeHtml || function () { return ''; };
    // onInputExtra/onSwitchExtra/onSendStart: дополнительные действия в
    // ключевых точках жизненного цикла. Router использует для classify(),
    // dropdown'а agent-hint, и т.п.
    var onInputExtra = opts.onInputExtra || function () {};
    var onSwitchExtra = opts.onSwitchExtra || function () {};
    var onSendStart = opts.onSendStart || function () {};
    var exportAgentName = opts.exportAgentName || 'GigaChat';
    var emptyChatHtml = opts.emptyChatHtml ||
      '<div class="empty-chat"><span>Создайте новую сессию для начала работы</span></div>';
    var historyErrorHtml = opts.historyErrorHtml ||
      '<div class="empty-chat"><span>Не удалось загрузить историю.</span></div>';
    var historyLoadingHtml = opts.historyLoadingHtml ||
      '<div class="history-loading">Загружаю историю...</div>';
    var useTypewriter = opts.useTypewriter !== false;
    var autosizeMax = opts.autosizeMax || 150;
    var statusDotClass = opts.statusDotClass || 'dot';

    var formatBotHtml = opts.formatBotHtml || function (msg) {
      return formatMarkdown(msg.content || '');
    };
    var parseBotMessage = opts.parseBotMessage || function (data) {
      return { role: 'assistant', content: data.response || data.output || 'Пустой ответ от сервера' };
    };
    var parseHistoryMessage = opts.parseHistoryMessage || function (m) {
      var r = { role: m.role, content: m.content };
      if (m.extras) r.extras = m.extras;
      return r;
    };
    // interceptBotData(data, ctx) — async-перехват ответа webhook'а ДО parseBotMessage.
    // Возвращает (или Promise<>) новый data. math-агент использует это, чтобы
    // выполнить полученный Python-код в Pyodide и сделать второй HTTP-запрос
    // за объяснением. ctx = { sendUrl, sessionId, message, signal, sessionStore,
    // setInflightLabel(label) — обновляет текст лоадера на лету }.
    var interceptBotData = opts.interceptBotData || null;
    // extraBody({sessionId, message}) — функция, возвращающая объект с дополнительными
    // полями для тела POST-запроса в webhook. Plane-агент использует это, чтобы
    // прокинуть token (auth_sessions), workspace_slug, plane_url, plane_token.
    // Если опция не задана — тело отправляется без доп. полей (как раньше).
    var userExtraBody = opts.extraBody || function () { return {}; };

    // userScoped: true — изоляция данных юзера. Делает:
    //   1) Префикс sessionStore = opts.prefix + '_' + userPrefix(username)
    //      → sessions/история/драфты в localStorage НЕ пересекаются между юзерами
    //   2) Автоматическая подмешка token в extraBody → backend знает кто юзер
    //      и фильтрует chat-memory по user_id (workflow делает Verify token).
    // По умолчанию false (обратная совместимость).
    var userScoped = opts.userScoped === true;
    var basePrefix = opts.prefix;
    if (userScoped) {
      var uPfx = authUserPrefix();
      basePrefix = opts.prefix + '_' + uPfx;
    }
    // Финальная extraBody: если userScoped → token подмешивается всегда (плюс
    // что вернул юзер в своём callback'е, его поля имеют приоритет).
    var extraBody = userScoped
      ? function (ctx) {
          var u = userExtraBody(ctx) || {};
          if (u.token == null) u.token = authGetToken();
          return u;
        }
      : userExtraBody;

    var attachment = null;
    // ВАЖНО: при userScoped игнорируем явный opts.idPrefix — иначе session ID
    // будут одинаковы для разных юзеров (router_1, router_2), и backend chat-memory
    // (ключ = session_id) даст коллизию. Принудительно basePrefix-based ID,
    // т.е. session ID = router_<userPrefix>_1 — уникальный per-user.
    //
    // syncWithBackend (userScoped) → cross-device sync через /webhook/sessions-sync.
    // agentKey = opts.prefix (без user-префикса) — это значение поля agent в БД,
    // одно и то же для всех ПК одного аккаунта.
    var sessionStore = createSessionStore({
      prefix: basePrefix,
      idPrefix: userScoped ? (basePrefix + '_') : (opts.idPrefix || (basePrefix + '_')),
      namePrefix: opts.namePrefix || (opts.prefix + '-'),
      sessionList: sessionListEl,
      syncWithBackend: userScoped,
      agentKey: opts.prefix,
      renderMessages: function () { renderChat(); },
      onAttachmentClear: function () {
        if (attachment) { attachment.cancel(); attachment.clear(); attachment.setDisabled(false); }
      },
      // Отмена живого typewriter'а ДО смены activeSessionId — sendBtn здесь
      // в scope, в отличие от switchTo (которая в createSessionStore).
      onBeforeSwitch: function (newId, oldId) {
        if (sendBtn && sendBtn._typewriterController &&
            typeof sendBtn._typewriterController.isRunning === 'function' &&
            sendBtn._typewriterController.isRunning()) {
          try { sendBtn._typewriterController.cancel(); } catch (_) {}
        }
      },
      onEmpty: function () {
        chat.innerHTML = emptyChatHtml;
        input.disabled = true; sendBtn.disabled = true;
        if (attachment) attachment.setDisabled(true);
      },
      onSwitch: function (sid) {
        var draft = sessionStore.getDraft(sid) || '';
        input.value = draft;
        input.style.height = '';
        input.style.overflowY = 'hidden';
        if (draft) {
          // R7.40: используем ту же логику auto/hidden что и в input listener.
          var sh0 = input.scrollHeight;
          if (sh0 > autosizeMax) {
            input.style.height = autosizeMax + 'px';
            input.style.overflowY = 'auto';
          } else {
            input.style.height = sh0 + 'px';
          }
        }
        var processing = !!sessionStore.getInflight(sid);
        input.disabled = processing;
        sendBtn.disabled = false;
        syncSendButton(sendBtn, sid, processing);
        if (attachment) attachment.setDisabled(processing);
        if (!processing) input.focus();
        onSwitchExtra(sid, draft);
      },
      loadHistory: async function (sid) {
        // Loading HTML — пишем только если `sid` сейчас активен (на момент
        // вызова это всегда так, см. switchTo). Это страховка для будущих
        // вызовов из другого контекста.
        if (sessionStore.state.activeSessionId === sid &&
            !sessionStore.state.displayMessages.length &&
            !sessionStore.getInflight(sid)) {
          chat.innerHTML = historyLoadingHtml;
        }
        try {
          var res = await fetchWithRetry(HISTORY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            // H1 fix: шлём токен — backend проверяет его и владение сессией (IDOR)
            body: JSON.stringify({ session_id: sid, token: authGetToken() })
          }, { timeout: 30000, retries: 0 });
          if (!res.ok) throw new Error('Сервер ответил ' + res.status);
          var data = await res.json();
          var msgs = (data.messages || []).map(parseHistoryMessage);
          // R8.38 (#3): если loadHistory вернул пустоту, а chat сейчас показывает
          // "Загружаю историю..." (msgs пуст И snapshot пуст) — рендерим
          // empty-chat. Иначе застряем на loading-тексте навсегда: R7.37
          // skip-rerender в switchTo не пере-рендерит когда msgs.length ==
          // displayMessages.length (оба нуля), и historyLoadingHtml остаётся.
          if (msgs.length === 0 &&
              sessionStore.state.activeSessionId === sid &&
              !sessionStore.state.displayMessages.length) {
            chat.innerHTML = emptyChatHtml;
          }
          return msgs;
        } catch (e) {
          // КРИТИЧНО: после await sid мог стать неактивным (юзер переключил
          // сессию). Без этой проверки error-HTML перетрёт чат ДРУГОЙ сессии.
          if (sessionStore.state.activeSessionId === sid &&
              !sessionStore.state.displayMessages.length &&
              !sessionStore.getInflight(sid)) {
            chat.innerHTML = historyErrorHtml;
          }
          return null;
        }
      }
    });

    function renderChat() {
      var sessions = sessionStore.state.sessions;
      var activeSessionId = sessionStore.state.activeSessionId;
      var displayMessages = sessionStore.state.displayMessages;
      if (!activeSessionId || !sessions.find(function (s) { return s.id === activeSessionId; })) {
        chat.innerHTML = emptyChatHtml;
        return;
      }
      var html = '';
      for (var i = 0; i < displayMessages.length; i++) {
        var m = displayMessages[i];
        if (m.role === 'user') {
          var userBody = m.content ? escapeHtml(m.content) : '';
          var atts = m.attachments
            ? m.attachments
            : (m.attachment ? [{ fileName: m.attachment, error: !!m.attachmentError }] : []);
          if (atts.length > 0) {
            var chipsHtml = '';
            for (var k = 0; k < atts.length; k++) {
              var att = atts[k];
              var cls = att.error ? 'gc-attach-chip bot error' : 'gc-attach-chip bot';
              chipsHtml += '<span class="' + cls + '">📎 ' + escapeHtml(att.fileName) + '</span>';
            }
            var spacing = userBody ? 'margin-top:8px' : '';
            userBody += '<div style="' + spacing + ';display:flex;flex-wrap:wrap;gap:6px">' + chipsHtml + '</div>';
          }
          // Дополнительный HTML справа от user-msg (router → inflight-agent-badge).
          var nextMsg = (i + 1 < displayMessages.length) ? displayMessages[i + 1] : null;
          var badge = userBadgeHtml(m, nextMsg) || '';
          // data-ts только если ts реально есть — иначе исторические сообщения
          // (parseHistoryMessage без ts) получают data-ts="0" → null-attribute шум.
          var userTsAttr = m.ts ? ' data-ts="' + m.ts + '"' : '';
          html += '<div class="msg user"' + userTsAttr + '>' + userBody + badge + '</div>';
        } else {
          var botTsAttr = m.ts ? ' data-ts="' + m.ts + '"' : '';
          html += '<div class="msg bot"' + botTsAttr + '>' + formatBotHtml(m) + '</div>';
        }
      }
      var inflight = sessionStore.getInflight(activeSessionId);
      if (inflight) {
        var elapsed = Math.floor((Date.now() - inflight.startedAt) / 1000);
        html += '<div class="loading gc-inflight-loader" data-started-at="' + inflight.startedAt + '">' +
          '<span class="dots"><span></span><span></span><span></span></span>' +
          '<span class="timer">' + elapsed + ' сек</span></div>';
      }
      var wasAtBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;
      // Сохраняем scrollTop ДО innerHTML — иначе при replace innerHTML браузер
      // сбрасывает scrollTop в 0, и юзер видит «прыжок в самый верх + рывок
      // обратно вниз». Если юзер читает старые сообщения — сохраняем позицию.
      var savedScrollTop = chat.scrollTop;
      // R7.46: первый рендер чата (после F5 / boot) — instant scroll к низу.
      // Иначе юзер видит чат сверху и плавную прокрутку вниз. После первого
      // рендера переключаемся на плавный режим (для push новых сообщений).
      var isFirstRender = !chat.__rendered;
      chat.__rendered = true;
      chat.innerHTML = html;
      attachCopyButtons(chat);
      if (isFirstRender) {
        // Instant — без анимации, до того как браузер успел нарисовать первый кадр.
        chat.scrollTop = chat.scrollHeight;
      } else if (wasAtBottom) {
        // Плавный scroll к низу — раньше при таблице/вложениях скачок.
        smoothScrollChat(chat);
      } else {
        // Юзер читал что-то — синхронно возвращаем туда же, без анимации.
        chat.scrollTop = savedScrollTop;
      }
    }

    var chatScrollRafId = null;
    function smoothScrollChat(chatEl) {
      if (!chatEl) return;
      if (chatScrollRafId) cancelAnimationFrame(chatScrollRafId);
      function step() {
        var target = chatEl.scrollHeight - chatEl.clientHeight;
        var current = chatEl.scrollTop;
        var distance = target - current;
        if (distance < 1) { chatScrollRafId = null; return; }
        chatEl.scrollTop = current + Math.max(1, distance * 0.3);
        chatScrollRafId = requestAnimationFrame(step);
      }
      chatScrollRafId = requestAnimationFrame(step);
    }

    async function sendMsg(opts) {
      // opts.viaButton = true (default) — клик по кнопке = отмена запущенного запроса.
      // opts.viaButton = false — Enter, который НЕ должен отменять (двусмысленный UX:
      // юзер хочет «отправить второе», а получал «отменить первое»).
      var viaButton = !opts || opts.viaButton !== false;

      // Если typewriter сейчас печатает, эта кнопка — стоп-кнопка.
      // Останавливаем typewriter (текст после остановки не появится),
      // показываем стрелку отправки. Сам запрос НЕ отправляем.
      // Юзер сможет ввести новый запрос и кликнуть send заново.
      if (sendBtn.classList.contains('streaming') && sendBtn._typewriterController) {
        if (!viaButton) return; // Enter не останавливает typewriter
        sendBtn._typewriterController.stop();
        return;
      }
      var activeSessionId = sessionStore.state.activeSessionId;
      var sessions = sessionStore.state.sessions;
      if (!activeSessionId || !sessions.find(function (s) { return s.id === activeSessionId; })) return;
      var existing = getSendController(activeSessionId);
      if (existing) {
        if (!viaButton) return; // Enter не отменяет активный запрос
        existing.abort();
        // UI восстановит .catch блок основного sendMsg при пробросе
        // AbortError из fetchWithRetry. fetchWithRetry теперь имеет
        // abortable sleep — abort пропагируется через ms.
        return;
      }
      if (sessionStore.getInflight(activeSessionId)) {
        if (!viaButton) return;
        sessionStore.clearInflight(activeSessionId);
        return;
      }
      var text = input.value.trim();
      var hasFiles = attachment && attachment.hasFiles();
      if (!text && !hasFiles) return;
      if (sessionStore.getInflight(activeSessionId)) return;
      var sendSessionId = activeSessionId;
      var sendUrl = resolveSendUrl();
      var fileNamesSnapshot = hasFiles
        ? attachment.getFiles().map(function (f) { return f.name; })
        : [];
      input.disabled = true; sendBtn.disabled = true;
      if (attachment) attachment.setDisabled(true);
      // R7.40: после очистки сразу прячем скроллбар (контент пустой).
      input.value = ''; input.style.height = 'auto'; input.style.overflowY = 'hidden';
      sessionStore.clearDraft(sendSessionId);
      onSendStart();
      var userMsg = { role: 'user', content: text, ts: Date.now() };
      if (fileNamesSnapshot.length > 0) {
        userMsg.attachments = fileNamesSnapshot.map(function (n) {
          return { fileName: n, error: false };
        });
      }
      enrichUserMsg(userMsg);
      sessionStore.pushToSession(sendSessionId, userMsg);
      sessionStore.setInflight(sendSessionId, hasFiles ? getInflightLabel('extract') : getInflightLabel('send'));

      var messageForAgent = text;
      function abortAndRestore() {
        sessionStore.clearInflight(sendSessionId);
        // Если юзер ушёл в другую сессию — НЕ трогаем displayMessages (она
        // принадлежит другой сессии, msgs.pop удалит ЕЁ user-сообщение).
        // Orphan user-msg остаётся в snapshot'е sendSession — юзер увидит
        // его при возврате, что лучше чем corrupt другой сессии.
        if (sessionStore.state.activeSessionId !== sendSessionId) return;
        var msgs = sessionStore.state.displayMessages;
        if (msgs.length && msgs[msgs.length - 1].role === 'user') {
          msgs.pop();
          sessionStore.saveSnapshot();
        }
        input.disabled = false; sendBtn.disabled = false;
        if (attachment) attachment.setDisabled(false);
        input.value = text;
        input.focus();
        renderChat();
      }
      if (hasFiles) {
        var cancelled = false;
        var loader = document.querySelector('.gc-inflight-loader');
        if (loader) {
          var cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'btn-export';
          cancelBtn.style.cssText = 'padding:2px 10px;margin-left:8px';
          cancelBtn.textContent = 'Отмена';
          cancelBtn.onclick = function () { cancelled = true; attachment.cancel(); };
          loader.appendChild(cancelBtn);
        }
        var extractedList = await attachment.extract();
        if (cancelled) { abortAndRestore(); return; }
        var totalLen = 0;
        for (var i = 0; i < extractedList.length; i++) totalLen += (extractedList[i].text || '').length;
        if (totalLen > 30000) {
          var ok = confirm('Извлечено ' + totalLen.toLocaleString('ru-RU') + ' симв. из ' +
            extractedList.length + ' файла(ов).\nGigaChat может не справиться.\nОтправить всё равно?');
          if (!ok) { abortAndRestore(); return; }
        }
        var built = buildMessageWithAttachment(text, extractedList);
        messageForAgent = built.messageForAgent;
        // ВАЖНО: после долгого await extract() юзер мог переключиться в
        // другую сессию. displayMessages теперь ОТНОСИТСЯ к новой активной
        // сессии, и мутация прикрепила бы наши файлы к её user-msg → порча.
        // Поэтому мутируем только если sendSession всё ещё активна.
        // Если нет — chips с файлами были видны в момент отправки, юзер
        // увидит их при возврате в сессию через snapshot (push сохранил
        // attachments=[{fileName,error:false}] ранее).
        if (sessionStore.state.activeSessionId === sendSessionId) {
          var msgs2 = sessionStore.state.displayMessages;
          for (var j = msgs2.length - 1; j >= 0; j--) {
            if (msgs2[j].role === 'user') {
              msgs2[j].attachments = built.attachments;
              break;
            }
          }
          sessionStore.saveSnapshot();
        }
        sessionStore.setInflight(sendSessionId, getInflightLabel('send'));
      }

      var sendCtrl = makeCancellableSend(sendBtn, sendSessionId);
      try {
        // Базовое тело + произвольные доп. поля от extraBody() (token, plane-настройки).
        // Если extraBody вернул объект с полями message/session_id — НЕ перезаписываем,
        // чтобы случайный override из callback'а не сломал sendSessionId.
        var bodyObj = Object.assign({}, extraBody({ sessionId: sendSessionId, message: messageForAgent }) || {});
        bodyObj.message = messageForAgent;
        bodyObj.session_id = sendSessionId;
        var res = await fetchWithRetry(sendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(bodyObj)
        }, { retries: MAX_RETRIES, signal: sendCtrl.signal });
        sessionStore.clearInflight(sendSessionId);
        if (!res.ok) throw new Error('Сервер вернул ошибку: ' + res.status);
        var data = await res.json();
        if (interceptBotData) {
          // Хук получает возможность подменить data (math: исполнение Pyodide +
          // второй webhook за объяснением). На время работы хука возвращаем
          // inflight-лоадер — пользователь видит, что мы ещё не закончили.
          sessionStore.setInflight(sendSessionId, getInflightLabel('send'));
          try {
            data = await interceptBotData(data, {
              sendUrl: sendUrl,
              sessionId: sendSessionId,
              message: messageForAgent,
              signal: sendCtrl.signal,
              sessionStore: sessionStore,
              setInflightLabel: function (label) {
                sessionStore.setInflight(sendSessionId, label);
              }
            });
          } finally {
            sessionStore.clearInflight(sendSessionId);
          }
        }
        // Глобальная обработка auth_required: если userScoped и сервер
        // ответил «не авторизован» — чистим токен и редиректим на login.
        // Покрывает все агенты разом, чтобы каждый не дублировал логику.
        if (userScoped && data && data.auth_required) {
          authClearAuth();
          authRedirectToLogin();
          sessionStore.clearInflight(sendSessionId);
          return;
        }
        var botMsg = parseBotMessage(data);
        if (!botMsg.ts) botMsg.ts = Date.now();
        enrichBotMsg(botMsg);
        if (useTypewriter) {
          typewriteAssistant(sessionStore, sendSessionId, botMsg, {
            cps: 200,
            sendBtn: sendBtn,
            input: input,
            // Прокидываем агентский accent чтобы streaming заголовки
            // были того же цвета что и финальный рендер.
            accentColor: __agentMarkdownAccent
          });
        } else {
          sessionStore.pushToSession(sendSessionId, botMsg);
        }
        statusDot.className = statusDotClass + ' online'; statusText.textContent = 'Онлайн';
      } catch (e) {
        sessionStore.clearInflight(sendSessionId);
        if (!sendCtrl.aborted()) {
          var errMsg = { role: 'assistant', content: (e && e.isTimeout) ? e.message : ('Ошибка: ' + e.message), ts: Date.now() };
          enrichBotMsg(errMsg);
          sessionStore.pushToSession(sendSessionId, errMsg);
          // Статус-индикатор переключаем в Offline ТОЛЬКО если юзер всё ещё
          // в этой сессии — иначе он сидит в другой сессии и видит «Офлайн»
          // из-за провала чужого запроса. Сама ошибка в чате той сессии
          // останется (увидит при возврате).
          if (sessionStore.state.activeSessionId === sendSessionId) {
            statusDot.className = statusDotClass + ' offline';
            statusText.textContent = 'Офлайн';
          }
        }
      } finally {
        sendCtrl.restore();
      }
      if (sessionStore.state.activeSessionId === sendSessionId) {
        input.disabled = false; sendBtn.disabled = false;
        if (attachment) {
          attachment.setDisabled(false);
          attachment.clear();
        }
        input.focus();
        smoothScrollChat(chat);
      }
    }

    function exportChat() {
      var activeSessionId = sessionStore.state.activeSessionId;
      var displayMessages = sessionStore.state.displayMessages;
      var sessions = sessionStore.state.sessions;
      if (!activeSessionId || displayMessages.length === 0) {
        alert('Нечего экспортировать.');
        return;
      }
      var sessionName = '';
      for (var i = 0; i < sessions.length; i++) {
        if (sessions[i].id === activeSessionId) { sessionName = sessions[i].name; break; }
      }
      var lines = ['=== ' + sessionName + ' ===', 'Экспорт: ' + new Date().toLocaleString('ru-RU'), ''];
      for (var j = 0; j < displayMessages.length; j++) {
        var m = displayMessages[j];
        var who = m.role === 'user' ? 'Вы' : exportBotLabel(m);
        lines.push('[' + who + ']');
        // Если есть extras с code/raw_result (math) — добавляем
        var extras = m.extras || {};
        if (extras.code) lines.push('Код: ' + extras.code);
        if (extras.raw_result) lines.push('Результат: ' + extras.raw_result);
        lines.push(m.content || '');
        lines.push('');
      }
      // BOM ﻿ — для корректного открытия в Excel/Notepad на Windows
      // (кириллица без BOM может рендериться кракозябрами).
      var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      var url = URL.createObjectURL(blob);
      a.href = url;
      a.download = sessionName + '_' + new Date().toISOString().slice(0, 10) + '.txt';
      a.click();
      // Не отзываем URL сразу: a.click() асинхронен, в медленных браузерах/ОС
      // скачивание может ещё не начаться к моменту revoke. Задержка 1 сек —
      // запас, после download уже запущен и blob можно освободить.
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    // attachment setup
    attachment = setupAttachment({
      buttonContainer: opts.attachBtnEl || document.getElementById('attachBtn'),
      chipsContainer: opts.attachChipsEl || document.getElementById('attachChips'),
      inputElement: input,
      dropZone: chat
    });

    // sidebar resize / header shadow / scroll-to-bottom
    initSidebarResize({
      sidebar: opts.sidebarEl || document.querySelector('.sidebar'),
      initialWidth: opts.sidebarInitialWidth || 270,
      minWidth: opts.sidebarMinWidth || 220,
      maxWidth: opts.sidebarMaxWidth || 440
    });
    initHeaderShadowOnScroll({ scrollable: chat });
    initScrollToBottomButton({
      scrollable: chat,
      inputArea: opts.bottomAreaEl || document.querySelector('.bottom-area')
    });

    // Load + initial switch
    sessionStore.load();
    if (sessionStore.state.activeSessionId && !sessionStore.findSession(sessionStore.state.activeSessionId)) {
      sessionStore.state.activeSessionId = null;
    }
    if (sessionStore.state.sessions.length > 0) {
      sessionStore.renderList();
      var targetId = sessionStore.state.activeSessionId ||
        sessionStore.state.sessions[sessionStore.state.sessions.length - 1].id;
      sessionStore.switchTo(targetId);
    } else {
      attachment.setDisabled(true);
    }
    // S1 fix: pullFromBackend ПОСЛЕ load() — гарантирует что store.sessions уже
    // заполнен из LS до того как мы сравним с серверным списком. Иначе race
    // мог потерять LS-only сессии (server-list пуст → ничего бы не back-fill'нулось).
    if (userScoped) {
      sessionStore.pullFromBackend();
    }

    // Keydown: Enter — отправить (Shift+Enter — перенос). isComposing/keyCode 229
    // защищает от срабатывания во время IME-ввода (китайский/японский).
    // viaButton: false — Enter не отменяет активный запрос (двусмысленный UX),
    // только кнопка-стоп явно отменяет.
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        sendMsg({ viaButton: false });
      }
    });
    input.addEventListener('input', function () {
      // R7.40: overflow-y управляется динамически. С overflow-y:auto всегда
      // браузер изредка показывал скроллбар при первом символе (пиксельное
      // расхождение scrollHeight vs clientHeight). Теперь:
      // - контент влезает в autosizeMax → overflow:hidden → нет скроллбара
      // - контент превышает autosizeMax → overflow:auto → скроллбар появляется
      // На пустом input scrollHeight ≈ один ряд + padding, всегда < autosizeMax.
      input.style.height = 'auto';
      var sh = input.scrollHeight;
      if (sh > autosizeMax) {
        input.style.height = autosizeMax + 'px';
        input.style.overflowY = 'auto';
      } else {
        input.style.height = sh + 'px';
        input.style.overflowY = 'hidden';
      }
      if (sessionStore.state.activeSessionId) {
        sessionStore.setDraft(sessionStore.state.activeSessionId, input.value);
      }
      onInputExtra(input.value);
    });

    // Health-check. skipHealthCheck:true — для агентов без backend-пинга
    // (например router — работает целиком во фронте, бэк-workflow удалён).
    // В этом случае статус сразу показываем «Онлайн» — потому что юзер видит
    // сам факт что страница загрузилась = всё что нужно, работает.
    if (opts.skipHealthCheck) {
      if (statusDot) statusDot.className = statusDotClass + ' online';
      if (statusText) statusText.textContent = 'Онлайн';
    } else {
      var ping = function () {
        return checkServerStatus(WEBHOOK_URL, statusDot, statusText, { dotClass: statusDotClass });
      };
      ping();
      setInterval(ping, 30000);
    }

    // Глобальные обёртки для onclick из HTML (кнопки «Новая сессия»,
    // «Экспорт», send). Совместимость со старым кодом.
    global.sendMsg = sendMsg;
    global.createNewSession = function () { sessionStore.createNew(); };
    global.exportChat = exportChat;
    // Совместимость с router/math и любыми будущими функциями, которым нужен
    // прямой доступ к store через bare-имена (для onclick handlers и debug).
    global.pushToSession = function (sid, msg) { return sessionStore.pushToSession(sid, msg); };

    return {
      sessionStore: sessionStore,
      attachment: attachment,
      sendMsg: sendMsg,
      exportChat: exportChat,
      renderChat: renderChat
    };
  }

  global.GigaChat = {
    config: cfg,
    webhookUrl: webhookUrl,
    auth: {
      getToken: authGetToken,
      getUsername: authGetUsername,
      setAuth: authSetAuth,
      clearAuth: authClearAuth,
      verifyToken: authVerifyToken,
      requireAuth: authRequireAuth,
      redirectToLogin: authRedirectToLogin,
      logout: authLogout,
      parseReturnUrl: authParseReturnUrl,
      apiCall: authApiCall,
      userPrefix: authUserPrefix,
      TOKEN_KEY: AUTH_TOKEN_KEY,
      USERNAME_KEY: AUTH_USERNAME_KEY
    },
    escapeHtml: escapeHtml,
    copyToClipboard: copyTextToClipboard,
    fetchWithRetry: fetchWithRetry,
    checkServerStatus: checkServerStatus,
    startHealthCheck: startHealthCheck,
    formatMarkdown: formatMarkdown,
    formatMarkdownTable: formatMarkdownTable,
    toggleTheme: toggleTheme,
    applyTheme: applyTheme,
    showToast: showToast,
    initThemeToggle: initThemeToggle,
    setupAttachment: setupAttachment,
    buildMessageWithAttachment: buildMessageWithAttachment,
    SUPPORTED_FILE_EXTS: SUPPORTED_FILE_EXTS,
    acceptAttr: acceptAttr,
    // Table-merger хелперы (shared logic для Excel- и Word-мерджеров)
    normalizeMergeHeader: normalizeMergeHeader,
    mergeTables: mergeTables,
    parseXlsxFile: parseXlsxFile,
    buildXlsxBlob: buildXlsxBlob,
    parseDocxAllTables: parseDocxAllTables,
    // Браузерные парсеры — для прямого использования из text-extractor и других мест
    canExtractInBrowser: canExtractInBrowser,
    extractBrowserText: extractBrowserText,
    extractDocxText: extractDocxText,
    extractXlsxText: extractXlsxText,
    padTabularText: padTabularText,
    fileExt: fileExt,
    createSessionStore: createSessionStore,
    createChatAgent: createChatAgent,
    injectAgentCss: injectAgentCss,
    injectToolCss: injectToolCss,
    injectStatusDotCss: injectStatusDotCss,
    typewriteAssistant: typewriteAssistant,
    tsvBlocksToMarkdownTables: tsvBlocksToMarkdownTables,
    applyHighlight: applyHighlight,
    syncHljsTheme: syncHljsTheme,
    SEND_ICON_SVG: SEND_ICON_SVG,
    STOP_ICON_SVG: STOP_ICON_SVG,
    PAPERCLIP_SVG: PAPERCLIP_SVG,
    makeCancellableSend: makeCancellableSend,
    syncSendButton: syncSendButton,
    getSendController: getSendController,
    initSidebarResize: initSidebarResize,
    initHeaderShadowOnScroll: initHeaderShadowOnScroll,
    initScrollToBottomButton: initScrollToBottomButton,
    attachCopyButtons: attachCopyButtons,
    FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS,
    MAX_RETRIES: MAX_RETRIES,
    RETRY_DELAY_MS: RETRY_DELAY_MS
  };
})(window);
