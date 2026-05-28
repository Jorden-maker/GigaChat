// One-shot post-import patch: подключаем Switch fallback output к "Формат ответа".
// n8n Public API при импорте обрезает connections.main до rules.length,
// поэтому добавляем connection через прямой PUT после успешного импорта.
//
// R7.75: ищем workflow по ИМЕНИ (не по hardcoded WF_ID) — чтобы скрипт
// работал в любой среде (офис, дом и т.п.), а не только на машине разработки.
// Имя берётся из import-workflows.ps1 ($prefix + 'Plane-агент. Поток').
const http = require('http');

const N8N = process.env.N8N_HOST || 'http://localhost:5678';
const API_KEY = process.env.N8N_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMWQzMzQ3Ny05MjdlLTQxMGEtYjNiMC0wMWNmOTY2ODgwYmYiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZmY5ZGFiYTctZWZjNi00YjE3LTgxOGUtNDA2ZmYwMjQxOWMwIiwiaWF0IjoxNzc4NzU4ODgxLCJleHAiOjE3ODEzMjMyMDB9.SI7GAu_3y5neIzbam3iYnwDxkF0TMwf3fvixBvOZmls';
// Имя workflow (с возможным префиксом). Берём с приоритетом по содержанию
// «Plane-агент» — устойчиво к переименованиям префикса.
const WF_NAME_HINT = 'Plane-агент';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(N8N);
    const r = http.request({
      hostname: u.hostname, port: u.port || 5678, path,
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
          reject(new Error(method + ' ' + path + ' → ' + res.statusCode + ': ' + text.slice(0, 200)));
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

// R7.75: ищем workflow по имени (содержит WF_NAME_HINT). Если несколько
// найдено — берём активный, иначе первый.
async function findPlaneWorkflowId() {
  const list = await req('GET', '/api/v1/workflows?limit=100');
  const items = (list && list.data) ? list.data : (Array.isArray(list) ? list : []);
  const matches = items.filter(w => String(w.name || '').includes(WF_NAME_HINT));
  if (!matches.length) {
    throw new Error('Не нашёл workflow с «' + WF_NAME_HINT + '» в имени. Найдено всего: ' + items.length);
  }
  // Предпочитаем активный
  const active = matches.find(w => w.active);
  return (active || matches[0]).id;
}

(async () => {
  const WF_ID = await findPlaneWorkflowId();
  console.log('Plane workflow ID: ' + WF_ID);
  const wf = await req('GET', '/api/v1/workflows/' + WF_ID);
  if (!wf.connections || !wf.connections['Switch action']) {
    throw new Error('У workflow «' + wf.name + '» нет Switch action node');
  }
  const conn = wf.connections['Switch action'].main;
  const switchNode = wf.nodes.find(n => n.name === 'Switch action');
  if (!switchNode) throw new Error('Switch action node не найден в nodes');
  const rules = switchNode.parameters.rules.values.length;
  console.log('Before: rules=' + rules + ', connections=' + conn.length);
  if (conn.length > rules) {
    console.log('Fallback already connected (idx=' + (conn.length - 1) + '). Skip.');
    return;
  }
  // Добавляем connection для fallback output (index = rules.length)
  conn.push([{ node: 'Формат ответа', type: 'main', index: 0 }]);
  console.log('Adding fallback connection at index ' + (conn.length - 1));
  // n8n Public API строго фильтрует settings — оставляем только executionOrder
  const cleanSettings = {};
  if (wf.settings && wf.settings.executionOrder) cleanSettings.executionOrder = wf.settings.executionOrder;
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: cleanSettings
  };
  await req('PUT', '/api/v1/workflows/' + WF_ID, payload);
  const after = await req('GET', '/api/v1/workflows/' + WF_ID);
  console.log('After: connections=' + after.connections['Switch action'].main.length);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
