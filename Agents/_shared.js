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
  async function fetchWithRetry(url, options, opts) {
    opts = opts || {};
    var timeout = opts.timeout || FETCH_TIMEOUT_MS;
    var retries = (opts.retries == null) ? MAX_RETRIES : opts.retries;
    var retryDelay = opts.retryDelay || RETRY_DELAY_MS;

    for (var attempt = 0; attempt <= retries; attempt++) {
      var controller = new AbortController();
      var tid = setTimeout(function () { controller.abort(); }, timeout);
      try {
        var res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
        clearTimeout(tid);
        return res;
      } catch (e) {
        clearTimeout(tid);
        if (attempt < retries) {
          await new Promise(function (r) { setTimeout(r, retryDelay); });
          continue;
        }
        if (e.name === 'AbortError') {
          throw new Error('Сервер не ответил за ' + (timeout / 1000) + ' сек.');
        }
        throw e;
      }
    }
  }

  // Пингует webhook (тело {"message":"ping"}). Обновляет визуальные элементы.
  // Возвращает Promise<bool> (true если онлайн).
  function checkServerStatus(url, dotEl, textEl, opts) {
    opts = opts || {};
    var labels = opts.labels || { online: 'Онлайн', offline: 'Офлайн', checking: 'проверка...' };
    var dotClass = opts.dotClass || 'dot';
    if (dotEl) dotEl.className = dotClass + ' checking';
    if (textEl) textEl.textContent = labels.checking;
    var controller = new AbortController();
    var tid = setTimeout(function () { controller.abort(); }, PING_TIMEOUT_MS);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"message":"ping"}',
      signal: controller.signal
    }).then(function (res) {
      clearTimeout(tid);
      var ok = res.ok || res.status > 0;
      if (dotEl) dotEl.className = dotClass + (ok ? ' online' : ' offline');
      if (textEl) textEl.textContent = ok ? labels.online : labels.offline;
      return ok;
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

  // Переключение темы: меняет атрибут data-theme на <html> и сохраняет выбор.
  // Раннее применение темы делается inline-скриптом в <head> каждой страницы.
  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || 'light';
    var next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('giga_theme', next); } catch (e) {}
  }

  // ============================================================
  // БРАУЗЕРНЫЕ ПАРСЕРЫ — извлечение текста БЕЗ OCR
  // ============================================================
  // docx, xlsx, txt/md/log/csv парсим прямо в браузере через JSZip
  // и DOMParser. Это в 10-100 раз быстрее OCR и не нагружает n8n.
  // Требует подключённый jszip.min.js (для docx/xlsx). Для txt-like
  // достаточно нативного file.text().

  var BROWSER_EXT = ['docx','txt','md','log','csv','xlsx','xlsm'];

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

    var lines = [];
    var paragraphs = doc.getElementsByTagName('w:p');
    for (var i = 0; i < paragraphs.length; i++) {
      var ts = paragraphs[i].getElementsByTagName('w:t');
      var line = '';
      for (var j = 0; j < ts.length; j++) line += ts[j].textContent || '';
      if (line) lines.push(line);
    }
    return lines.join('\n');
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

    // Первый лист
    var sheetFile = zip.file('xl/worksheets/sheet1.xml');
    if (!sheetFile) {
      var sheets = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/);
      if (!sheets || sheets.length === 0) throw new Error('В .xlsx не найдено листов.');
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
      // Скрепка плоская, без рамки, маленькая — живёт ВНУТРИ textarea (absolute).
      + '.gc-attach-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:transparent;border:none;border-radius:6px;color:var(--text-secondary);cursor:pointer;transition:all .15s;flex-shrink:0;padding:0}'
      + '.gc-attach-btn:hover:not(:disabled){color:var(--accent);background:rgba(255,255,255,0.06)}'
      + '.gc-attach-btn:disabled{opacity:.35;cursor:not-allowed}'
      + '.gc-attach-btn.has-file{color:var(--accent)}'
      + '.gc-attach-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
      // Обёртка textarea + скрепка (скрепка absolute в правом нижнем углу).
      + '.gc-input-wrap{position:relative;flex:1;display:flex;align-items:stretch}'
      + '.gc-input-wrap > textarea{flex:1;width:100%}'
      + '.gc-input-wrap > .gc-attach-btn{position:absolute;right:6px;bottom:6px;z-index:2}'
      // Чипы с именами файлов над input-area.
      + '.gc-attach-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 8px 0}'
      + '.gc-attach-chips:empty{display:none}'
      + '.gc-attach-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-input,#1b2230);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text-primary);max-width:280px}'
      + '.gc-attach-chip .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.gc-attach-chip .x{cursor:pointer;color:var(--text-secondary);font-size:14px;line-height:1;padding:0 2px}'
      + '.gc-attach-chip .x:hover{color:#ff6666}'
      + '.gc-attach-chip.error{border-color:#cc4444;color:#ff8888}'
      + '.gc-attach-chip.bot{background:rgba(255,255,255,0.06)}'
      + '';
    var style = document.createElement('style');
    style.setAttribute('data-gc-attach', '1');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Иконка скрепки (Feather paperclip)
  var PAPERCLIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

  // Создаёт контроллер вложений. Возвращает объект:
  //   hasFile() -> bool
  //   getFile() -> File или null
  //   clear()
  //   cancel()  — отменить идущую экстракцию
  //   extract(onProgress) -> Promise<{text, fileName, error}>
  //
  // Опции:
  //   buttonContainer (DOM) — куда воткнуть кнопку-скрепку
  //   chipsContainer (DOM)  — куда показывать чип с именем файла
  //   inputElement (DOM)    — textarea (для focus после выбора, опционально)
  //   onChange()            — колбэк когда файл добавлен/удалён
  function setupAttachment(opts) {
    injectAttachCss();
    var buttonContainer = opts.buttonContainer;
    var chipsContainer = opts.chipsContainer;
    var inputElement = opts.inputElement;
    var onChange = opts.onChange || function () {};

    var selectedFile = null;
    var abortCtrl = null;

    // Скрытый input file
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.accept = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.log,.rtf,.odt,.jpg,.jpeg,.png,.tiff,.tif,.bmp,.webp,.gif,.heic';
    document.body.appendChild(fileInput);

    // Кнопка-скрепка
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gc-attach-btn';
    btn.title = 'Прикрепить файл';
    btn.innerHTML = PAPERCLIP_SVG;
    btn.addEventListener('click', function () { fileInput.click(); });
    buttonContainer.appendChild(btn);

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length > 0) {
        var f = fileInput.files[0];
        if (f.size > 50 * 1024 * 1024) {
          alert('Файл слишком большой (макс. 50 МБ)');
          fileInput.value = '';
          return;
        }
        selectedFile = f;
        renderChip();
        btn.classList.add('has-file');
        onChange();
        if (inputElement) inputElement.focus();
      }
      fileInput.value = '';
    });

    function renderChip() {
      chipsContainer.innerHTML = '';
      if (!selectedFile) return;
      var chip = document.createElement('span');
      chip.className = 'gc-attach-chip';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = '📎 ' + selectedFile.name;
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Убрать файл';
      x.addEventListener('click', function () {
        selectedFile = null;
        renderChip();
        btn.classList.remove('has-file');
        onChange();
      });
      chip.appendChild(name);
      chip.appendChild(x);
      chipsContainer.appendChild(chip);
    }

    function hasFile() { return !!selectedFile; }
    function getFile() { return selectedFile; }
    function clear() {
      selectedFile = null;
      renderChip();
      btn.classList.remove('has-file');
      btn.disabled = false;
    }
    function cancel() {
      if (abortCtrl) { try { abortCtrl.abort(); } catch (e) {} }
      abortCtrl = null;
    }
    // Включить/выключить скрепку извне (на время обработки запроса).
    // При disabled скрываем и контейнер чипов — чтобы во время «Думаю...»
    // в поле ввода не было «зависшего» вложения (оно уже в пузыре сверху).
    function setDisabled(disabled) {
      btn.disabled = !!disabled;
      chipsContainer.style.display = disabled ? 'none' : '';
    }

    // Когда файл выбран — скрепка disabled, чтобы нельзя было повесить второй.
    // Сброс через clear() или крестик в чипе вернёт активность.
    var origRenderChip = renderChip;
    renderChip = function () {
      origRenderChip();
      if (selectedFile) btn.disabled = true; else btn.disabled = false;
    };

    // Выполнить извлечение. Возвращает {text, fileName, error}.
    // Сначала пытаемся в браузере (docx/xlsx/txt-like). Если не подходит —
    // отправляем на n8n через webhook /extract-text (PDF, изображения).
    async function extract(onProgress) {
      if (!selectedFile) return { text: '', fileName: '', error: '' };
      var fileName = selectedFile.name;

      // Путь 1: браузерный парсер (docx, xlsx, txt, md, log, csv).
      if (canExtractInBrowser(fileName)) {
        try {
          if (typeof onProgress === 'function') onProgress('Извлекаю текст из «' + fileName + '»...');
          var text = await extractBrowserText(selectedFile);
          if (!text || !text.trim()) {
            return { text: '', fileName: fileName, error: 'Из файла не удалось извлечь текст (пустой).' };
          }
          return { text: text, fileName: fileName, error: '' };
        } catch (e) {
          return { text: '', fileName: fileName, error: 'Ошибка извлечения: ' + (e.message || e) };
        }
      }

      // Путь 2: n8n + OCR-сервис (PDF, jpg/png/tiff, doc, rtf, prochee).
      var url = cfg.N8N_BASE.replace(/\/$/, '') + '/webhook/extract-text';
      abortCtrl = new AbortController();
      var tid = setTimeout(function () {
        try { abortCtrl.abort(); } catch (e) {}
      }, 180000);
      try {
        if (typeof onProgress === 'function') onProgress('Извлекаю текст из «' + fileName + '» через OCR...');
        var fd = new FormData();
        fd.append('file', selectedFile);
        var res = await fetch(url, { method: 'POST', body: fd, signal: abortCtrl.signal });
        clearTimeout(tid);
        if (!res.ok) {
          return { text: '', fileName: fileName, error: 'Сервер вернул ' + res.status };
        }
        var data = await res.json();
        if (data.success === false || !data.response) {
          return { text: '', fileName: fileName, error: data.response || 'Не удалось извлечь текст' };
        }
        return { text: String(data.response), fileName: fileName, error: '' };
      } catch (e) {
        clearTimeout(tid);
        if (e.name === 'AbortError') return { text: '', fileName: fileName, error: 'Извлечение отменено или превысило таймаут (3 мин)' };
        return { text: '', fileName: fileName, error: 'Ошибка: ' + e.message };
      } finally {
        abortCtrl = null;
      }
    }

    return {
      hasFile: hasFile,
      getFile: getFile,
      clear: clear,
      cancel: cancel,
      setDisabled: setDisabled,
      extract: extract
    };
  }

  // Утилита: собрать сообщение для агента и краткое описание для UI.
  // Если файл успешно извлечён — возвращает:
  //   { messageForAgent: '[ВЛОЖЕНИЕ:name]\n<text>\n[/ВЛОЖЕНИЕ]\n<user text>', attachmentSummary: 'имя.расш (1234 симв.)' }
  // Если файл с ошибкой — текст не вшивается, в attachmentSummary помечается ошибка.
  // Если файла нет — возвращает userText без изменений и пустую summary.
  function buildMessageWithAttachment(userText, extracted) {
    var hasText = extracted && extracted.text && extracted.text.length > 0;
    var hasError = extracted && extracted.error && extracted.error.length > 0;
    var fname = extracted && extracted.fileName;
    if (!fname) {
      return { messageForAgent: userText || '', attachmentSummary: '' };
    }
    if (hasText) {
      var block = '[ВЛОЖЕНИЕ:' + fname + ']\n' + extracted.text + '\n[/ВЛОЖЕНИЕ]\n\n';
      var msg = (userText && userText.trim().length > 0)
        ? block + userText
        : block + 'Проанализируй прикреплённый файл.';
      return {
        messageForAgent: msg,
        attachmentSummary: fname + ' (' + extracted.text.length.toLocaleString('ru-RU') + ' симв.)'
      };
    }
    if (hasError) {
      // OCR упала: текст не зашиваем, но в сообщение для агента добавим короткую пометку.
      var noteMsg = '[не удалось обработать файл: ' + fname + ' — ' + extracted.error + ']\n\n' + (userText || '');
      return {
        messageForAgent: noteMsg,
        attachmentSummary: fname + ' (ошибка: ' + extracted.error + ')'
      };
    }
    return { messageForAgent: userText || '', attachmentSummary: '' };
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
    fileExt: fileExt,
    FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS,
    MAX_RETRIES: MAX_RETRIES,
    RETRY_DELAY_MS: RETRY_DELAY_MS
  };
})(window);
