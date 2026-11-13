'use strict';

/**
 * Bibliothèque commune aux widgets iCUE Xeneon Edge.
 *  - Edge.props        : lecture des propriétés iCUE (variables globales injectées)
 *  - Edge.start        : cycle de vie (onICUEInitialized / onDataUpdated), aussi hors iCUE
 *  - Edge.agent        : client de l'agent local (actions, statistiques, configuration)
 *  - Edge.t            : textes FR / EN
 *  - Edge.fmt          : formatage des nombres
 *  - Edge.applyTheme   : couleurs personnalisées (textColor, accentColor, backgroundColor)
 */
(function () {
  var AGENT_URL = 'http://localhost:17890';

  /* -------------------------------------------------------------- */
  /* Propriétés iCUE                                                 */
  /* -------------------------------------------------------------- */

  function prop(name, fallback) {
    try {
      if (Object.prototype.hasOwnProperty.call(window, name)) {
        var v = window[name];
        if (v !== undefined && v !== null && v !== '') return v;
      }
      // Les propriétés peuvent être déclarées avec let/const : pas toujours sur window.
      var value = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
      if (value !== undefined && value !== null && value !== '') return value;
    } catch (e) {
      /* ignore */
    }
    return fallback;
  }

  function boolProp(name, fallback) {
    var v = prop(name, fallback);
    return v === true || v === 'true' || v === 1;
  }

  function numProp(name, fallback) {
    var v = Number(prop(name, fallback));
    return isFinite(v) ? v : fallback;
  }

  /**
   * Valeur d'une variable globale injectée par iCUE (iCUE_initialized, plugin…_initialized).
   * Ces variables ne sont pas forcément des propriétés de window : on les lit par leur nom.
   * Renvoie undefined si la variable n'existe pas.
   */
  function globalValue(name) {
    try {
      if (Object.prototype.hasOwnProperty.call(window, name)) return window[name];
      return Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
    } catch (e) {
      return undefined;
    }
  }

  var inIcue = typeof window.iCUE !== 'undefined' || globalValue('iCUE_initialized') !== undefined;

  /* -------------------------------------------------------------- */
  /* Cycle de vie                                                    */
  /* -------------------------------------------------------------- */

  function start(handlers) {
    var initialized = false;
    function init() {
      if (initialized) return;
      initialized = true;
      if (handlers.init) handlers.init();
      if (handlers.update) handlers.update();
    }
    function update() {
      if (!initialized) return init();
      if (handlers.update) handlers.update();
    }
    window.icueEvents = { onICUEInitialized: init, onDataUpdated: update };
    if (globalValue('iCUE_initialized')) init();
    // Hors iCUE (prévisualisation dans un navigateur) : démarrage direct.
    if (!inIcue) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
      return;
    }
    // Au démarrage du PC ou de l'écran, iCUE peut avoir fini son initialisation avant que la page
    // n'écoute onICUEInitialized : le widget restait alors vide. On surveille donc l'indicateur,
    // et on démarre de toute façon au bout de quelques secondes (réglages par défaut au pire).
    var waited = 0;
    var watch = setInterval(function () {
      waited += 250;
      if (initialized) return clearInterval(watch);
      if (globalValue('iCUE_initialized') || waited >= 5000) {
        clearInterval(watch);
        init();
      }
    }, 250);
  }

  /* -------------------------------------------------------------- */
  /* Textes                                                          */
  /* -------------------------------------------------------------- */

  var TEXTS = {
    fr: {
      agentOffline: 'Agent hors ligne',
      agentHelp: 'Lancez « Xeneon Edge Widget » sur le PC (mode agent).',
      actionFailed: 'Échec de l’action',
      usage: 'utilisation',
      power: 'Puissance',
      clock: 'Fréquence',
      fan: 'Ventilateur',
      memory: 'Mémoire',
      disks: 'Disques',
      network: 'Réseau',
      used: 'utilisée',
      free: 'libres',
      notDetected: 'Non détecté',
      normal: 'Normal',
      hot: 'Chaud',
      critical: 'Critique',
      na: 'N/D',
      history: 'Utilisation – 90 s',
      now: 'maintenant',
      ago: 'il y a {n} s',
      uptime: 'Allumé depuis {d}',
      emptyPage: 'Aucun bouton sur cette page',
      audioOutput: 'Sortie audio : {x}',
      openDiscord: 'Ouvrir Discord',
      discordHelp: 'Le client web Discord s’ouvre dans ce widget. Connectez-vous une fois : la session est conservée.',
      discordServerHelp: 'Indiquez l’ID de votre serveur dans les réglages du widget (Paramètres du serveur > Widget).',
      openDeezer: 'Ouvrir Deezer',
      deezerHelp: 'Le lecteur web Deezer s’ouvre dans ce widget. Connectez-vous une fois : la session est conservée.',
    },
    en: {
      agentOffline: 'Agent offline',
      agentHelp: 'Start “Xeneon Edge Widget” on the PC (agent mode).',
      actionFailed: 'Action failed',
      usage: 'usage',
      power: 'Power',
      clock: 'Clock',
      fan: 'Fan',
      memory: 'Memory',
      disks: 'Disks',
      network: 'Network',
      used: 'used',
      free: 'free',
      notDetected: 'Not detected',
      normal: 'Normal',
      hot: 'Hot',
      critical: 'Critical',
      na: 'N/A',
      history: 'Usage – 90 s',
      now: 'now',
      ago: '{n} s ago',
      uptime: 'Up {d}',
      emptyPage: 'No button on this page',
      audioOutput: 'Audio output: {x}',
      openDiscord: 'Open Discord',
      discordHelp: 'The Discord web client opens in this widget. Log in once: the session is kept.',
      discordServerHelp: 'Set your server ID in the widget settings (Server Settings > Widget).',
      openDeezer: 'Open Deezer',
      deezerHelp: 'The Deezer web player opens in this widget. Log in once: the session is kept.',
    },
  };

  function lang() {
    var l = (window.iCUE && window.iCUE.iCUELanguage) || navigator.language || 'fr';
    return String(l).slice(0, 2).toLowerCase() === 'fr' ? 'fr' : 'en';
  }

  function t(key, vars) {
    var s = (TEXTS[lang()] && TEXTS[lang()][key]) || TEXTS.en[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }

  /* -------------------------------------------------------------- */
  /* Agent local                                                     */
  /* -------------------------------------------------------------- */

  function request(path, options) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, (options && options.timeout) || 4000);
    var init = { method: (options && options.method) || 'GET', signal: controller ? controller.signal : undefined };
    if (options && options.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    return fetch(AGENT_URL + path, init)
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok && res.status !== 200) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .catch(function (err) {
        clearTimeout(timer);
        throw err;
      });
  }

  var agent = {
    url: AGENT_URL,
    online: null,
    config: function () { return request('/api/config'); },
    stats: function () { return request('/api/stats'); },
    run: function (action) { return request('/api/action', { method: 'POST', body: { action: action }, timeout: 15000 }); },
    state: function (action) { return request('/api/state', { method: 'POST', body: { action: action }, timeout: 8000 }); },
    icon: function (path) { return request('/api/icon?path=' + encodeURIComponent(path)); },
    image: function (path) { return request('/api/image?path=' + encodeURIComponent(path)); },
  };

  /* -------------------------------------------------------------- */
  /* Formatage                                                       */
  /* -------------------------------------------------------------- */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function locale() { return lang() === 'fr' ? 'fr-FR' : 'en-US'; }
  function num(v, digits) {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits || 0, minimumFractionDigits: digits || 0 }).format(v);
  }
  function bytes(v, digits) {
    if (!isNum(v)) return '—';
    var units = lang() === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    var d = digits === undefined ? 1 : digits;
    return num(v, i === 0 || v >= 100 ? 0 : d) + ' ' + units[i];
  }
  function duration(sec) {
    if (!isNum(sec)) return '';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return (d ? d + (lang() === 'fr' ? ' j ' : ' d ') : '') + h + ' h ' + String(m).padStart(2, '0');
  }

  /* -------------------------------------------------------------- */
  /* Thème                                                           */
  /* -------------------------------------------------------------- */

  function applyTheme() {
    var root = document.documentElement.style;
    var accent = prop('accentColor', null);
    var bg = prop('backgroundColor', null);
    var text = prop('textColor', null);
    if (accent) root.setProperty('--accent', accent); else root.removeProperty('--accent');
    if (bg) root.setProperty('--bg', bg); else root.removeProperty('--bg');
    if (text) root.setProperty('--text-primary', text); else root.removeProperty('--text-primary');
  }

  /* -------------------------------------------------------------- */
  /* Divers                                                          */
  /* -------------------------------------------------------------- */

  var toastTimer = null;
  function toast(message, isError) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, isError ? 4000 : 2000);
  }

  /** Ouvre un lien dans le navigateur du PC (plugin Link Provider d'iCUE). */
  function openLink(url) {
    if (window.plugins && window.plugins.Linkprovider && globalValue('pluginLinkprovider_initialized')) {
      window.plugins.Linkprovider.open(url);
      return true;
    }
    if (!inIcue) {
      window.open(url, '_blank');
      return true;
    }
    return false;
  }

  window.Edge = {
    inIcue: inIcue,
    globalValue: globalValue,
    prop: prop,
    boolProp: boolProp,
    numProp: numProp,
    start: start,
    t: t,
    lang: lang,
    agent: agent,
    fmt: { isNum: isNum, num: num, bytes: bytes, duration: duration, locale: locale },
    applyTheme: applyTheme,
    toast: toast,
    openLink: openLink,
  };
})();
