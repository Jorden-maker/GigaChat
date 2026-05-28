// One-shot post-import patch: подключаем Switch fallback output к "Формат ответа".
// n8n Public API при импорте обрезает connections.main до rules.length,
// поэтому добавляем connection через прямой PUT после успешного импорта.
//
// R7.75:  ищем workflow по ИМЕНИ (не по hardcoded WF_ID) — чтобы скрипт
//         работал в любой среде (офис, дом и т.п.), а не только на машине
//         разработки. Имя берётся из import-workflows.ps1 ($prefix + 'Plane-агент. Поток').
// R7.83:  - фильтруем АРХИВНЫЕ workflow (n8n возвращает их в общем списке,
//           скрипт мог брать архивный и патчить его — а активный оставался
//           без fallback). Это была причина проблемы в офисе.
//         - подробная диагностика — видно почему ничего не происходит;
//         - VERIFY после PUT: re-GET и проверка что fallback реально лёг
//           в сохранённый workflow (иначе exit 2);
//         - exit code != 0 при любой проблеме (чтобы import-workflows.ps1
//           мог заметить);
//         - поддержка https:// в N8N_HOST.
const http = require('http');
const https = require('https');
const { URL } = require('url');

const N8N = process.env.N8N_HOST || 'http://localhost:5678';
const API_KEY = process.env.N8N_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMWQzMzQ3Ny05MjdlLTQxMGEtYjNiMC0wMWNmOTY2ODgwYmYiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZmY5ZGFiYTctZWZjNi00YjE3LTgxOGUtNDA2ZmYwMjQxOWMwIiwiaWF0IjoxNzc4NzU4ODgxLCJleHAiOjE3ODEzMjMyMDB9.SI7GAu_3y5neIzbam3iYnwDxkF0TMwf3fvixBvOZmls';
// Имя workflow (с возможным префиксом). Берём по содержанию «Plane-агент» —
// устойчиво к любым префиксам.
const WF_NAME_HINT = 'Plane-агент';
const SWITCH_NODE_NAME = 'Switch action';
const FALLBACK_TARGET = 'Формат ответа';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(N8N);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const r = lib.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 5678),
      path,
      method,
      headers: {
        'X-N8N-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(method + ' ' + path + ' → HTTP ' + res.statusCode + ': ' + text.slice(0, 300)));
        } else {
          try { resolve(JSON.parse(text)); }
          catch(_) { resolve(text); }
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// R7.83: ищем АКТИВНЫЙ не-архивный workflow с WF_NAME_HINT в имени.
// Раньше: бралcя любой workflow — в т.ч. архивный из старой версии,
// и патч молча применялся к нему. Активный (только что импортированный)
// оставался без fallback connection → юзеру приходилось руками ставить.
async function findPlaneWorkflowId() {
  const list = await req('GET', '/api/v1/workflows?limit=250');
  const items = (list && list.data) ? list.data : (Array.isArray(list) ? list : []);
  const all = items.filter(w => String(w.name || '').includes(WF_NAME_HINT));
  if (!all.length) {
    throw new Error('Не нашёл ни одного workflow с «' + WF_NAME_HINT + '» в имени. Всего workflow в n8n: ' + items.length + '. Запусти сначала import-workflows.ps1.');
  }
  // Отфильтровываем архивные (поле isArchived).
  const live = all.filter(w => !w.isArchived);
  if (!live.length) {
    throw new Error('Все workflow с «' + WF_NAME_HINT + '» в имени — архивные. Разархивируй один или запусти import-workflows.ps1.');
  }
  // Среди живых предпочитаем активный (active: true), иначе первый.
  const active = live.find(w => w.active);
  const chosen = active || live[0];
  if (all.length > live.length) {
    console.log('  Игнорирую ' + (all.length - live.length) + ' архивных Plane-agent workflow');
  }
  if (live.length > 1) {
    console.log('  Внимание: ' + live.length + ' живых Plane-agent workflow:');
    live.forEach(w => console.log('    - ' + w.name + ' [id=' + w.id + (w.active ? ', active' : '') + ']'));
    console.log('  Беру: ' + chosen.name + (active ? ' (активный)' : ' (первый из неактивных)'));
  }
  return chosen.id;
}

(async () => {
  console.log('  Хост n8n: ' + N8N);
  const WF_ID = await findPlaneWorkflowId();
  console.log('  Plane workflow ID: ' + WF_ID);
  const wf = await req('GET', '/api/v1/workflows/' + WF_ID);
  if (!wf.connections || !wf.connections[SWITCH_NODE_NAME]) {
    throw new Error('У workflow «' + wf.name + '» нет node «' + SWITCH_NODE_NAME + '» в connections. Структура изменена?');
  }
  const conn = wf.connections[SWITCH_NODE_NAME].main;
  if (!Array.isArray(conn)) {
    throw new Error('connections[' + SWITCH_NODE_NAME + '].main — не массив (тип ' + typeof conn + ')');
  }
  const switchNode = (wf.nodes || []).find(n => n.name === SWITCH_NODE_NAME);
  if (!switchNode) {
    throw new Error('Node «' + SWITCH_NODE_NAME + '» не найден в nodes');
  }
  if (!switchNode.parameters || !switchNode.parameters.rules || !Array.isArray(switchNode.parameters.rules.values)) {
    throw new Error('У «' + SWITCH_NODE_NAME + '» нет parameters.rules.values');
  }
  const rules = switchNode.parameters.rules.values.length;
  console.log('  Switch.rules: ' + rules + ', connections.main.length: ' + conn.length);

  let needPut = false;
  if (conn.length > rules) {
    // Проверим что fallback (последний элемент) реально указывает куда нужно.
    const last = conn[conn.length - 1];
    const lastOk = Array.isArray(last) && last.some(x => x && x.node === FALLBACK_TARGET);
    if (lastOk) {
      console.log('  OK: fallback уже подключён к «' + FALLBACK_TARGET + '» (idx=' + (conn.length - 1) + '). Ничего не делаю.');
      return;
    }
    console.log('  Fallback есть, но указывает не на «' + FALLBACK_TARGET + '». Перезаписываю последний элемент.');
    conn[conn.length - 1] = [{ node: FALLBACK_TARGET, type: 'main', index: 0 }];
    needPut = true;
  } else {
    // Если по каким-то причинам conn.length < rules (n8n обрезал больше) — дополним.
    while (conn.length < rules) {
      conn.push([]);
    }
    // Теперь conn.length === rules → добавляем fallback на index = rules.
    conn.push([{ node: FALLBACK_TARGET, type: 'main', index: 0 }]);
    console.log('  Добавляю fallback connection на index=' + (conn.length - 1));
    needPut = true;
  }

  if (!needPut) return;

  // n8n Public API строго фильтрует settings — оставляем только executionOrder.
  const cleanSettings = {};
  if (wf.settings && wf.settings.executionOrder) {
    cleanSettings.executionOrder = wf.settings.executionOrder;
  }
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: cleanSettings
  };
  await req('PUT', '/api/v1/workflows/' + WF_ID, payload);

  // R7.83: VERIFY — перечитываем и проверяем что fallback реально сохранён.
  // Без этого юзер мог не понять, что PUT прошёл, но n8n опять обрезал.
  const after = await req('GET', '/api/v1/workflows/' + WF_ID);
  const afterConn = (after.connections && after.connections[SWITCH_NODE_NAME] && after.connections[SWITCH_NODE_NAME].main) || [];
  const verifyOk = afterConn.length > rules
    && Array.isArray(afterConn[afterConn.length - 1])
    && afterConn[afterConn.length - 1].some(x => x && x.node === FALLBACK_TARGET);
  if (verifyOk) {
    console.log('  ВЕРИФИКАЦИЯ: fallback сохранён в n8n. connections.length=' + afterConn.length + ', target=«' + FALLBACK_TARGET + '».');
  } else {
    throw new Error('ВЕРИФИКАЦИЯ FAILED: после PUT connections.length=' + afterConn.length + ', rules=' + rules + '. n8n отверг изменения. Проверь UI вручную.');
  }
})().catch(e => {
  console.error('  FAIL: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
