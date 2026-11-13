'use strict';

/* Widget iCUE « Edge Deck » : grille de boutons dont les actions sont exécutées par l'agent local. */
(function () {
  var Edge = window.Edge;
  var CACHE_KEY = 'xeneon-edge-deck-config';
  var DEFAULT_ICONS = { app: '🚀', url: '🌐', browser: '🧭', folder: '📁', file: '📄', command: '⌨️', hotkey: '⌨️', media: '🎵', text: '💬', page: '📑', discord: '💬', multi: '⚡', sonar: '🔈' };

  var state = {
    config: null,
    configJson: '',
    page: 0,
    stateful: [],
    iconCache: {},
    online: null,
  };

  /* -------------------------------------------------------------- */
  /* Configuration (via l'agent, avec cache local)                   */
  /* -------------------------------------------------------------- */

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(cfg) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cfg));
    } catch (e) {
      /* ignore */
    }
  }

  function setOnline(online) {
    if (state.online === online) return;
    state.online = online;
    document.getElementById('offline').classList.toggle('show', !online);
    document.body.classList.toggle('is-offline', !online);
  }

  function loadConfig() {
    return Edge.agent
      .config()
      .then(function (cfg) {
        setOnline(true);
        var json = JSON.stringify(cfg.deck);
        if (json !== state.configJson) {
          state.config = cfg;
          state.configJson = json;
          writeCache(cfg);
          render();
        } else {
          refreshStates();
        }
      })
      .catch(function () {
        setOnline(false);
        if (!state.config) {
          state.config = readCache() || { deck: { columns: 4, rows: 3, pages: [{ name: '', buttons: [] }] } };
          state.configJson = JSON.stringify(state.config.deck);
          render();
        }
      });
  }

  /* -------------------------------------------------------------- */
  /* Rendu                                                           */
  /* -------------------------------------------------------------- */

  function pages() {
    return (state.config && state.config.deck && state.config.deck.pages) || [];
  }

  function lockedPageIndex() {
    var name = String(Edge.prop('pageName', '') || '').trim().toLowerCase();
    if (!name) return -1;
    var list = pages();
    for (var i = 0; i < list.length; i++) if (String(list[i].name || '').toLowerCase() === name) return i;
    var n = parseInt(name, 10);
    return isFinite(n) && n >= 1 && n <= list.length ? n - 1 : -1;
  }

  function renderTabs() {
    var nav = document.getElementById('tabs');
    nav.textContent = '';
    var list = pages();
    var show = Edge.boolProp('showTabs', true) && list.length > 1 && lockedPageIndex() === -1;
    nav.style.display = show ? '' : 'none';
    if (!show) return;
    list.forEach(function (p, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.name || String(i + 1);
      b.setAttribute('aria-current', String(i === state.page));
      b.addEventListener('click', function () {
        state.page = i;
        render();
      });
      nav.appendChild(b);
    });
  }

  function looksLikeImage(s) {
    return typeof s === 'string' && /(^data:image\/)|(^https?:\/\/)|(\.(png|jpe?g|gif|svg|webp|ico)$)/i.test(s);
  }

  function setImage(container, src) {
    container.textContent = '';
    var img = new Image();
    img.alt = '';
    img.src = src;
    container.appendChild(img);
  }

  function renderIcon(container, button) {
    var icon = button.icon;
    var action = button.action || {};
    if (icon && looksLikeImage(icon)) {
      if (/^(data:|https?:)/i.test(icon)) return setImage(container, icon);
      // Image locale : lue par l'agent (le widget n'a pas accès aux fichiers du PC).
      return fetchIcon('image', icon, container, DEFAULT_ICONS[action.type]);
    }
    if (icon) {
      container.textContent = icon;
      return;
    }
    if (action.type === 'app' && action.path) return fetchIcon('icon', action.path, container, DEFAULT_ICONS.app);
    container.textContent = DEFAULT_ICONS[action.type] || '⬛';
  }

  function fetchIcon(kind, path, container, fallback) {
    var key = kind + ':' + path;
    if (state.iconCache[key] !== undefined) {
      if (state.iconCache[key]) setImage(container, state.iconCache[key]);
      else container.textContent = fallback || '⬛';
      return;
    }
    container.textContent = fallback || '⬛';
    var req = kind === 'image' ? Edge.agent.image(path) : Edge.agent.icon(path);
    req
      .then(function (res) {
        state.iconCache[key] = (res && res.dataUrl) || null;
        if (state.iconCache[key]) setImage(container, state.iconCache[key]);
      })
      .catch(function () {
        /* agent hors ligne : on réessaiera au prochain rendu */
      });
  }

  function render() {
    if (!state.config) return;
    var deck = state.config.deck;
    var list = pages();
    var locked = lockedPageIndex();
    if (locked >= 0) state.page = locked;
    if (state.page >= list.length) state.page = 0;
    var page = list[state.page] || { buttons: [] };

    var columns = Edge.numProp('gridColumns', 0) || deck.columns || 4;
    var rows = Edge.numProp('gridRows', 0) || deck.rows || 3;

    renderTabs();
    document.body.classList.toggle('no-labels', !Edge.boolProp('showLabels', true));

    var grid = document.getElementById('grid');
    grid.textContent = '';
    grid.style.gridTemplateColumns = 'repeat(' + columns + ', minmax(0, 1fr))';
    grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    state.stateful = [];

    for (var i = 0; i < columns * rows; i++) {
      var button = (page.buttons || [])[i] || {};
      grid.appendChild(createKey(button));
    }
    sizeKeys();
    refreshStates();
  }

  function createKey(button) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'key';
    if (!button.action && !button.label && !button.icon) {
      el.className += ' empty';
      el.disabled = true;
      return el;
    }
    if (button.color) el.style.setProperty('--key-color', button.color);
    var icon = document.createElement('span');
    icon.className = 'key-icon';
    var label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = button.label || '';
    el.appendChild(icon);
    el.appendChild(label);
    renderIcon(icon, button);

    if (button.action && (button.action.type === 'sonar' || button.action.type === 'nas')) {
      var sub = document.createElement('span');
      sub.className = 'key-sub';
      sub.textContent = button.label || '';
      label.textContent = '…';
      el.appendChild(sub);
      state.stateful.push({ el: el, button: button });
    }
    el.addEventListener('click', function () {
      press(el, button);
    });
    return el;
  }

  /** Adapte la taille des icônes et textes à la taille réelle des touches. */
  function sizeKeys() {
    var grid = document.getElementById('grid');
    var first = grid.querySelector('.key');
    if (!first) return;
    var w = first.clientWidth;
    var h = first.clientHeight;
    var s = Math.min(w, h);
    grid.style.setProperty('--icon-size', Math.round(s * (Edge.boolProp('showLabels', true) ? 0.4 : 0.55)) + 'px');
    grid.style.setProperty('--label-size', Math.max(10, Math.min(20, Math.round(s * 0.11))) + 'px');
    grid.style.setProperty('--sub-size', Math.max(8, Math.min(13, Math.round(s * 0.075))) + 'px');
  }

  /* -------------------------------------------------------------- */
  /* Boutons à état (sortie audio Sonar)                             */
  /* -------------------------------------------------------------- */

  function applyKeyState(el, button, st) {
    var label = el.querySelector('.key-label');
    var icon = el.querySelector('.key-icon');
    if (st && (st.label || st.deviceName)) {
      label.textContent = st.label || st.deviceName;
      renderIcon(icon, { icon: st.icon || button.icon, action: button.action });
      el.classList.remove('stale');
    } else {
      label.textContent = '?';
      el.classList.add('stale');
    }
  }

  function refreshStates() {
    if (!state.online) return;
    state.stateful.forEach(function (item) {
      Edge.agent
        .state(item.button.action)
        .then(function (res) {
          applyKeyState(item.el, item.button, res && res.ok ? res.state : null);
        })
        .catch(function () {
          applyKeyState(item.el, item.button, null);
        });
    });
  }

  /* -------------------------------------------------------------- */
  /* Appui                                                           */
  /* -------------------------------------------------------------- */

  function flash(el, cls) {
    el.classList.remove('ok', 'error');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(function () {
      el.classList.remove(cls);
    }, cls === 'error' ? 900 : 450);
  }

  /** https://discord.com/channels/... -> discord://-/channels/... (ouvre l'application Discord). */
  function discordAppUrl(url) {
    var m = /^https?:\/\/(?:www\.|ptb\.|canary\.)?discord(?:app)?\.com\/(.*)$/i.exec(url || '');
    return m ? 'discord://-/' + m[1] : url;
  }

  function toAgentAction(action) {
    if (action.type === 'discord') return { type: 'url', url: discordAppUrl(action.url) };
    if (action.type === 'multi') {
      return {
        type: 'multi',
        delayMs: action.delayMs,
        actions: (action.actions || []).filter(function (a) { return a.type !== 'page'; }).map(toAgentAction),
      };
    }
    return action;
  }

  function goToPage(target) {
    var list = pages();
    var index = typeof target === 'number' ? target : -1;
    if (index < 0) for (var i = 0; i < list.length; i++) if (list[i].name === target) index = i;
    if (index >= 0 && index < list.length && lockedPageIndex() === -1) {
      state.page = index;
      render();
    }
  }

  function press(el, button) {
    var action = button.action;
    if (!action) return;
    if (action.type === 'page') return goToPage(action.page);
    if (action.type === 'multi') {
      (action.actions || []).forEach(function (a) { if (a.type === 'page') goToPage(a.page); });
    }

    if (!state.online) {
      // Sans agent, seuls les liens peuvent s'ouvrir (plugin Link Provider d'iCUE).
      var url = action.type === 'url' ? action.url : action.type === 'discord' ? action.url : null;
      if (url && Edge.openLink(url)) return flash(el, 'ok');
      flash(el, 'error');
      Edge.toast(Edge.t('agentOffline'), true);
      return;
    }

    Edge.agent
      .run(toAgentAction(action))
      .then(function (res) {
        if (res && res.ok) {
          flash(el, 'ok');
          if (res.result && action.type === 'sonar') {
            applyKeyState(el, button, res.result);
            Edge.toast(Edge.t('audioOutput', { x: res.result.label || res.result.deviceName }));
          }
          if (res.result && action.type === 'nas') {
            applyKeyState(el, button, res.result);
            if (res.result.message) Edge.toast(res.result.message);
            // La demande de confirmation expire après 5 s : on réaffiche alors l'état réel.
            setTimeout(refreshStates, 5500);
          }
        } else {
          flash(el, 'error');
          Edge.toast((res && res.error) || Edge.t('actionFailed'), true);
        }
      })
      .catch(function () {
        setOnline(false);
        flash(el, 'error');
        Edge.toast(Edge.t('agentOffline'), true);
      });
  }

  /* -------------------------------------------------------------- */
  /* Démarrage                                                       */
  /* -------------------------------------------------------------- */

  Edge.start({
    init: function () {
      document.getElementById('offline-title').textContent = Edge.t('agentOffline');
      document.getElementById('offline-help').textContent = Edge.t('agentHelp');
      loadConfig();
      // Recharge la configuration (modifiable à chaud) et l'état des boutons Sonar.
      setInterval(loadConfig, 10000);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sizeKeys).observe(document.getElementById('grid'));
      else window.addEventListener('resize', sizeKeys);
    },
    update: function () {
      Edge.applyTheme();
      render();
    },
  });
})();
