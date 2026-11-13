'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createNasController, CONFIRM_MS } = require('../src/nas');

const ACTION = { type: 'nas', mac: '00-11-22-33-44-55', host: '192.168.1.50', user: 'admin', key: 'k' };

function setup(online) {
  const env = { online, time: 1000, woken: 0, stopped: [] };
  const nas = createNasController({
    probe: async () => env.online,
    wake: async () => { env.woken++; },
    shutdown: async (opts) => { env.stopped.push(opts); },
    now: () => env.time,
  });
  return { env, nas };
}

test('NAS éteint : propose d’allumer, envoie le Wake-on-LAN puis affiche le démarrage', async () => {
  const { env, nas } = setup(false);
  assert.strictEqual((await nas.state(ACTION)).status, 'off');
  const res = await nas.run(ACTION);
  assert.strictEqual(env.woken, 1);
  assert.strictEqual(res.status, 'starting');
  assert.strictEqual((await nas.state(ACTION)).status, 'starting');
  env.online = true; // le NAS a démarré
  assert.strictEqual((await nas.state(ACTION)).status, 'on');
});

test('NAS allumé : un premier appui demande confirmation, le second éteint', async () => {
  const { env, nas } = setup(true);
  assert.strictEqual((await nas.state(ACTION)).status, 'on');
  assert.strictEqual((await nas.run(ACTION)).status, 'confirm');
  assert.strictEqual(env.stopped.length, 0);
  assert.strictEqual((await nas.state(ACTION)).status, 'confirm');
  env.time += 1000;
  assert.strictEqual((await nas.run(ACTION)).status, 'stopping');
  assert.strictEqual(env.stopped.length, 1);
  assert.strictEqual(env.stopped[0].command, 'sudo -n /sbin/poweroff');
  // Un appui pendant l'extinction ne relance rien.
  assert.strictEqual((await nas.run(ACTION)).status, 'stopping');
  assert.strictEqual(env.stopped.length, 1);
  env.online = false;
  assert.strictEqual((await nas.state(ACTION)).status, 'off');
});

test('NAS allumé : la confirmation expire', async () => {
  const { env, nas } = setup(true);
  await nas.run(ACTION);
  env.time += CONFIRM_MS + 1;
  assert.strictEqual((await nas.state(ACTION)).status, 'on');
  assert.strictEqual((await nas.run(ACTION)).status, 'confirm');
  assert.strictEqual(env.stopped.length, 0);
});

test('NAS allumé sans réglage SSH : erreur explicite, rien n’est éteint', async () => {
  const { env, nas } = setup(true);
  await assert.rejects(nas.run({ type: 'nas', mac: ACTION.mac, host: ACTION.host }), /host.*user.*key/);
  assert.strictEqual(env.stopped.length, 0);
});
