'use strict';

/**
 * Pilotage du vocal de l'application Discord du PC, pour le widget « Edge Voice ».
 *
 * Discord impose de passer par une « application » créée sur son portail développeur
 * (config.json > discordVoice : clientId, clientSecret) et d'accepter une fois la demande
 * d'autorisation affichée dans Discord. Les jetons obtenus sont gardés dans un fichier local
 * (discord-voice.json, à côté de config.json), jamais envoyés ailleurs qu'à Discord.
 *
 * États : unconfigured | no-discord | unauthorized | authorizing | ready | error
 */

const fs = require('fs');
const crypto = require('crypto');
const { connectPipe } = require('./discord-ipc');

const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write'];
const CHANNEL_EVENTS = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'];
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const VOICE_CHANNEL_TYPES = new Set([2, 13]);

/** Requêtes / réponses / événements sur une liaison Discord. */
class RpcSession {
  constructor(transport, onEvent) {
    this.transport = transport;
    this.pending = new Map();
    transport.on('frame', (frame) => {
      const waiting = frame.nonce && this.pending.get(frame.nonce);
      if (waiting) {
        this.pending.delete(frame.nonce);
        clearTimeout(waiting.timer);
        if (frame.evt === 'ERROR') {
          const d = frame.data || {};
          waiting.reject(Object.assign(new Error(d.message || 'Erreur Discord'), { code: d.code }));
        } else waiting.resolve(frame.data);
        return;
      }
      if (frame.cmd === 'DISPATCH' && frame.evt) onEvent(frame.evt, frame.data || {});
    });
    transport.on('close', () => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('Connexion à Discord perdue'));
      }
      this.pending.clear();
    });
  }

  request(cmd, args = {}, { evt, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const nonce = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`Discord n’a pas répondu (${cmd})`));
      }, timeoutMs);
      this.pending.set(nonce, { resolve, reject, timer });
      const payload = { cmd, args, nonce };
      if (evt) payload.evt = evt;
      this.transport.send(payload);
    });
  }
}

function avatarUrl(user) {
  return user && user.id && user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
}

/** Entrée « voice_states » de Discord -> participant affichable. */
function toMember(entry, selfId) {
  const user = (entry && entry.user) || {};
  const vs = (entry && entry.voice_state) || {};
  return {
    id: String(user.id || ''),
    name: entry.nick || user.global_name || user.username || '?',
    avatar: avatarUrl(user),
    mute: !!(vs.self_mute || vs.mute),
    deaf: !!(vs.self_deaf || vs.deaf),
    bot: !!user.bot,
    self: String(user.id || '') === String(selfId || ''),
    // Réglages locaux (pour soi seulement) : volume de 0 à 200 %, muet.
    volume: Number.isFinite(Number(entry.volume)) && entry.volume !== null && entry.volume !== undefined ? Math.round(Number(entry.volume)) : 100,
    localMute: !!entry.mute,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * @param {object} deps
 * @param {() => { clientId?: string, clientSecret?: string, redirectUri?: string }} deps.getSettings
 * @param {string} [deps.dataFile] fichier local des jetons et des salons favoris
 * @param {Function} [deps.connect] (clientId) => transport  (remplaçable pour les tests)
 * @param {Function} [deps.fetchImpl]
 */
function createDiscordVoice({ getSettings, dataFile, connect = connectPipe, fetchImpl = globalThis.fetch, now = Date.now, retryMs = 5000 }) {
  const stored = dataFile ? readJson(dataFile) : {};
  const data = {
    tokens: stored.tokens || null,
    favorites: Array.isArray(stored.favorites) ? stored.favorites : [],
    // Conversations privées (MP, groupes) déjà utilisées en vocal : Discord ne permet pas de les lister.
    recents: Array.isArray(stored.recents) ? stored.recents : [],
  };
  const state = { status: 'unconfigured', message: '', user: null, mute: false, deaf: false, channel: null };
  const speaking = new Set();
  let rpc = null;
  let transport = null;
  let subscribedChannel = null;
  let timer = null;
  let connecting = false;
  let stopped = false;

  const save = () => {
    if (!dataFile) return;
    try {
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn('[discord-voice] écriture impossible :', err.message);
    }
  };

  const settings = () => {
    const s = getSettings() || {};
    return { clientId: String(s.clientId || '').trim(), clientSecret: String(s.clientSecret || '').trim(), redirectUri: String(s.redirectUri || 'http://localhost').trim() };
  };

  const setStatus = (status, message = '') => {
    state.status = status;
    state.message = message;
  };

  /* ---------------- Jetons ---------------- */

  async function tokenRequest(params) {
    const s = settings();
    const body = new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, ...params });
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const reason = json.error_description || json.error || `HTTP ${res.status}`;
      throw new Error(`Discord a refusé l’échange du jeton : ${reason}`);
    }
    data.tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || (data.tokens && data.tokens.refresh_token) || null,
      expires_at: now() + (Number(json.expires_in) || 604800) * 1000,
      client_id: s.clientId,
    };
    save();
  }

  const refreshTokens = () => {
    if (!data.tokens || !data.tokens.refresh_token) return Promise.reject(new Error('Pas de jeton de renouvellement'));
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: data.tokens.refresh_token });
  };

  /* ---------------- Salon courant ---------------- */

  async function unsubscribeChannel() {
    const id = subscribedChannel;
    subscribedChannel = null;
    if (!id || !rpc) return;
    await Promise.all(CHANNEL_EVENTS.map((evt) => rpc.request('UNSUBSCRIBE', { channel_id: id }, { evt }).catch(() => {})));
  }

  async function loadChannel() {
    if (!rpc) return;
    await unsubscribeChannel();
    speaking.clear();
    const ch = await rpc.request('GET_SELECTED_VOICE_CHANNEL');
    if (!ch || !ch.id) {
      state.channel = null;
      return;
    }
    let guildName = '';
    let icon = null;
    if (ch.guild_id) {
      const guild = await rpc.request('GET_GUILD', { guild_id: ch.guild_id }).catch(() => null);
      guildName = (guild && guild.name) || '';
      icon = (guild && guild.icon_url) || null;
    }
    const members = new Map();
    for (const entry of ch.voice_states || []) {
      const m = toMember(entry, state.user && state.user.id);
      if (m.id) members.set(m.id, m);
    }
    // Sans serveur : conversation privée (type 3 = groupe, sinon MP à deux).
    const kind = ch.guild_id ? 'guild' : ch.type === 3 ? 'group' : 'dm';
    state.channel = { id: String(ch.id), kind, rawName: ch.name || '', name: ch.name || '', guildId: ch.guild_id ? String(ch.guild_id) : null, guildName, icon, members };
    rememberPrivate();
    subscribedChannel = state.channel.id;
    await Promise.all(CHANNEL_EVENTS.map((evt) => rpc.request('SUBSCRIBE', { channel_id: subscribedChannel }, { evt }).catch(() => {})));
  }

  /** Nom et avatars d'une conversation privée, d'après ses participants (hors soi-même). */
  function describePrivate(channel) {
    const others = [...channel.members.values()].filter((m) => !m.self);
    const name = channel.rawName || others.map((m) => m.name).join(', ');
    return { name, avatars: others.slice(0, 3).map((m) => ({ name: m.name, url: m.avatar })) };
  }

  /** Mémorise la conversation privée en cours pour pouvoir la rappeler depuis l'onglet MP. */
  function rememberPrivate() {
    const channel = state.channel;
    if (!channel || channel.kind === 'guild') return;
    const info = describePrivate(channel);
    const previous = data.recents.find((r) => r.id === channel.id);
    // Seul dans l'appel : on garde le nom et les avatars déjà connus.
    const name = info.name || (previous && previous.name) || '';
    const avatars = info.avatars.length ? info.avatars : (previous && previous.avatars) || [];
    channel.name = name;
    const entry = { id: channel.id, kind: channel.kind, name, avatars, lastUsed: now() };
    const unchanged = previous && previous.name === name && JSON.stringify(previous.avatars) === JSON.stringify(avatars) && data.recents[0] === previous;
    data.recents = [entry, ...data.recents.filter((r) => r.id !== channel.id)].slice(0, 15);
    if (!unchanged) save();
  }

  function onEvent(evt, payload) {
    if (evt === 'VOICE_CHANNEL_SELECT') {
      loadChannel().catch(() => {});
      return;
    }
    if (evt === 'VOICE_SETTINGS_UPDATE') {
      if (typeof payload.mute === 'boolean') state.mute = payload.mute;
      if (typeof payload.deaf === 'boolean') state.deaf = payload.deaf;
      return;
    }
    const channel = state.channel;
    if (!channel) return;
    if (evt === 'VOICE_STATE_CREATE' || evt === 'VOICE_STATE_UPDATE') {
      const m = toMember(payload, state.user && state.user.id);
      if (m.id) channel.members.set(m.id, m);
      if (evt === 'VOICE_STATE_CREATE') rememberPrivate();
    } else if (evt === 'VOICE_STATE_DELETE') {
      const id = String((payload.user && payload.user.id) || '');
      channel.members.delete(id);
      speaking.delete(id);
    } else if (evt === 'SPEAKING_START') speaking.add(String(payload.user_id));
    else if (evt === 'SPEAKING_STOP') speaking.delete(String(payload.user_id));
  }

  /* ---------------- Connexion ---------------- */

  async function authenticate() {
    const s = settings();
    // Jetons obtenus pour une autre application Discord : inutilisables.
    if (data.tokens && data.tokens.client_id && data.tokens.client_id !== s.clientId) data.tokens = null;
    if (!data.tokens) return setStatus('unauthorized');
    if (data.tokens.expires_at - now() < 60000) {
      try {
        await refreshTokens();
      } catch (_) {
        data.tokens = null;
        save();
        return setStatus('unauthorized');
      }
    }
    let auth;
    try {
      auth = await rpc.request('AUTHENTICATE', { access_token: data.tokens.access_token });
    } catch (_) {
      try {
        await refreshTokens();
        auth = await rpc.request('AUTHENTICATE', { access_token: data.tokens.access_token });
      } catch (err) {
        data.tokens = null;
        save();
        return setStatus('unauthorized', err.message);
      }
    }
    const user = (auth && auth.user) || {};
    state.user = { id: String(user.id || ''), name: user.global_name || user.username || '', avatar: avatarUrl(user) };
    await Promise.all(['VOICE_CHANNEL_SELECT', 'VOICE_SETTINGS_UPDATE'].map((evt) => rpc.request('SUBSCRIBE', {}, { evt }).catch(() => {})));
    const vs = await rpc.request('GET_VOICE_SETTINGS').catch(() => null);
    if (vs) {
      state.mute = !!vs.mute;
      state.deaf = !!vs.deaf;
    }
    await loadChannel().catch(() => {});
    setStatus('ready');
  }

  function drop(status, message) {
    rpc = null;
    transport = null;
    subscribedChannel = null;
    state.channel = null;
    state.user = null;
    speaking.clear();
    setStatus(status, message);
  }

  async function tick() {
    if (stopped || connecting || rpc) return;
    const s = settings();
    if (!s.clientId || !s.clientSecret) return setStatus('unconfigured');
    connecting = true;
    try {
      const t = await connect(s.clientId);
      transport = t;
      rpc = new RpcSession(t, onEvent);
      t.on('close', () => {
        if (transport === t) drop('no-discord');
      });
      await authenticate();
    } catch (err) {
      if (transport) transport.close();
      drop(err.code === 'REFUSED' ? 'error' : 'no-discord', err.code === 'REFUSED' ? err.message : '');
    } finally {
      connecting = false;
    }
  }

  const requireReady = () => {
    if (!rpc || state.status !== 'ready') throw new Error('Discord n’est pas connecté');
  };

  /* ---------------- API ---------------- */

  return {
    start() {
      stopped = false;
      tick();
      timer = setInterval(tick, retryMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (transport) transport.close();
    },
    tick,

    /** Affiche la demande d'autorisation dans Discord (à accepter par l'utilisateur). */
    async authorize() {
      if (!rpc) await tick();
      if (!rpc) throw new Error(state.status === 'unconfigured' ? 'Application Discord non configurée' : 'Discord n’est pas lancé sur ce PC');
      const s = settings();
      setStatus('authorizing');
      try {
        const res = await rpc.request('AUTHORIZE', { client_id: s.clientId, scopes: SCOPES }, { timeoutMs: 120000 });
        await tokenRequest({ grant_type: 'authorization_code', code: res.code, redirect_uri: s.redirectUri });
        await authenticate();
      } catch (err) {
        if (state.status === 'authorizing') setStatus('unauthorized', err.message);
        throw err;
      }
      return this.snapshot();
    },

    async join(channelId) {
      requireReady();
      await rpc.request('SELECT_VOICE_CHANNEL', { channel_id: String(channelId), force: true }, { timeoutMs: 15000 });
      await loadChannel().catch(() => {});
    },
    async leave() {
      requireReady();
      await rpc.request('SELECT_VOICE_CHANNEL', { channel_id: null });
      await loadChannel().catch(() => {});
    },
    async setMute(value) {
      requireReady();
      const mute = typeof value === 'boolean' ? value : !state.mute;
      const res = await rpc.request('SET_VOICE_SETTINGS', { mute });
      state.mute = res && typeof res.mute === 'boolean' ? res.mute : mute;
    },
    async setDeaf(value) {
      requireReady();
      const deaf = typeof value === 'boolean' ? value : !state.deaf;
      const res = await rpc.request('SET_VOICE_SETTINGS', { deaf });
      state.deaf = res && typeof res.deaf === 'boolean' ? res.deaf : deaf;
    },

    /**
     * Réglages d'un participant, pour soi seulement (comme le clic droit dans Discord) :
     * volume de 0 à 200 % et / ou muet.
     */
    async setUserVoice(userId, { volume, mute } = {}) {
      requireReady();
      const id = String(userId || '');
      if (!id) throw new Error('Participant manquant');
      if (state.user && id === state.user.id) throw new Error('Utilisez les boutons Micro / Casque pour vous-même');
      const args = { user_id: id };
      if (volume !== undefined && volume !== null) args.volume = Math.max(0, Math.min(200, Math.round(Number(volume) || 0)));
      if (typeof mute === 'boolean') args.mute = mute;
      const res = (await rpc.request('SET_USER_VOICE_SETTINGS', args)) || {};
      const member = state.channel && state.channel.members.get(id);
      if (member) {
        const v = res.volume !== undefined && res.volume !== null ? Number(res.volume) : args.volume;
        if (Number.isFinite(v)) member.volume = Math.round(v);
        if (typeof res.mute === 'boolean') member.localMute = res.mute;
        else if (typeof args.mute === 'boolean') member.localMute = args.mute;
      }
    },

    async guilds() {
      requireReady();
      const res = await rpc.request('GET_GUILDS');
      return ((res && res.guilds) || []).map((g) => ({ id: String(g.id), name: g.name || '', icon: g.icon_url || null }));
    },
    async channels(guildId) {
      requireReady();
      const res = await rpc.request('GET_CHANNELS', { guild_id: String(guildId) });
      return ((res && res.channels) || []).filter((c) => VOICE_CHANNEL_TYPES.has(c.type)).map((c) => ({ id: String(c.id), name: c.name || '' }));
    },

    /** Ajoute ou retire un salon des favoris. */
    toggleFavorite(channel) {
      const id = String((channel && channel.id) || '');
      if (!id) throw new Error('Salon manquant');
      const index = data.favorites.findIndex((f) => f.id === id);
      if (index >= 0) data.favorites.splice(index, 1);
      else data.favorites.push({ id, name: String(channel.name || ''), guildName: String(channel.guildName || ''), icon: channel.icon ? String(channel.icon) : null });
      save();
      return data.favorites;
    },

    /** Retire une conversation privée de l'onglet MP. */
    forgetRecent(id) {
      data.recents = data.recents.filter((r) => r.id !== String(id));
      save();
      return data.recents;
    },

    snapshot() {
      const ch = state.channel;
      return {
        status: state.status,
        message: state.message,
        user: state.user,
        mute: state.mute,
        deaf: state.deaf,
        channel: ch
          ? {
              id: ch.id,
              kind: ch.kind,
              name: ch.name,
              guildId: ch.guildId,
              guildName: ch.guildName,
              icon: ch.icon,
              members: [...ch.members.values()].map((m) => ({ ...m, speaking: speaking.has(m.id) })),
            }
          : null,
        favorites: data.favorites,
        recents: data.recents,
      };
    },
  };
}

module.exports = { createDiscordVoice, RpcSession, toMember, SCOPES };
