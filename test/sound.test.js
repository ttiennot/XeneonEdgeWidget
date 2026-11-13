'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSoundController } = require('../src/sound');

function fakeHelper(muted = false) {
  const env = { muted, commands: [] };
  env.send = async (command) => {
    env.commands.push(command);
    if (command === 'MUTE') env.muted = true;
    if (command === 'UNMUTE') env.muted = false;
    return env.muted ? '1' : '0';
  };
  return env;
}

test('son actif : le bouton propose de couper, puis de rétablir', async () => {
  const helper = fakeHelper(false);
  const sound = createSoundController({ helper });
  assert.deepStrictEqual(await sound.state({ type: 'sound' }), { muted: false, index: 0, label: 'Couper son', icon: '🔊', color: '#8f1f1f' });

  const cut = await sound.run({ type: 'sound' });
  assert.strictEqual(cut.muted, true);
  assert.strictEqual(cut.label, 'Rétablir son');
  assert.strictEqual(cut.color, '#1f6f3a');
  assert.strictEqual(cut.message, 'Son coupé');
  assert.deepStrictEqual(helper.commands, ['STATE', 'STATE', 'MUTE']);

  const back = await sound.run({ type: 'sound' });
  assert.strictEqual(back.muted, false);
  assert.strictEqual(back.label, 'Couper son');
  assert.strictEqual(helper.commands.pop(), 'UNMUTE');
});

test('libellés personnalisés', async () => {
  const sound = createSoundController({ helper: fakeHelper(true) });
  const st = await sound.state({ type: 'sound', labels: { muted: { label: 'Remettre', icon: '🔈' }, on: 'Silence' } });
  assert.deepStrictEqual([st.label, st.icon], ['Remettre', '🔈']);
});

test('hors Windows : erreur explicite', async () => {
  const sound = createSoundController({ platform: 'linux' });
  await assert.rejects(sound.state({ type: 'sound' }), /Windows/);
});
