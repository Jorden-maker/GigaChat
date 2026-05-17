// GigaChat — общие утилиты для всех агентов.
// Подключать ПОСЛЕ _config.js: <script src="_config.js"></script><script src="_shared.js"></script>
(function (global) {
  var cfg = global.GIGACHAT_CONFIG || { N8N_BASE: 'http://localhost:5678' };

  var FETCH_TIMEOUT_MS = 120000;
  var MAX_RETRIES = 2;
  var RETRY_DELAY_MS = 3000;
  var PING_TIMEOUT_MS = 5000;

  function webhookUrl(path) {
    return cfg.N8N_BASE.replace(/\/$/, '') + '/webhook/' + path.replace(/^\//, '');
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
          throw new Error('Сервер не ответил за ' + (timeout / 1000) + ' сек.');
        }
        // Сетевая ошибка — пробуем ещё.
        if (attempt < retries) {
          await new Promise(function (r) { setTimeout(r, retryDelay); });
          continue;
        }
        throw e;
      }
    }
    // Цикл может выйти только через return/throw выше, но для строгости:
    throw lastErr || new Error('fetchWithRetry: исчерпаны попытки');
  }

  // Health-check сервера. URL webhook'а игнорируется — пингуем общий /healthz
  // самого n8n. Долгая история «почему не webhook»:
  //   - POST с {"message":"ping"} запускал workflow с непредсказуемым payload'ом
  //     (table-merger ждёт multipart → 500 → ложный «Офлайн»).
  //   - GET на POST-only webhook возвращает 404 без CORS-заголовков → блок.
  //   - OPTIONS для workflow с «Allow OPTIONS» в Webhook-ноде попадает внутрь
  //     workflow, который падает на пустом body → 500 без CORS → блок.
  // Решение: пинговать /healthz через mode:'no-cors'. Это endpoint n8n core
  // (workflow не запускается), а no-cors превращает любой network-ответ в
  // opaque resolve — браузер не блокирует ответ из-за отсутствия CORS-заголовков.
  // Резолв = сервер ответил = онлайн. Catch = сеть/таймаут = реальный офлайн.
  function checkServerStatus(url, dotEl, textEl, opts) {
    opts = opts || {};
    var labels = opts.labels || { online: 'Онлайн', offline: 'Офлайн', checking: 'проверка...' };
    var dotClass = opts.dotClass || 'dot';
    if (dotEl) dotEl.className = dotClass + ' checking';
    if (textEl) textEl.textContent = labels.checking;
    var controller = new AbortController();
    var tid = setTimeout(function () { controller.abort(); }, PING_TIMEOUT_MS);
    // /healthz — общий core-endpoint n8n, всегда отвечает 200 если сервер жив.
    var healthUrl = cfg.N8N_BASE.replace(/\/$/, '') + '/healthz';
    return fetch(healthUrl, {
      method: 'GET',
      mode: 'no-cors',
      signal: controller.signal
    }).then(function () {
      clearTimeout(tid);
      // С mode:'no-cors' ответ всегда opaque, status=0. Сам факт резолва
      // означает, что сервер вернул хоть что-то.
      if (dotEl) dotEl.className = dotClass + ' online';
      if (textEl) textEl.textContent = labels.online;
      return true;
    }).catch(function () {
      clearTimeout(tid);
      if (dotEl) dotEl.className = dotClass + ' offline';
      if (textEl) textEl.textContent = labels.offline;
      return false;
    });
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      syncHljsTheme();
      initThemeToggle();
    });
  } else {
    syncHljsTheme();
    initThemeToggle();
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
      // Кнопка-отправка как иконка внутри поля: квадратная, акцентный фон, ↵.
      + '.gc-send-icon{position:absolute;right:11px;bottom:6px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;background:transparent;color:var(--text-secondary);border:none;border-radius:8px;cursor:pointer;padding:0;transition:color .15s,background .15s,opacity .15s;z-index:2}'
      + '.gc-send-icon:hover:not(:disabled){color:var(--accent);background:var(--bg-hover)}'
      + '.gc-send-icon:disabled{opacity:.35;cursor:not-allowed;pointer-events:none}'
      // Стрелка — только stroke, fill принудительно none (чтобы не была
      // белой при возможных hover-стилях). Stop-квадрат рисуется тем же
      // currentColor через fill (отдельное правило ниже).
      + '.gc-send-icon svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
      + '.gc-send-icon svg rect{fill:currentColor;stroke:none}'
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
      + '.msg.user{position:relative}'
      + '.gc-msg-copy{position:absolute;right:-27px;bottom:0;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;background:transparent;border:none;border-radius:4px;color:var(--accent);cursor:pointer;opacity:0;transition:opacity .15s,background .15s}'
      + '.msg.user:hover .gc-msg-copy,.msg.user:focus-within .gc-msg-copy,.gc-msg-copy:focus{opacity:1}'
      + '.gc-msg-copy:hover{background:var(--bg-user)}'
      + '.gc-msg-copy svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
      + '.gc-msg-copy.copied{opacity:1}'
      // Время «N сек/мин назад» правее copy-btn на 10px. Показывается
      // тоже только на hover (как и copy). Цвет = text-muted, мелкий шрифт.
      + '.gc-msg-time{position:absolute;right:-77px;bottom:2px;font-size:11px;color:var(--text-muted);opacity:0;transition:opacity .15s;white-space:nowrap;pointer-events:none}'
      + '.msg.user:hover .gc-msg-time{opacity:1}'
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
    if (diff < 60) return diff + ' сек';
    if (diff < 3600) return Math.floor(diff / 60) + ' мин';
    if (diff < 86400) return Math.floor(diff / 3600) + ' ч';
    return Math.floor(diff / 86400) + ' дн';
  }

  function attachCopyButtons(root) {
    var scope = root || document;
    var msgs = scope.querySelectorAll('.msg.user');
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
      var parent = btn.closest('.msg.user');
      if (!parent) return;
      var clone = parent.cloneNode(true);
      var junk = clone.querySelectorAll('.gc-msg-copy, .gc-msg-time, .inflight-agent-badge, .gc-attach-chip');
      for (var ji = 0; ji < junk.length; ji++) junk[ji].remove();
      var text = (clone.textContent || '').trim();
      if (!text || !navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        btn.innerHTML = COPIED_ICON_SVG;
        btn.classList.add('copied');
        setTimeout(function () {
          btn.innerHTML = COPY_ICON_SVG;
          btn.classList.remove('copied');
        }, 1200);
      });
    });
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
  var STOP_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/></svg>';

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
        btn.innerHTML = SEND_ICON_SVG;
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
  //   onChange()            — колбэк когда файл добавлен/удалён
  //   maxFiles (number)     — максимум файлов одновременно (по умолчанию 5)
  //   maxFileSize (number)  — лимит размера каждого в байтах (по умолчанию 50 МБ)
  function setupAttachment(opts) {
    injectAttachCss();
    var buttonContainer = opts.buttonContainer;
    var chipsContainer = opts.chipsContainer;
    var inputElement = opts.inputElement;
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

    fileInput.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files.length) {
        fileInput.value = '';
        return;
      }
      // Защита от дубликатов: сравниваем по имени+размеру.
      function isDuplicate(f) {
        for (var i = 0; i < selectedFiles.length; i++) {
          if (selectedFiles[i].name === f.name && selectedFiles[i].size === f.size) return true;
        }
        return false;
      }
      var rejected = [];
      for (var i = 0; i < fileInput.files.length; i++) {
        var f = fileInput.files[i];
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
      if (rejected.length) alert('Не удалось добавить:\n' + rejected.join('\n'));
      renderChips();
      onChange();
      if (inputElement) inputElement.focus();
      fileInput.value = '';
    });

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
    // isProcessing определяется per-session через getInflight маркер.
    // Опция-callback можно переопределить для legacy-кода, но дефолт смотрит
    // в localStorage — единый источник правды «идёт ли в сессии обработка».
    var isProcessing = opts.isProcessing || function () {
      return !!getInflight(store.activeSessionId);
    };
    var onAttachmentClear = opts.onAttachmentClear || function () {};
    var onEmpty = opts.onEmpty || function () {};
    var onSwitch = opts.onSwitch || function () {};

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
      var trimmed = msgs.slice(-50);
      if (trySaveSnapshotTo(sid, trimmed)) {
        store.displayMessages = trimmed;
        return;
      }
      pruneOtherSnapshots(sid);
      if (trySaveSnapshotTo(sid, trimmed)) {
        store.displayMessages = trimmed;
        return;
      }
      var minimal = msgs.slice(-20);
      if (trySaveSnapshotTo(sid, minimal)) {
        store.displayMessages = minimal;
        return;
      }
      // Тихий отказ — следующий saveSnapshot повторит.
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
      try { localStorage.removeItem(KEY_INFLIGHT + sid); } catch (e) {}
      stopInflightTicker();
      // Удаляем loader из DOM напрямую вместо полного renderMessages —
      // иначе chat.innerHTML=html перестраивает весь чат и вызывает
      // визуальный «рывок» (особенно при отмене запроса). Следующий
      // push (assistant msg в успехе) сам триггерит renderMessages.
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

    function createNew() {
      store.sessionCounter++;
      var id = idPrefix + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      store.sessions.push({ id: id, name: namePrefix + store.sessionCounter });
      return switchTo(id, { skipHistoryLoad: true });
    }

    async function switchTo(id, switchOpts) {
      switchOpts = switchOpts || {};
      var sameSession = (id === store.activeSessionId);
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
            if (msgs.length >= store.displayMessages.length) {
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

    function remove(id) {
      // Если в удаляемой сессии активный AbortController — отменяем fetch
      // и снимаем регистрацию, иначе pushToSession после resolve запишет
      // orphan-snapshot в удалённую сессию.
      var ctrl = getSendController(id);
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      unregisterSendController(id);
      store.sessions = store.sessions.filter(function (s) { return s.id !== id; });
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
      if (s && newName && newName.trim()) s.name = newName.trim();
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
    window.addEventListener('storage', handleStorageEvent);

    function dispose() {
      window.removeEventListener('storage', handleStorageEvent);
      stopInflightTicker();
    }

    return {
      state: store,                              // прямой доступ к sessions/activeSessionId/displayMessages
      dispose: dispose,                          // cleanup listener'а и таймера
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
      findSession: findSession
    };
  }

  // ============================================================
  // ПСЕВДО-СТРИМИНГ (TYPEWRITER) ответа агента
  // ============================================================
  // Универсальный паттерн для всех агентов:
  //   GigaChat.typewriteAssistant(sessionStore, sid, msg, { cps, containerSelector })
  // - msg сразу пушится в snapshot (для возврата в сессию с полным ответом).
  // - В DOM последний `.msg.bot` (или указанный containerSelector) очищается,
  //   и текст из msg.content постепенно «печатается» plain-text'ом со скоростью
  //   ~cps символов/сек (по умолчанию 60).
  // - В конце innerHTML восстанавливается из ранее отрендеренного finalHtml —
  //   полностью с markdown, code-блоками, extras и т.п.
  // - Если юзер переключился на другую сессию во время typewriter — печать
  //   прерывается тихо; при возврате он увидит полный текст (snapshot содержит).
  function typewriteAssistant(sessionStore, sid, msg, options) {
    options = options || {};
    var cps = options.cps || 60;
    var containerSelector = options.containerSelector || '.msg.bot';
    var tickFps = 30;
    var tickIntervalMs = 1000 / tickFps;
    var charsPerTick = Math.max(1, Math.round(cps / tickFps));

    // 1) Положить в snapshot и отрисовать. После этого последний .msg.bot
    //    содержит финальный HTML (markdown отрендерен).
    // Если pushToSession вернул false — сессия удалена пока шёл запрос,
    // НЕЛЬЗЯ ничего печатать (lastBot в DOM принадлежит другой активной
    // сессии, мы напечатаем ответ удалённой сессии поверх чужого ответа).
    var pushed = sessionStore.pushToSession(sid, msg);
    if (!pushed) return null;

    // 2) Если сессия не активна — анимация не нужна.
    if (sid !== sessionStore.state.activeSessionId) return null;

    var botEls = document.querySelectorAll(containerSelector);
    var lastBot = botEls[botEls.length - 1];
    if (!lastBot) return null;

    var finalHtml = lastBot.innerHTML;
    var plainText = msg.content || msg.text || '';
    if (!plainText) return null;

    lastBot.innerHTML = '';
    lastBot.classList.add('gc-typewriting');

    // Каретка-курсор внутри блока во время печати (мягкий мигающий блок).
    if (!document.querySelector('style[data-gc-typewriter]')) {
      var style = document.createElement('style');
      style.setAttribute('data-gc-typewriter', '1');
      style.textContent =
        '.gc-typewriting{white-space:pre-wrap}' +
        '.gc-typewriting::after{content:"\\258B";display:inline-block;margin-left:1px;color:var(--accent);animation:gcCaret 1s steps(2) infinite}' +
        '@keyframes gcCaret{50%{opacity:0}}';
      document.head.appendChild(style);
    }

    var i = 0;
    var intervalId = setInterval(function () {
      // Юзер ушёл — тихо прерываемся (при возврате он увидит полный текст
      // из snapshot через renderMessages).
      if (sid !== sessionStore.state.activeSessionId) {
        clearInterval(intervalId);
        return;
      }
      // Если узел потерян (renderMessages перерисовал чат) — прерываемся.
      if (!lastBot.isConnected) {
        clearInterval(intervalId);
        return;
      }
      if (i >= plainText.length) {
        clearInterval(intervalId);
        lastBot.innerHTML = finalHtml;
        lastBot.classList.remove('gc-typewriting');
        // Подсвечиваем code-блоки в финальном HTML.
        applyHighlight(lastBot);
        return;
      }
      i = Math.min(i + charsPerTick, plainText.length);
      lastBot.textContent = plainText.substring(0, i);
    }, tickIntervalMs);

    return {
      cancel: function () {
        clearInterval(intervalId);
        if (lastBot && lastBot.isConnected) {
          lastBot.innerHTML = finalHtml;
          lastBot.classList.remove('gc-typewriting');
          applyHighlight(lastBot);
        }
      }
    };
  }

  global.GigaChat = {
    config: cfg,
    webhookUrl: webhookUrl,
    escapeHtml: escapeHtml,
    fetchWithRetry: fetchWithRetry,
    checkServerStatus: checkServerStatus,
    formatMarkdown: formatMarkdown,
    formatMarkdownTable: formatMarkdownTable,
    toggleTheme: toggleTheme,
    applyTheme: applyTheme,
    initThemeToggle: initThemeToggle,
    setupAttachment: setupAttachment,
    buildMessageWithAttachment: buildMessageWithAttachment,
    // Браузерные парсеры — для прямого использования из text-extractor и других мест
    canExtractInBrowser: canExtractInBrowser,
    extractBrowserText: extractBrowserText,
    extractDocxText: extractDocxText,
    extractXlsxText: extractXlsxText,
    padTabularText: padTabularText,
    fileExt: fileExt,
    createSessionStore: createSessionStore,
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
