'use strict';

/*
 * Widget iCUE « Edge Voice » : vocal de l'application Discord du PC, via l'agent local.
 *  - en vocal : participants (qui parle, micro / casque coupés), micro, casque, raccrocher ;
 *  - hors vocal : salons favoris, ou parcours serveurs > salons vocaux (étoile = favori).
 */
(function () {
  var Edge = window.Edge;

  var TEXTS = {
    fr: {
      notInVoice: 'Pas en vocal',
      pickChannel: 'Choisissez un salon',
      channels: 'Salons',
      back: 'Retour',
      close: 'Fermer',
      servers: 'Serveurs',
      favorites: 'Favoris',
      privateTab: 'MP',
      backToCall: 'Retour à l’appel',
      privateCall: 'Message privé',
      groupCall: 'Groupe',
      noPrivate: 'Aucune conversation privée pour l’instant. Lancez un appel en MP ou en groupe depuis Discord : il apparaîtra ici et vous pourrez le rejoindre d’un appui.',
      noServers: 'Aucun serveur trouvé.',
      noVoiceChannels: 'Aucun salon vocal sur ce serveur.',
      mic: 'Micro',
      micOff: 'Micro coupé',
      sound: 'Casque',
      soundOff: 'Sourdine',
      hangUp: 'Quitter',
      volume: 'Volume',
      muteForMe: 'Muet pour moi',
      mutedForMe: 'Muet pour moi : activé',
      mutedShort: 'Muet (moi)',
      resetVolume: 'Remettre à 100 %',
      onlyYou: 'Ces réglages ne s’appliquent qu’à vous.',
      alone: 'Vous êtes seul dans ce salon.',
      loading: 'Chargement…',
      agentOffline: 'Agent hors ligne',
      agentOfflineHelp: 'Lancez « Xeneon Edge Widget » sur le PC.',
      unavailable: 'Agent trop ancien',
      unavailableHelp: 'Mettez à jour et relancez « Xeneon Edge Widget » sur le PC.',
      unconfigured: 'Application Discord à configurer',
      unconfiguredHelp: 'Renseignez clientId et clientSecret dans config.json (section discordVoice). Voir le README.',
      noDiscord: 'Discord n’est pas lancé',
      noDiscordHelp: 'Ouvrez l’application Discord sur le PC.',
      unauthorized: 'Autorisation nécessaire',
      unauthorizedHelp: 'Touchez « Autoriser », puis acceptez la demande qui s’affiche dans Discord sur le PC.',
      authorize: 'Autoriser',
      authorizing: 'En attente de votre accord',
      authorizingHelp: 'Acceptez la demande affichée dans Discord sur le PC.',
      error: 'Connexion refusée par Discord',
      failed: 'Échec',
    },
    en: {
      notInVoice: 'Not in voice',
      pickChannel: 'Pick a channel',
      channels: 'Channels',
      back: 'Back',
      close: 'Close',
      servers: 'Servers',
      favorites: 'Favorites',
      privateTab: 'DMs',
      backToCall: 'Back to call',
      privateCall: 'Direct message',
      groupCall: 'Group',
      noPrivate: 'No private conversation yet. Start a DM or group call from Discord: it will show up here and you can rejoin it with one tap.',
      noServers: 'No server found.',
      noVoiceChannels: 'No voice channel on this server.',
      mic: 'Mic',
      micOff: 'Muted',
      sound: 'Sound',
      soundOff: 'Deafened',
      hangUp: 'Leave',
      volume: 'Volume',
      muteForMe: 'Mute for me',
      mutedForMe: 'Muted for me: on',
      mutedShort: 'Muted (me)',
      resetVolume: 'Reset to 100%',
      onlyYou: 'These settings only apply to you.',
      alone: 'You are alone in this channel.',
      loading: 'Loading…',
      agentOffline: 'Agent offline',
      agentOfflineHelp: 'Start “Xeneon Edge Widget” on the PC.',
      unavailable: 'Agent too old',
      unavailableHelp: 'Update and restart “Xeneon Edge Widget” on the PC.',
      unconfigured: 'Discord application not configured',
      unconfiguredHelp: 'Set clientId and clientSecret in config.json (discordVoice section). See the README.',
      noDiscord: 'Discord is not running',
      noDiscordHelp: 'Open the Discord app on the PC.',
      unauthorized: 'Authorization required',
      unauthorizedHelp: 'Tap “Authorize”, then accept the request shown in Discord on the PC.',
      authorize: 'Authorize',
      authorizing: 'Waiting for your approval',
      authorizingHelp: 'Accept the request shown in Discord on the PC.',
      error: 'Connection refused by Discord',
      failed: 'Failed',
    },
  };

  function t(key) {
    return (TEXTS[Edge.lang()] || TEXTS.en)[key] || TEXTS.en[key] || key;
  }

  var state = {
    online: null,
    snap: null,
    view: 'auto', // auto (appel en cours, sinon listes) | lists | channels
    tab: 'servers', // servers | dm
    guilds: null,
    guildsLoading: false,
    guild: null,
    channels: null,
    busy: false,
    selected: null, // participant dont le panneau de réglage est ouvert
    dragging: false,
    signature: '',
  };

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* -------------------------------------------------------------- */
  /* Appels à l'agent                                                */
  /* -------------------------------------------------------------- */

  function send(body, timeout) {
    return Edge.agent.post('/api/voice', body, timeout).then(function (res) {
      if (res && res.voice) state.snap = res.voice;
      if (!res || !res.ok) Edge.toast((res && res.error) || t('failed'), true);
      render();
      return res;
    }).catch(function () {
      Edge.toast(t('agentOffline'), true);
    });
  }

  function poll() {
    Edge.agent.get('/api/voice').then(function (snap) {
      state.online = true;
      state.snap = snap;
      render();
    }).catch(function () {
      state.online = false;
      state.snap = null;
      render();
    });
  }

  function isFavorite(id) {
    var favs = (state.snap && state.snap.favorites) || [];
    for (var i = 0; i < favs.length; i++) if (favs[i].id === id) return true;
    return false;
  }

  function loadGuilds() {
    if (state.guildsLoading) return;
    state.guildsLoading = true;
    Edge.agent.get('/api/voice/guilds').then(function (res) {
      state.guildsLoading = false;
      if (res && res.ok) state.guilds = res.guilds || [];
      else if (!state.guilds) state.guilds = [];
      render();
    }).catch(function () {
      state.guildsLoading = false;
      if (!state.guilds) state.guilds = [];
      render();
    });
  }

  function showLists(tab) {
    state.selected = null;
    if (tab) state.tab = tab;
    state.view = state.snap && state.snap.channel ? 'lists' : 'auto';
    if (state.tab === 'servers') loadGuilds();
    render();
  }

  function openChannels(guild) {
    state.view = 'channels';
    state.guild = guild;
    state.channels = null;
    render();
    Edge.agent.get('/api/voice/channels?guild=' + encodeURIComponent(guild.id)).then(function (res) {
      state.channels = (res && res.channels) || [];
      if (res && !res.ok) Edge.toast(res.error || t('failed'), true);
      render();
    }).catch(function () { state.channels = []; render(); });
  }

  function join(id) {
    state.view = 'auto';
    send({ op: 'join', channelId: id }, 20000);
  }

  /* -------------------------------------------------------------- */
  /* Vues                                                            */
  /* -------------------------------------------------------------- */

  function statusView(title, help, button) {
    var box = el('div', 'status');
    box.appendChild(el('div', 'status-title', title));
    if (help) box.appendChild(el('p', 'status-help', help));
    if (button) {
      var b = el('button', 'primary', button.label);
      b.type = 'button';
      b.addEventListener('click', button.onClick);
      box.appendChild(b);
    }
    return box;
  }

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?').charAt(0) + (parts.length > 1 ? parts[1].charAt(0) : '')).toUpperCase();
  }

  function memberTile(m) {
    var tile = el(m.self ? 'div' : 'button', 'member' + (m.speaking ? ' speaking' : '') + (m.self ? ' self' : ''));
    if (!m.self) {
      tile.type = 'button';
      tile.addEventListener('click', function () {
        state.selected = m.id;
        render();
      });
    }
    var avatar = el('div', 'avatar');
    if (m.avatar && Edge.boolProp('showAvatars', true)) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = m.avatar;
      img.addEventListener('error', function () { avatar.textContent = initials(m.name); });
      avatar.appendChild(img);
    } else avatar.textContent = initials(m.name);
    tile.appendChild(avatar);
    var name = el('div', 'member-name', m.name);
    tile.appendChild(name);
    if (m.deaf || m.mute) tile.appendChild(el('div', 'badge', m.deaf ? t('soundOff') : t('micOff')));
    if (m.localMute) tile.appendChild(el('div', 'badge local', t('mutedShort')));
    else if (!m.self && m.volume !== 100) tile.appendChild(el('div', 'badge local', m.volume + ' %'));
    return tile;
  }

  function findMember(channel, id) {
    var members = (channel && channel.members) || [];
    for (var i = 0; i < members.length; i++) if (members[i].id === id) return members[i];
    return null;
  }

  var volumeTimer = null;
  function sendVolume(id, value, now) {
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(function () {
      Edge.agent.post('/api/voice', { op: 'user', userId: id, volume: value }).then(function (res) {
        if (res && !res.ok) Edge.toast(res.error || t('failed'), true);
      }).catch(function () {});
    }, now ? 0 : 120);
  }

  /** Panneau de réglage d'un participant : volume et muet, pour soi seulement. */
  function panelView(m) {
    var box = el('div', 'panel');
    var head = el('div', 'panel-head');
    var avatar = el('div', 'avatar');
    avatar.id = 'panel-avatar';
    if (m.avatar && Edge.boolProp('showAvatars', true)) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = m.avatar;
      img.addEventListener('error', function () { avatar.textContent = initials(m.name); });
      avatar.appendChild(img);
    } else avatar.textContent = initials(m.name);
    head.appendChild(avatar);
    var who = el('div', 'panel-who');
    who.appendChild(el('div', 'panel-name', m.name));
    who.appendChild(el('div', 'panel-note', t('onlyYou')));
    head.appendChild(who);
    box.appendChild(head);

    var line = el('div', 'panel-line');
    line.appendChild(el('span', 'panel-label', t('volume')));
    var value = el('span', 'panel-value');
    value.id = 'panel-value';
    line.appendChild(value);
    box.appendChild(line);

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'panel-slider';
    slider.className = 'slider';
    slider.min = '0';
    slider.max = '200';
    slider.step = '5';
    slider.value = String(m.volume);
    var begin = function () { state.dragging = true; };
    var finish = function () { state.dragging = false; };
    slider.addEventListener('pointerdown', begin);
    slider.addEventListener('pointerup', finish);
    slider.addEventListener('pointercancel', finish);
    slider.addEventListener('input', function () {
      value.textContent = slider.value + ' %';
      sendVolume(m.id, Number(slider.value), false);
    });
    slider.addEventListener('change', function () {
      state.dragging = false;
      sendVolume(m.id, Number(slider.value), true);
    });
    box.appendChild(slider);

    var actions = el('div', 'panel-actions');
    var mute = el('button', 'panel-btn');
    mute.type = 'button';
    mute.id = 'panel-mute';
    mute.addEventListener('click', function () {
      send({ op: 'user', userId: m.id, mute: !mute.classList.contains('on') });
    });
    actions.appendChild(mute);
    var reset = el('button', 'panel-btn', t('resetVolume'));
    reset.type = 'button';
    reset.addEventListener('click', function () {
      slider.value = '100';
      value.textContent = '100 %';
      send({ op: 'user', userId: m.id, volume: 100 });
    });
    actions.appendChild(reset);
    box.appendChild(actions);
    return box;
  }

  /** Met à jour le panneau sans le reconstruire (pour ne pas interrompre un glissement du curseur). */
  function updatePanel(m) {
    var slider = $('panel-slider');
    if (!slider) return;
    if (!state.dragging) {
      if (document.activeElement !== slider) slider.value = String(m.volume);
      $('panel-value').textContent = slider.value + ' %';
    }
    var mute = $('panel-mute');
    mute.classList.toggle('on', !!m.localMute);
    mute.textContent = m.localMute ? t('mutedForMe') : t('muteForMe');
    $('panel-avatar').classList.toggle('talking', !!m.speaking);
  }

  function membersView(channel) {
    var members = channel.members || [];
    if (members.length <= 1) {
      var wrap = el('div', 'members');
      members.forEach(function (m) { wrap.appendChild(memberTile(m)); });
      var box = el('div', 'stack');
      box.appendChild(wrap);
      box.appendChild(el('p', 'hint', t('alone')));
      return box;
    }
    var grid = el('div', 'members');
    grid.setAttribute('data-count', String(Math.min(members.length, 12)));
    members.forEach(function (m) { grid.appendChild(memberTile(m)); });
    return grid;
  }

  /** Logo d'un serveur (carré arrondi) ou avatar d'une personne (rond), avec initiales en secours. */
  function iconEl(url, name, round) {
    var box = el('span', 'icon' + (round ? ' round' : ''));
    if (url && Edge.boolProp('showAvatars', true)) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = url;
      img.addEventListener('error', function () { box.textContent = initials(name); });
      box.appendChild(img);
    } else box.textContent = initials(name);
    return box;
  }

  function row(label, sub, onClick, star, icon) {
    var r = el('div', 'row');
    var main = el('button', 'row-main');
    main.type = 'button';
    if (icon) main.appendChild(icon);
    var texts = el('span', 'row-texts');
    texts.appendChild(el('span', 'row-label', label));
    if (sub) texts.appendChild(el('span', 'row-sub', sub));
    main.appendChild(texts);
    main.addEventListener('click', onClick);
    r.appendChild(main);
    if (star) {
      var s = el('button', 'star' + (star.on ? ' on' : ''), star.symbol || (star.on ? '★' : '☆'));
      s.type = 'button';
      s.addEventListener('click', star.onClick);
      r.appendChild(s);
    }
    return r;
  }

  function tabsBar() {
    var bar = el('div', 'tabs');
    [['servers', t('servers')], ['dm', t('privateTab')]].forEach(function (def) {
      var b = el('button', 'tab' + (state.tab === def[0] ? ' active' : ''), def[1]);
      b.type = 'button';
      b.addEventListener('click', function () { showLists(def[0]); });
      bar.appendChild(b);
    });
    return bar;
  }

  /** Onglet Serveurs : salons favoris, puis tous les serveurs. */
  function serversList(snap) {
    var box = el('div', 'list');
    var favs = snap.favorites || [];
    if (favs.length) box.appendChild(el('div', 'section', t('favorites')));
    favs.forEach(function (f) {
      box.appendChild(row(f.name || f.id, f.guildName, function () { join(f.id); }, {
        on: true,
        onClick: function () { send({ op: 'favorite', channel: f }); },
      }, iconEl(f.icon, f.guildName || f.name, false)));
    });
    box.appendChild(el('div', 'section', t('servers')));
    if (!state.guilds) box.appendChild(el('p', 'hint', t('loading')));
    else if (!state.guilds.length) box.appendChild(el('p', 'hint', t('noServers')));
    (state.guilds || []).forEach(function (g) {
      box.appendChild(row(g.name, '', function () { openChannels(g); }, null, iconEl(g.icon, g.name, false)));
    });
    return box;
  }

  /** Onglet MP : conversations privées et groupes déjà utilisés en vocal. */
  function privateList(snap) {
    var box = el('div', 'list');
    var recents = snap.recents || [];
    if (!recents.length) box.appendChild(el('p', 'hint', t('noPrivate')));
    recents.forEach(function (r) {
      var first = (r.avatars || [])[0] || {};
      var label = r.name || (r.kind === 'group' ? t('groupCall') : t('privateCall'));
      box.appendChild(row(label, r.kind === 'group' ? t('groupCall') : t('privateCall'), function () { join(r.id); }, {
        on: false,
        symbol: '✕',
        onClick: function () { send({ op: 'forget', channelId: r.id }); },
      }, iconEl(first.url, first.name || label, true)));
    });
    return box;
  }

  function listsView(snap) {
    var box = el('div', 'lists');
    box.appendChild(tabsBar());
    box.appendChild(state.tab === 'dm' ? privateList(snap) : serversList(snap));
    return box;
  }

  function channelsView() {
    var box = el('div', 'list');
    if (!state.channels) box.appendChild(el('p', 'hint', t('loading')));
    else if (!state.channels.length) box.appendChild(el('p', 'hint', t('noVoiceChannels')));
    (state.channels || []).forEach(function (c) {
      box.appendChild(row(c.name, '', function () { join(c.id); }, {
        on: isFavorite(c.id),
        onClick: function () { send({ op: 'favorite', channel: { id: c.id, name: c.name, guildName: state.guild.name, icon: state.guild.icon } }); },
      }));
    });
    return box;
  }

  /* -------------------------------------------------------------- */
  /* Rendu                                                           */
  /* -------------------------------------------------------------- */

  function setControl(id, labelId, active, label) {
    $(id).classList.toggle('off', !!active);
    $(labelId).textContent = label;
  }

  function render() {
    var snap = state.snap;
    var ready = !!(snap && snap.status === 'ready');
    var channel = ready ? snap.channel : null;
    if (!ready) state.view = 'auto';
    if (state.view === 'lists' && !channel) state.view = 'auto';
    var lists = ready && (state.view === 'lists' || (state.view === 'auto' && !channel));
    if (lists && state.tab === 'servers' && !state.guilds) loadGuilds();

    // On ne reconstruit la zone centrale que si son contenu change (évite de perdre un appui en cours).
    var selected = ready && state.view === 'auto' && state.selected ? findMember(channel, state.selected) : null;
    if (!selected) state.selected = null;
    // Panneau ouvert : il n'est reconstruit que si l'on change de participant.
    var signature = selected
      ? JSON.stringify(['panel', selected.id, Edge.boolProp('showAvatars', true)])
      : JSON.stringify([state.online, snap, state.view, state.tab, state.guilds, state.channels, Edge.boolProp('showAvatars', true)]);
    var changed = signature !== state.signature;
    state.signature = signature;

    $('controls').classList.toggle('disabled', !ready);
    $('hang').hidden = !channel;
    setControl('mute', 'mute-label', ready && snap.mute, ready && snap.mute ? t('micOff') : t('mic'));
    setControl('deaf', 'deaf-label', ready && snap.deaf, ready && snap.deaf ? t('soundOff') : t('sound'));
    $('hang-label').textContent = t('hangUp');

    var nav = $('nav');
    var title = '';
    var sub = '';
    var body;

    if (state.online === false) body = statusView(t('agentOffline'), t('agentOfflineHelp'));
    else if (!snap) body = statusView(t('loading'));
    else if (snap.status === 'unavailable') body = statusView(t('unavailable'), t('unavailableHelp'));
    else if (snap.status === 'unconfigured') body = statusView(t('unconfigured'), t('unconfiguredHelp'));
    else if (snap.status === 'no-discord') body = statusView(t('noDiscord'), t('noDiscordHelp'));
    else if (snap.status === 'error') body = statusView(t('error'), snap.message);
    else if (snap.status === 'authorizing') body = statusView(t('authorizing'), t('authorizingHelp'));
    else if (snap.status === 'unauthorized') {
      body = statusView(t('unauthorized'), snap.message || t('unauthorizedHelp'), {
        label: t('authorize'),
        onClick: function () { send({ op: 'authorize' }, 125000); setTimeout(poll, 300); },
      });
    } else if (state.view === 'channels') {
      title = state.guild ? state.guild.name : t('channels');
      sub = t('pickChannel');
      body = channelsView();
    } else if (lists) {
      title = channel ? channel.name || t('privateCall') : t('notInVoice');
      sub = channel ? '' : t('pickChannel');
      body = listsView(snap);
    } else if (selected) {
      title = selected.name;
      sub = channel.name || '';
      body = panelView(selected);
    } else {
      title = channel.name || (channel.kind === 'group' ? t('groupCall') : t('privateCall'));
      sub = channel.kind === 'guild' ? channel.guildName || '' : channel.kind === 'group' ? t('groupCall') : t('privateCall');
      body = membersView(channel);
    }

    $('title').textContent = title;
    $('sub').textContent = sub;

    // Bouton d'en-tête : Retour (liste des salons), Retour à l'appel (listes), Salons (appel en cours).
    nav.hidden = !ready || (lists && !channel);
    if (state.view === 'channels') nav.textContent = t('back');
    else if (lists) nav.textContent = t('backToCall');
    else if (selected) nav.textContent = t('back');
    else nav.textContent = t('channels');

    if (changed) {
      var host = $('body');
      host.textContent = '';
      host.appendChild(body);
      state.dragging = false;
    }
    if (selected) updatePanel(selected);
  }

  function onNav() {
    if (state.selected && state.view === 'auto') {
      state.selected = null;
      return render();
    }
    if (state.view === 'channels') return showLists('servers');
    if (state.view === 'lists') {
      state.view = 'auto';
      return render();
    }
    showLists();
  }

  Edge.start({
    init: function () {
      $('mute').addEventListener('click', function () { send({ op: 'mute' }); });
      $('deaf').addEventListener('click', function () { send({ op: 'deaf' }); });
      $('hang').addEventListener('click', function () { send({ op: 'leave' }); });
      $('nav').addEventListener('click', onNav);
      poll();
      setInterval(poll, 700);
    },
    update: function () {
      Edge.applyTheme();
      render();
    },
  });
})();
