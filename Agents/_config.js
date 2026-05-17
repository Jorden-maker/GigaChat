// GigaChat — единая конфигурация для всех агентов и платформы.
// Меняй ТОЛЬКО здесь при переносе n8n в офис — все агенты подхватят.
window.GIGACHAT_CONFIG = {
  N8N_BASE: 'http://localhost:5678',
  // Pyodide для math-agent. Локальный бандл в Agents/lib/pyodide/
  // (скачать: см. README). Если файлов нет — math-agent сам подхватит
  // jsDelivr CDN, но первый запрос на математику пойдёт во внешнюю сеть.
  PYODIDE_URL: 'lib/pyodide/pyodide.js',
  PYODIDE_INDEX_URL: 'lib/pyodide/'
};
