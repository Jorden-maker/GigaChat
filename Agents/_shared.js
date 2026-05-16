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
  // accentColor — цвет заголовков, чтобы агент сохранял свой стиль.
  function formatMarkdown(text, accentColor) {
    if (!text) return '';
    accentColor = accentColor || '#7c3aed';
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

  // Единая корпоративная тема — тёмная (Claude Code: тёмный сланец + лавандовый акцент).
  // Светлая тема и переключатель удалены, но эти функции остаются как no-op для
  // обратной совместимости (на случай если внешний код вызывает их).
  function syncHljsTheme() {
    var dark = document.getElementById('hljs-theme-dark');
    var light = document.getElementById('hljs-theme-light');
    if (dark) dark.disabled = false;
    if (light) light.disabled = true;
  }
  function toggleTheme() { /* no-op: светлая тема удалена */ }

  // Применить подсветку синтаксиса ко всем неподсвеченным <pre><code> внутри
  // контейнера (либо ко всему документу если container не передан).
  // Если highlight.js не подключён — тихо пропускаем.
  function applyHighlight(container) {
    if (typeof global.hljs === 'undefined') return;
    var scope = container || document;
    var blocks = scope.querySelectorAll('pre code:not(.hljs)');
    for (var i = 0; i < blocks.length; i++) {
      try { global.hljs.highlightElement(blocks[i]); } catch (e) {}
    }
  }

  // На загрузке страницы включаем тёмную тему hljs (если оба CSS-link'а
  // присутствуют). hljs CSS подключается из HTML позже, поэтому делаем это
  // после DOMContentLoaded.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncHljsTheme);
  } else {
    syncHljsTheme();
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
      // Скрепка плоская, без рамки, маленькая.
      + '.gc-attach-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;background:transparent;border:none;border-radius:8px;color:var(--text-secondary);cursor:pointer;transition:all .15s;flex-shrink:0;padding:0}'
      + '.gc-attach-btn:hover:not(:disabled){color:var(--accent);background:rgba(255,255,255,0.06)}'
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
      + '.gc-send-icon{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;background:transparent;color:var(--text-secondary);border:none;border-radius:8px;cursor:pointer;padding:0;transition:color .15s,background .15s,opacity .15s;z-index:2}'
      + '.gc-send-icon:hover:not(:disabled){color:var(--accent);background:rgba(255,255,255,0.06)}'
      + '.gc-send-icon:disabled{opacity:.35;cursor:not-allowed;pointer-events:none}'
      + '.gc-send-icon svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
      // Внешний контейнер всего ряда: [wrap с textarea+send] + [скрепка].
      // align-items:center — скрепка выровнена по центру высоты поля.
      + '.gc-input-row{display:flex;gap:8px;align-items:center;width:100%}'
      // Чипы с именами файлов над input-area.
      + '.gc-attach-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 8px 0}'
      + '.gc-attach-chips:empty{display:none}'
      + '.gc-attach-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-input,#1b2230);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text-primary);max-width:280px}'
      + '.gc-attach-chip .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.gc-attach-chip .x{cursor:pointer;color:var(--text-secondary);font-size:14px;line-height:1;padding:0 2px}'
      + '.gc-attach-chip .x:hover{color:#ff6666}'
      + '.gc-attach-chip.error{border-color:#cc4444;color:#ff8888}'
      + '.gc-attach-chip.bot{background:rgba(255,255,255,0.06)}'
      // Переносы строк в user-сообщении должны сохраняться визуально.
      + '.msg.user, .msg-user-body{white-space:pre-wrap;word-wrap:break-word}'
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

  // Иконка «стоп» — квадратик. Показывается на месте стрелки отправки во
  // время LLM-запроса; клик отменяет запрос.
  var STOP_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/></svg>';

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
  function makeCancellableSend(btn) {
    var controller = new AbortController();
    var prevHtml = btn.innerHTML;
    var prevOnclick = btn.onclick;
    var prevDisabled = btn.disabled;
    btn.disabled = false;
    btn.innerHTML = STOP_ICON_SVG;
    btn.onclick = function (ev) {
      if (ev) ev.preventDefault();
      controller.abort();
    };
    return {
      signal: controller.signal,
      aborted: function () { return controller.signal.aborted; },
      restore: function () {
        btn.disabled = prevDisabled;
        btn.innerHTML = prevHtml;
        btn.onclick = prevOnclick;
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
          var x = document.createElement('span');
          x.className = 'x';
          x.textContent = '×';
          x.title = 'Убрать файл';
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

    // Сохранение snapshot с защитой от переполнения localStorage.
    // Стратегия при QuotaExceededError:
    //   1) Урезаем displayMessages до последних 50 сообщений и пробуем снова.
    //   2) Если опять — удаляем все snapshot'ы других сессий этого же агента
    //      (они уже не активны, юзер при возврате подгрузит с сервера).
    //   3) Если и это не помогло — оставляем последние 20 сообщений.
    //   4) Если уж совсем — тихо отказываемся (next saveSnapshot повторит).
    var MAX_SNAPSHOT_MESSAGES = 100;
    function trySaveSnapshot(messages) {
      try {
        localStorage.setItem(KEY_VIEW + store.activeSessionId, JSON.stringify(messages));
        return true;
      } catch (e) {
        return false;
      }
    }
    function pruneOtherSnapshots() {
      var prefixView = KEY_VIEW;
      var current = KEY_VIEW + store.activeSessionId;
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
      var msgs = store.displayMessages;
      // Превентивный лимит: длинные сессии обрезаются ДО попытки записи.
      if (msgs.length > MAX_SNAPSHOT_MESSAGES) {
        msgs = msgs.slice(-MAX_SNAPSHOT_MESSAGES);
        store.displayMessages = msgs;
      }
      if (trySaveSnapshot(msgs)) return;
      // Quota exceeded — пробуем урезать сильнее.
      var trimmed = msgs.slice(-50);
      if (trySaveSnapshot(trimmed)) {
        store.displayMessages = trimmed;
        return;
      }
      // Чистим snapshot'ы других сессий.
      pruneOtherSnapshots();
      if (trySaveSnapshot(trimmed)) {
        store.displayMessages = trimmed;
        return;
      }
      // Самый крайний — последние 20 сообщений.
      var minimal = msgs.slice(-20);
      if (trySaveSnapshot(minimal)) {
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
      renderMessages(store.displayMessages);
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
    function pushToSession(sid, msg) {
      if (!sid) return;
      if (sid === store.activeSessionId) {
        store.displayMessages.push(msg);
        saveSnapshot();
        renderMessages(store.displayMessages);
        // После рендеринга — подсвечиваем code-блоки.
        applyHighlight();
      } else {
        try {
          var snap = loadSnapshot(sid) || [];
          snap.push(msg);
          localStorage.setItem(KEY_VIEW + sid, JSON.stringify(snap));
        } catch (e) {}
      }
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
      store.activeSessionId = id;
      // Скрепку трогаем только если в фоне НЕ идёт обработка.
      if (!isProcessing()) onAttachmentClear();
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
          edit.title = 'Переименовать';
          edit.innerHTML = PENCIL_SVG;
          (function (sess) {
            edit.addEventListener('click', function (e) { e.stopPropagation(); startRename(sess.id); });
          })(s);
          item.appendChild(edit);

          var close = document.createElement('span');
          close.className = 'close';
          close.title = 'Удалить';
          close.textContent = '×';
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
      }
    }
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
    sessionStore.pushToSession(sid, msg);

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
    FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS,
    MAX_RETRIES: MAX_RETRIES,
    RETRY_DELAY_MS: RETRY_DELAY_MS
  };
})(window);
