// One-shot post-import patch: подключаем Switch fallback output к "Формат ответа".
// n8n Public API при импорте обрезает connections.main до rules.length,
// поэтому добавляем connection через прямой PUT после успешного импорта.
const https = require('http');

const N8N = 'http://localhost:5678';
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMWQzMzQ3Ny05MjdlLTQxMGEtYjNiMC0wMWNmOTY2ODgwYmYiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZmY5ZGFiYTctZWZjNi00YjE3LTgxOGUtNDA2ZmYwMjQxOWMwIiwiaWF0IjoxNzc4NzU4ODgxLCJleHAiOjE3ODEzMjMyMDB9.SI7GAu_3y5neIzbam3iYnwDxkF0TMwf3fvixBvOZmls';
const WF_ID = '9FoK53k6sWLd4RgR';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'localhost', port: 5678, path,
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

(async () => {
  const wf = await req('GET', '/api/v1/workflows/' + WF_ID);
  const conn = wf.connections['Switch action'].main;
  const rules = wf.nodes.find(n => n.name === 'Switch action').parameters.rules.values.length;
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
  const upd = await req('PUT', '/api/v1/workflows/' + WF_ID, payload);
  // Re-verify
  const after = await req('GET', '/api/v1/workflows/' + WF_ID);
  console.log('After: connections=' + after.connections['Switch action'].main.length);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
