'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createAgentServer, isForeignWebOrigin } = require('../src/agent');
const { normalize } = require('../src/config');

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function startAgent() {
  const ran = [];
  const config = normalize({ deck: { columns: 3, rows: 2, pages: [{ name: 'P', buttons: [{ label: 'A' }] }] } });
  const server = createAgentServer({
    getConfig: () => config,
    getStats: () => ({ cpu: { load: 12 } }),
    actions: {
      run: async (a) => {
        if (a.type === 'boom') throw new Error('raté');
        ran.push(a);
        return a.type === 'sonar' ? { label: 'Casque' } : undefined;
      },
      state: async () => ({ label: 'Enceintes' }),
    },
    getIcon: async (p) => `data:image/png;base64,${Buffer.from(p).toString('base64')}`,
  });
  const port = await server.listen(0);
  return { server, port, ran };
}

test('isForeignWebOrigin', () => {
  assert.strictEqual(isForeignWebOrigin(undefined), false);
  assert.strictEqual(isForeignWebOrigin('null'), false);
  assert.strictEqual(isForeignWebOrigin('file://'), false);
  assert.strictEqual(isForeignWebOrigin('qrc://widget'), false);
  assert.strictEqual(isForeignWebOrigin('http://localhost:5173'), false);
  assert.strictEqual(isForeignWebOrigin('http://127.0.0.1:9000'), false);
  assert.strictEqual(isForeignWebOrigin('https://evil.example'), true);
});

test('agent : config, stats, action, état, icône', async () => {
  const { server, port, ran } = await startAgent();
  try {
    assert.strictEqual((await call(port, { path: '/api/ping' })).json.ok, true);
    const cfg = (await call(port, { path: '/api/config' })).json;
    assert.strictEqual(cfg.deck.columns, 3);
    assert.strictEqual(cfg.stats.tempCritical, 85);
    assert.ok(!('agent' in cfg), 'la config exposée est filtrée');
    assert.strictEqual((await call(port, { path: '/api/stats' })).json.cpu.load, 12);

    const json = { 'Content-Type': 'application/json' };
    const ok = await call(port, { method: 'POST', path: '/api/action', headers: json, body: { action: { type: 'sonar' } } });
    assert.deepStrictEqual(ok.json, { ok: true, result: { label: 'Casque' } });
    assert.deepStrictEqual(ran, [{ type: 'sonar' }]);
    const fail = await call(port, { method: 'POST', path: '/api/action', headers: json, body: { action: { type: 'boom' } } });
    assert.deepStrictEqual(fail.json, { ok: false, error: 'raté' });
    const st = await call(port, { method: 'POST', path: '/api/state', headers: json, body: { action: { type: 'sonar' } } });
    assert.strictEqual(st.json.state.label, 'Enceintes');
    const icon = await call(port, { path: '/api/icon?path=' + encodeURIComponent('C:\\a.exe') });
    assert.match(icon.json.dataUrl, /^data:image\/png;base64,/);
    const png = require('path').join(__dirname, '..', 'assets', 'tray.png');
    const img = await call(port, { path: '/api/image?path=' + encodeURIComponent(png) });
    assert.match(img.json.dataUrl, /^data:image\/png;base64,iVBOR/);
    const txt = await call(port, { path: '/api/image?path=' + encodeURIComponent(__filename) });
    assert.strictEqual(txt.json.dataUrl, null, 'seules les images sont lues');
  } finally {
    await server.close();
  }
});

test('agent : protections (hôte, origine, content-type, CORS)', async () => {
  const { server, port, ran } = await startAgent();
  try {
    assert.strictEqual((await call(port, { path: '/api/ping', headers: { Host: 'evil.example' } })).status, 403);
    const foreign = await call(port, {
      method: 'POST', path: '/api/action',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: { action: { type: 'command', command: 'calc' } },
    });
    assert.strictEqual(foreign.status, 403);
    const form = await call(port, { method: 'POST', path: '/api/action', headers: { 'Content-Type': 'text/plain' }, body: '{"action":{"type":"x"}}' });
    assert.strictEqual(form.status, 415);
    assert.deepStrictEqual(ran, []);

    const pre = await call(port, {
      method: 'OPTIONS', path: '/api/action',
      headers: { Origin: 'file://', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers['access-control-allow-origin'], 'file://');
    assert.strictEqual(pre.headers['access-control-allow-private-network'], 'true');
  } finally {
    await server.close();
  }
});
