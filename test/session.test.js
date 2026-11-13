'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSessionController } = require('../src/session');

const ACTION = {
  type: 'session',
  id: 'travail',
  browser: { browser: 'edge', urls: ['https://a.example', 'https://b.example'] },
  apps: [
    { process: 'OUTLOOK', launch: { type: 'app', path: 'outlook.exe' } },
    { process: 'ms-teams.exe', launch: { type: 'app', path: 'teams' }, close: 'kill', state: false },
  ],
};

/** Faux Windows : fenêtres du navigateur et processus. */
function setup({ windows = ['100'], procs = [] } = {}) {
  const env = { windows: new Set(windows), procs: new Set(procs), launched: [], commands: [] };
  const helper = {
    send: async (line) => {
      env.commands.push(line);
      const [cmd, a, b] = line.split(' ');
      if (cmd === 'WINS') return [...env.windows].join(',');
      if (cmd === 'ALIVE') return env.windows.has(a) && b === 'msedge' ? '1' : '0';
      if (cmd === 'CLOSE') { env.windows.delete(a); return ''; }
      if (cmd === 'RUNNING') return a.split(',').map((n) => (env.procs.has(n) ? '1' : '0')).join(',');
      if (cmd === 'QUIT' || cmd === 'KILL') { env.procs.delete(a); return ''; }
      return '';
    },
  };
  const runAction = async (action) => {
    env.launched.push(action);
    if (action.type === 'browser') env.windows.add('200');
    if (action.path === 'outlook.exe') env.procs.add('OUTLOOK');
    if (action.path === 'teams') env.procs.add('ms-teams');
  };
  const session = createSessionController({ runAction, helper, wait: async () => {} });
  return { env, session };
}

test('démarrer : ouvre la fenêtre et les applications, puis propose l’arrêt', async () => {
  const { env, session } = setup();
  assert.deepStrictEqual(await session.state(ACTION), { active: false, index: 0, label: 'Travail', icon: '💼', color: '#1f4f8f' });

  const res = await session.run(ACTION);
  assert.deepStrictEqual([res.active, res.label, res.message], [true, 'Stop travail', 'Session ouverte']);
  assert.deepStrictEqual(env.launched.map((a) => a.type), ['browser', 'app', 'app']);
  assert.deepStrictEqual(env.launched[0].urls, ACTION.browser.urls);
  assert.strictEqual(env.launched[0].newWindow, true);
  assert.strictEqual((await session.state(ACTION)).label, 'Stop travail');
});

test('arrêter : ferme seulement la fenêtre du bouton, Outlook en douceur, Teams de force', async () => {
  const { env, session } = setup();
  await session.run(ACTION);
  env.commands.length = 0;
  const res = await session.run(ACTION);
  assert.deepStrictEqual([res.active, res.message], [false, 'Session fermée']);
  assert.ok(env.commands.includes('CLOSE 200 msedge'));
  assert.ok(env.commands.includes('QUIT OUTLOOK'));
  assert.ok(env.commands.includes('KILL ms-teams'));
  assert.deepStrictEqual([...env.windows], ['100'], 'la fenêtre personnelle reste ouverte');
  assert.strictEqual((await session.state(ACTION)).active, false);
});

test('état : Outlook lancé à la main rend la session active, Teams seul non', async () => {
  const onlyTeams = setup({ procs: ['ms-teams'] });
  assert.strictEqual((await onlyTeams.session.state(ACTION)).active, false);
  const outlook = setup({ procs: ['OUTLOOK'] });
  assert.strictEqual((await outlook.session.state(ACTION)).active, true);
});

test('démarrer : ne relance pas une application déjà ouverte', async () => {
  const { env, session } = setup({ procs: ['ms-teams'] });
  await session.run(ACTION);
  assert.deepStrictEqual(env.launched.map((a) => a.path || a.type), ['browser', 'outlook.exe']);
});

test('fenêtre fermée à la main : la session redevient inactive si rien d’autre ne tourne', async () => {
  const { env, session } = setup();
  await session.run(ACTION);
  env.windows.delete('200');
  env.procs.clear();
  assert.strictEqual((await session.state(ACTION)).label, 'Travail');
});

test('noms de processus : pas d’injection dans les commandes de l’assistant', async () => {
  const { env, session } = setup();
  await session.state({ type: 'session', apps: [{ process: 'OUTLOOK; rm -rf' }] });
  assert.ok(env.commands.every((c) => !/[;&|]/.test(c)));
});
