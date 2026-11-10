'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHotkey, escapeSendKeys, expandEnv, createActionRunner } = require('../src/actions');

test('parseHotkey', () => {
  assert.deepStrictEqual(parseHotkey('Ctrl+Shift+M'), [
    { vk: 0x11, ext: false },
    { vk: 0x10, ext: false },
    { vk: 0x4d, ext: false },
  ]);
  assert.deepStrictEqual(parseHotkey('win + d').map((k) => k.vk), [0x5b, 0x44]);
  assert.deepStrictEqual(parseHotkey('ctrl++').map((k) => k.vk), [0x11, 0xbb]);
  assert.strictEqual(parseHotkey('f13')[0].vk, 0x7c);
  assert.strictEqual(parseHotkey('playpause')[0].ext, true);
  assert.throws(() => parseHotkey('ctrl+foo'), /Touche inconnue/);
  assert.throws(() => parseHotkey(''), /vide/);
});

test('escapeSendKeys', () => {
  assert.strictEqual(escapeSendKeys('GG (100%) +1 ~'), 'GG {(}100{%}{)} {+}1 {~}');
  assert.strictEqual(escapeSendKeys('a\nb'), 'a{ENTER}b');
});

test('expandEnv', () => {
  process.env.XE_TEST_DIR = 'C:\\Users\\Moi';
  assert.strictEqual(expandEnv('%xe_test_dir%\\Downloads'), 'C:\\Users\\Moi\\Downloads');
  assert.strictEqual(expandEnv('%INCONNUE_XYZ%'), '%INCONNUE_XYZ%');
});

test('runner : url / dossier / multi / erreurs', async () => {
  const calls = [];
  const shell = {
    openExternal: async (u) => calls.push(['url', u]),
    openPath: async (p) => (calls.push(['path', p]), ''),
  };
  const runner = createActionRunner({ shell, platform: 'linux' });
  await runner.run({ type: 'url', url: 'steam://open/games' });
  await runner.run({ type: 'multi', delayMs: 0, actions: [{ type: 'page', page: 1 }, { type: 'folder', path: '/tmp' }] });
  assert.deepStrictEqual(calls, [['url', 'steam://open/games'], ['path', '/tmp']]);
  await assert.rejects(runner.run({ type: 'nope' }), /inconnu/);
  await assert.rejects(runner.run({ type: 'media', key: 'xyz' }), /inconnue/);
});
