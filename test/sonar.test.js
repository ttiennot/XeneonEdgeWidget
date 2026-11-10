'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { SonarClient, findDevice, normalizeTarget } = require('../src/sonar');

const DEVICES = [
  { id: '{0.0.0.00000000}.{aaa}', friendlyName: 'Haut-parleurs (Realtek(R) Audio)', dataFlow: 'render', isVad: false },
  { id: '{0.0.0.00000000}.{bbb}', friendlyName: 'Casque (Arctis Nova Pro Wireless)', dataFlow: 'render', isVad: false },
  { id: '{0.0.0.00000000}.{vad}', friendlyName: 'SteelSeries Sonar - Gaming', dataFlow: 'render', isVad: true, role: 'game' },
  { id: '{0.0.1.00000000}.{mic}', friendlyName: 'Microphone (Arctis Nova Pro Wireless)', dataFlow: 'capture', isVad: false },
];

/** Faux serveur Sonar (mode classique ou streamer). */
function fakeSonar(mode = 'classic') {
  const calls = [];
  const classic = ['game', 'chat', 'media', 'aux'].map((id) => ({ id, deviceId: DEVICES[0].id, isRunning: true }));
  classic.push({ id: 'mic', deviceId: DEVICES[3].id, isRunning: true });
  const stream = [
    { streamRedirectionId: 'monitoring', deviceId: DEVICES[1].id },
    { streamRedirectionId: 'streaming', deviceId: DEVICES[0].id },
  ];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const json = (v) => res.end(JSON.stringify(v));
    let m;
    if (req.url === '/mode') return json(mode);
    if (req.url === '/audioDevices') return json(DEVICES);
    if (req.url === '/classicRedirections') return json(classic);
    if (req.url === '/streamRedirections') return json(stream);
    if ((m = req.url.match(/^\/classicRedirections\/(\w+)\/deviceId\/(.+)$/)) && req.method === 'PUT') {
      classic.find((r) => r.id === m[1]).deviceId = decodeURIComponent(m[2]);
      return res.end();
    }
    if ((m = req.url.match(/^\/streamRedirections\/(\w+)\/deviceId\/(.+)$/)) && req.method === 'PUT') {
      stream.find((r) => r.streamRedirectionId === m[1]).deviceId = decodeURIComponent(m[2]);
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const client = new SonarClient({ corePropsFile: '/inexistant' });
      client.base = `http://127.0.0.1:${server.address().port}/`;
      resolve({ server, client, calls, classic, stream });
    })
  );
}

const TOGGLE = {
  type: 'sonar',
  toggle: [
    { match: 'haut-parleurs', label: 'Enceintes', icon: '🔊' },
    { match: 'ARCTIS', label: 'Casque', icon: '🎧' },
  ],
};

test('findDevice ignore casse, accents et périphériques virtuels / micros', () => {
  assert.strictEqual(findDevice(DEVICES, normalizeTarget('arctis')).id, DEVICES[1].id);
  assert.strictEqual(findDevice(DEVICES, normalizeTarget('Haut-Parleurs')).id, DEVICES[0].id);
  assert.strictEqual(findDevice(DEVICES, normalizeTarget('Sonar')), null);
  assert.strictEqual(findDevice(DEVICES, { id: DEVICES[1].id }).id, DEVICES[1].id);
});

test('mode classique : bascule enceintes <-> casque sur les 4 canaux de sortie', async () => {
  const { server, client, calls, classic } = await fakeSonar('classic');
  try {
    assert.deepStrictEqual(await client.state(TOGGLE), {
      index: 0, label: 'Enceintes', icon: '🔊', deviceName: DEVICES[0].friendlyName,
    });
    const r1 = await client.run(TOGGLE);
    assert.strictEqual(r1.label, 'Casque');
    assert.ok(classic.filter((c) => c.id !== 'mic').every((c) => c.deviceId === DEVICES[1].id));
    assert.strictEqual(classic.find((c) => c.id === 'mic').deviceId, DEVICES[3].id, 'le micro ne doit pas changer');
    assert.ok(calls.includes(`PUT /classicRedirections/game/deviceId/${encodeURIComponent(DEVICES[1].id)}`));
    const r2 = await client.run(TOGGLE);
    assert.strictEqual(r2.label, 'Enceintes');
    assert.strictEqual(classic[0].deviceId, DEVICES[0].id);
  } finally {
    server.close();
  }
});

test('mode streamer : change le mix personnel (monitoring)', async () => {
  const { server, client, stream } = await fakeSonar('stream');
  try {
    assert.strictEqual((await client.state(TOGGLE)).label, 'Casque');
    const r = await client.run(TOGGLE);
    assert.strictEqual(r.label, 'Enceintes');
    assert.strictEqual(stream[0].deviceId, DEVICES[0].id);
    assert.strictEqual(stream[1].deviceId, DEVICES[0].id);
  } finally {
    server.close();
  }
});

test('périphérique introuvable : message listant les sorties', async () => {
  const { server, client } = await fakeSonar('classic');
  try {
    await assert.rejects(client.run({ type: 'sonar', device: 'Enceintes Bluetooth' }), /Disponibles : Haut-parleurs .*Casque/);
  } finally {
    server.close();
  }
});

test('GG absent : erreur explicite', async () => {
  const client = new SonarClient({ corePropsFile: '/inexistant/coreProps.json' });
  await assert.rejects(client.getMode(), /SteelSeries GG introuvable/);
});
