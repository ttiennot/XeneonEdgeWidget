'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createVoiceControl } = require('../src/voice-control');

function fakeVoice(status = 'ready') {
  const v = { status, mute: false, deaf: false };
  v.snapshot = () => ({ status: v.status, mute: v.mute, deaf: v.deaf });
  v.setMute = async () => { v.mute = !v.mute; };
  v.setDeaf = async () => { v.deaf = !v.deaf; };
  return v;
}

test('micro : libellé et couleur suivent l’état de Discord', async () => {
  const voice = fakeVoice();
  const ctl = createVoiceControl(() => voice);
  const action = { type: 'discordVoice', control: 'mute' };
  assert.deepStrictEqual(await ctl.state(action), { cut: false, index: 0, label: 'Couper micro', icon: '🎙️', color: '#8f1f1f' });
  const after = await ctl.run(action);
  assert.deepStrictEqual([after.cut, after.label, after.color], [true, 'Rétablir micro', '#1f6f3a']);
  assert.strictEqual((await ctl.run(action)).label, 'Couper micro');
});

test('casque : la sourdine coupe aussi le micro', async () => {
  const voice = fakeVoice();
  const ctl = createVoiceControl(() => voice);
  const after = await ctl.run({ type: 'discordVoice', control: 'deaf' });
  assert.deepStrictEqual([after.cut, after.label], [true, 'Rétablir casque']);
  assert.strictEqual((await ctl.state({ type: 'discordVoice', control: 'mute' })).label, 'Rétablir micro');
});

test('Discord non connecté : erreur explicite', async () => {
  const ctl = createVoiceControl(() => fakeVoice('no-discord'));
  await assert.rejects(ctl.state({ type: 'discordVoice' }), /pas lancé/);
  await assert.rejects(createVoiceControl(() => null).run({ type: 'discordVoice' }), /indisponible/);
});
