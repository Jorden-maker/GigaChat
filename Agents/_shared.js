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

  // Markdown → HTML (заголовки, code, **bold**, *italic*, списки, ---).
  // accentColor — цвет заголовков, чтобы агент сохранял свой стиль.
  function formatMarkdown(text, accentColor) {
    if (!text) return '';
    accentColor = accentColor || '#7c3aed';
    var html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (m, l, c) { return '<pre><code>' + c.trim() + '</code></pre>'; });
    html = html.replace(/^#### (.+)$/gm, '<b style="font-size:14px;color:' + accentColor + '">$1</b>');
    html = html.replace(/^### (.+)$/gm, '<b style="font-size:15px;color:' + accentColor + '">$1</b>');
    html = html.replace(/^## (.+)$/gm, '<b style="font-size:16px;color:' + accentColor + '">$1</b>');
    html = html.replace(/^# (.+)$/gm, '<b style="font-size:18px;color:' + accentColor + '">$1</b>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    html = html.replace(/^- (.+)$/gm, '  • $1');
    html = html.replace(/^---$/gm, '<hr>');
    return html;
  }

  // Markdown-таблица → HTML <table>. Исправлена сломанная регулярка из sql-agent.
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

  global.GigaChat = {
    config: cfg,
    webhookUrl: webhookUrl,
    escapeHtml: escapeHtml,
    fetchWithRetry: fetchWithRetry,
    checkServerStatus: checkServerStatus,
    formatMarkdown: formatMarkdown,
    formatMarkdownTable: formatMarkdownTable,
    FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS,
    MAX_RETRIES: MAX_RETRIES,
    RETRY_DELAY_MS: RETRY_DELAY_MS
  };
})(window);
