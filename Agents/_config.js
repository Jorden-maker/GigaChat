// GigaChat — единая конфигурация для всех агентов и платформы.
// Меняй ТОЛЬКО здесь при переносе n8n в офис — все агенты подхватят.
//
// <N8N_HOST> — IP или hostname ПК, на котором запущен n8n.
// В офисе подставь сюда реальный адрес n8n-сервера, например 192.168.1.50.
// Если n8n на этом же ПК, что и браузер — поставь 'localhost'.
window.GIGACHAT_CONFIG = {
  N8N_BASE: 'http://<N8N_HOST>:5678',
  // Pyodide для math-agent. Локальный бандл в Agents/lib/pyodide/
  // (скачать: см. README). Если файлов нет — math-agent сам подхватит
  // jsDelivr CDN, но первый запрос на математику пойдёт во внешнюю сеть.
  PYODIDE_URL: 'lib/pyodide/pyodide.js',
  PYODIDE_INDEX_URL: 'lib/pyodide/'
};
