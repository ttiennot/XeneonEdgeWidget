'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { encode, createDecoder, OP } = require('../src/discord-ipc');
const { createDiscordVoice, toMember } = require('../src/discord-voice');

const ME = { id: '1', username: 'moi', global_name: 'Moi', avatar: 'abc' };
const entry = (id, name, vs = {}) => ({ nick: name, user: { id, username: name, avatar: null }, voice_state: vs });

/** Faux Discord : répond aux commandes comme l'application. */
function fakeDiscord({ channel = null, validToken = 'good' } = {}) {
  const t = new EventEmitter();
  const world = { channel, settings: { mute: false, deaf: false }, sent: [], authorizeCalls: 0, subscriptions: new Set() };
  const reply = (frame, data, evt = null) => setImmediate(() => t.emit('frame', { cmd: frame.cmd, nonce: frame.nonce, evt, data }));
  t.send = (frame) => {
    world.sent.push(frame);
    const a = frame.args || {};
    switch (frame.cmd) {
      case 'AUTHORIZE':
        world.authorizeCalls++;
        return reply(frame, { code: 'the-code' });
      case 'AUTHENTICATE':
        return a.access_token === validToken ? reply(frame, { user: ME }) : reply(frame, { code: 4009, message: 'Invalid token' }, 'ERROR');
      case 'SUBSCRIBE':
        world.subscriptions.add(`${frame.evt}:${a.channel_id || ''}`);
        return reply(frame, { evt: frame.evt });
      case 'UNSUBSCRIBE':
        world.subscriptions.delete(`${frame.evt}:${a.channel_id || ''}`);
        return reply(frame, { evt: frame.evt });
      case 'GET_VOICE_SETTINGS':
        return reply(frame, world.settings);
      case 'SET_VOICE_SETTINGS':
        Object.assign(world.settings, a);
        return reply(frame, world.settings);
      case 'SET_USER_VOICE_SETTINGS':
        return reply(frame, { user_id: a.user_id, volume: a.volume, mute: a.mute });
      case 'GET_SELECTED_VOICE_CHANNEL':
        return reply(frame, world.channel);
      case 'GET_GUILD':
        return reply(frame, { id: a.guild_id, name: 'Mon serveur' });
      case 'GET_GUILDS':
        return reply(frame, { guilds: [{ id: '10', name: 'Mon serveur' }] });
      case 'GET_CHANNELS':
        return reply(frame, { channels: [{ id: '20', name: 'général', type: 0 }, { id: '21', name: 'Vocal', type: 2 }] });
      case 'SELECT_VOICE_CHANNEL':
        world.channel = a.channel_id ? { id: a.channel_id, guild_id: '10', name: 'Vocal', voice_states: [entry('1', 'Moi')] } : null;
        return reply(frame, world.channel);
      default:
        return reply(frame, { code: 4000, message: `Commande inconnue ${frame.cmd}` }, 'ERROR');
    }
  };
  t.close = () => t.emit('close');
  t.dispatch = (evt, data) => t.emit('frame', { cmd: 'DISPATCH', evt, data });
  return { transport: t, world };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push(Object.fromEntries(init.body));
    return { ok: true, status: 200, json: async () => ({ access_token: 'good', refresh_token: 'refresh', expires_in: 3600 }) };
  };
}

const SETTINGS = { clientId: '123', clientSecret: 'secret' };

test('trames discord-ipc : encodage puis décodage, y compris en morceaux', () => {
  const frames = [];
  const decode = createDecoder((op, data) => frames.push([op, data]));
  const bytes = Buffer.concat([encode(OP.FRAME, { cmd: 'A', texte: 'été' }), encode(OP.PING, { n: 1 })]);
  decode(bytes.subarray(0, 5));
  decode(bytes.subarray(5, 20));
  decode(bytes.subarray(20));
  assert.deepStrictEqual(frames, [[OP.FRAME, { cmd: 'A', texte: 'été' }], [OP.PING, { n: 1 }]]);
});

test('toMember : nom, micro / casque coupés, soi-même', () => {
  const m = toMember({ nick: 'Pseudo', user: { id: '1', username: 'u', avatar: 'h' }, voice_state: { self_mute: true } }, '1');
  assert.deepStrictEqual(m, { id: '1', name: 'Pseudo', avatar: 'https://cdn.discordapp.com/avatars/1/h.png?size=64', mute: true, deaf: false, bot: false, self: true, volume: 100, localMute: false });
});

test('sans identifiants : état « unconfigured », aucune connexion tentée', async () => {
  let connects = 0;
  const voice = createDiscordVoice({ getSettings: () => ({}), connect: async () => { connects++; } });
  await voice.tick();
  assert.strictEqual(voice.snapshot().status, 'unconfigured');
  assert.strictEqual(connects, 0);
});

test('Discord fermé : état « no-discord »', async () => {
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => { throw Object.assign(new Error('x'), { code: 'NO_DISCORD' }); } });
  await voice.tick();
  assert.strictEqual(voice.snapshot().status, 'no-discord');
});

test('première utilisation : autorisation, échange du code, puis état prêt', async () => {
  const { transport, world } = fakeDiscord();
  const calls = [];
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => transport, fetchImpl: fakeFetch(calls) });
  await voice.tick();
  assert.strictEqual(voice.snapshot().status, 'unauthorized');
  assert.strictEqual(world.authorizeCalls, 0, 'aucune fenêtre d’autorisation sans action de l’utilisateur');

  const snap = await voice.authorize();
  assert.strictEqual(snap.status, 'ready');
  assert.strictEqual(snap.user.name, 'Moi');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].grant_type, 'authorization_code');
  assert.strictEqual(calls[0].code, 'the-code');
  assert.strictEqual(calls[0].client_secret, 'secret');
  assert.strictEqual(calls[0].redirect_uri, 'http://localhost');
  const authorize = world.sent.find((f) => f.cmd === 'AUTHORIZE');
  assert.deepStrictEqual(authorize.args.scopes, ['rpc', 'rpc.voice.read', 'rpc.voice.write']);
});

test('en vocal : participants, qui parle, départs, micro et raccrochage', async () => {
  const channel = { id: '21', guild_id: '10', name: 'Vocal', voice_states: [entry('1', 'Moi'), entry('2', 'Ami', { self_deaf: true })] };
  const { transport, world } = fakeDiscord({ channel });
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => transport, fetchImpl: fakeFetch([]) });
  await voice.tick();
  await voice.authorize();

  let snap = voice.snapshot();
  assert.strictEqual(snap.channel.name, 'Vocal');
  assert.strictEqual(snap.channel.guildName, 'Mon serveur');
  assert.deepStrictEqual(snap.channel.members.map((m) => [m.name, m.self, m.deaf, m.speaking]), [['Moi', true, false, false], ['Ami', false, true, false]]);
  assert.ok(world.subscriptions.has('SPEAKING_START:21'));

  transport.dispatch('SPEAKING_START', { user_id: '2' });
  transport.dispatch('VOICE_STATE_CREATE', entry('3', 'Nouveau'));
  snap = voice.snapshot();
  assert.strictEqual(snap.channel.members.find((m) => m.id === '2').speaking, true);
  assert.strictEqual(snap.channel.members.length, 3);

  transport.dispatch('VOICE_STATE_DELETE', entry('2', 'Ami'));
  assert.deepStrictEqual(voice.snapshot().channel.members.map((m) => m.id), ['1', '3']);

  await voice.setMute();
  assert.strictEqual(voice.snapshot().mute, true);
  assert.strictEqual(world.settings.mute, true);
  transport.dispatch('VOICE_SETTINGS_UPDATE', { mute: false, deaf: true });
  assert.deepStrictEqual([voice.snapshot().mute, voice.snapshot().deaf], [false, true]);

  await voice.leave();
  assert.strictEqual(voice.snapshot().channel, null);
  assert.ok(!world.subscriptions.has('SPEAKING_START:21'), 'désabonnement de l’ancien salon');

  await voice.join('21');
  assert.strictEqual(voice.snapshot().channel.id, '21');
});

test('salons vocaux d’un serveur et favoris', async () => {
  const { transport } = fakeDiscord();
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => transport, fetchImpl: fakeFetch([]) });
  await voice.tick();
  await voice.authorize();
  assert.deepStrictEqual(await voice.guilds(), [{ id: '10', name: 'Mon serveur', icon: null }]);
  assert.deepStrictEqual(await voice.channels('10'), [{ id: '21', name: 'Vocal' }]);
  voice.toggleFavorite({ id: '21', name: 'Vocal', guildName: 'Mon serveur' });
  assert.strictEqual(voice.snapshot().favorites.length, 1);
  voice.toggleFavorite({ id: '21' });
  assert.strictEqual(voice.snapshot().favorites.length, 0);
});

test('Discord se ferme : retour à « no-discord », commandes refusées', async () => {
  const { transport } = fakeDiscord();
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => transport, fetchImpl: fakeFetch([]) });
  await voice.tick();
  await voice.authorize();
  transport.close();
  await flush();
  assert.strictEqual(voice.snapshot().status, 'no-discord');
  await assert.rejects(voice.setMute(), /pas connecté/);
});

test('appel privé : mémorisé pour l’onglet MP, nommé d’après l’interlocuteur', async () => {
  const other = { nick: null, user: { id: '2', username: 'ami', global_name: 'Ami', avatar: 'h2' }, voice_state: {} };
  const channel = { id: '99', name: '', type: 1, voice_states: [entry('1', 'Moi')] };
  const { transport } = fakeDiscord({ channel });
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => transport, fetchImpl: fakeFetch([]) });
  await voice.tick();
  await voice.authorize();
  let snap = voice.snapshot();
  assert.strictEqual(snap.channel.kind, 'dm');
  assert.deepStrictEqual(snap.recents.map((r) => [r.id, r.kind, r.name]), [['99', 'dm', '']]);

  transport.dispatch('VOICE_STATE_CREATE', other);
  snap = voice.snapshot();
  assert.strictEqual(snap.channel.name, 'Ami');
  assert.deepStrictEqual(snap.recents[0].avatars, [{ name: 'Ami', url: 'https://cdn.discordapp.com/avatars/2/h2.png?size=64' }]);

  // L'ami raccroche : le nom reste connu.
  transport.dispatch('VOICE_STATE_DELETE', other);
  assert.strictEqual(voice.snapshot().recents[0].name, 'Ami');
  voice.forgetRecent('99');
  assert.strictEqual(voice.snapshot().recents.length, 0);
});

test('salon de serveur : logo du serveur, non ajouté aux MP', async () => {
  const channel = { id: '21', guild_id: '10', name: 'Vocal', type: 2, voice_states: [entry('1', 'Moi')] };
  const { transport } = fakeDiscord({ channel });
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => transport, fetchImpl: fakeFetch([]) });
  await voice.tick();
  await voice.authorize();
  const snap = voice.snapshot();
  assert.strictEqual(snap.channel.kind, 'guild');
  assert.strictEqual(snap.recents.length, 0);
});

test('participant : volume borné et muet pour soi, refusé pour soi-même', async () => {
  const channel = { id: '21', guild_id: '10', name: 'Vocal', voice_states: [entry('1', 'Moi'), { ...entry('2', 'Ami'), volume: 80, mute: false }] };
  const { transport, world } = fakeDiscord({ channel });
  const voice = createDiscordVoice({ getSettings: () => SETTINGS, connect: async () => transport, fetchImpl: fakeFetch([]) });
  await voice.tick();
  await voice.authorize();
  const ami = () => voice.snapshot().channel.members.find((m) => m.id === '2');
  assert.deepStrictEqual([ami().volume, ami().localMute], [80, false]);

  await voice.setUserVoice('2', { volume: 350 });
  assert.strictEqual(ami().volume, 200, 'volume limité à 200 %');
  await voice.setUserVoice('2', { mute: true });
  assert.deepStrictEqual([ami().volume, ami().localMute], [200, true]);
  const last = world.sent.filter((f) => f.cmd === 'SET_USER_VOICE_SETTINGS').pop();
  assert.deepStrictEqual(last.args, { user_id: '2', mute: true });

  await assert.rejects(voice.setUserVoice('1', { volume: 50 }), /vous-même/);
});
