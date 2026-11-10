'use strict';

(() => {
  const api = window.edge;
  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    config: null,
    page: 0,
    iconCache: new Map(),
    statefulKeys: [],
    stats: null,
    webview: null,
    discordUrl: null,
  };

  /* ---------------------------------------------------------------- */
  /* Formatage                                                         */
  /* ---------------------------------------------------------------- */

  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function bytes(v, digits = 1) {
    if (!isNum(v)) return '—';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let i = 0;
    while (Math.abs(v) >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const f = i === 0 || v >= 100 ? nf0 : new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
    return `${f.format(v)} ${units[i]}`;
  }

  const rate = (v) => (isNum(v) ? `${bytes(v)}/s` : '—');
  const pct = (v) => (isNum(v) ? `${nf0.format(v)} %` : '—');

  function duration(sec) {
    if (!isNum(sec)) return '';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `Allumé depuis ${d ? `${d} j ` : ''}${h} h ${String(m).padStart(2, '0')}`;
  }

  /* ---------------------------------------------------------------- */
  /* Toast                                                             */
  /* ---------------------------------------------------------------- */

  let toastTimer = null;
  function toast(message, type = 'info') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = 'toast'), type === 'error' ? 5000 : 2200);
  }

  /* ---------------------------------------------------------------- */
  /* Disposition                                                       */
  /* ---------------------------------------------------------------- */

  function applyLayout() {
    const { layout, theme } = state.config;
    const app = $('#app');
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    const tracks = [];
    document.querySelectorAll('.panel').forEach((p) => {
      const idx = layout.panels.indexOf(p.dataset.panel);
      p.hidden = idx === -1;
      p.style.order = String(idx);
    });
    layout.panels.forEach((_, i) => {
      const w = Number(layout.widths && layout.widths[i]) || 1;
      tracks.push(`minmax(0, ${w}fr)`);
    });
    app.style.gridTemplateColumns = portrait ? '' : tracks.join(' ');
    app.style.gridTemplateRows = portrait ? tracks.join(' ') : '';
    if (theme && theme.accent) document.documentElement.style.setProperty('--accent', theme.accent);
  }

  /* ---------------------------------------------------------------- */
  /* Stream Deck                                                       */
  /* ---------------------------------------------------------------- */

  const looksLikeImage = (s) => typeof s === 'string' && /(^data:image\/)|(^https?:\/\/)|(^file:)|(\.(png|jpe?g|gif|svg|webp|ico)$)/i.test(s);

  function toImageSrc(icon) {
    if (/^(data:|https?:|file:)/i.test(icon)) return icon;
    // Chemin Windows ou relatif -> URL file://
    const normalized = icon.replace(/\\/g, '/');
    if (/^[a-z]:\//i.test(normalized)) return `file:///${encodeURI(normalized)}`;
    if (normalized.startsWith('/')) return `file://${encodeURI(normalized)}`;
    return normalized;
  }

  async function renderIcon(container, button) {
    container.textContent = '';
    if (button.icon && looksLikeImage(button.icon)) {
      const img = new Image();
      img.alt = '';
      img.src = toImageSrc(button.icon);
      container.appendChild(img);
      return;
    }
    if (button.icon) {
      container.textContent = button.icon;
      return;
    }
    // Pas d'icône : on récupère celle du programme lancé.
    const action = button.action || {};
    if (action.type === 'app' && action.path && api.getAppIcon) {
      let dataUrl = state.iconCache.get(action.path);
      if (dataUrl === undefined) {
        dataUrl = await api.getAppIcon(action.path);
        state.iconCache.set(action.path, dataUrl);
      }
      if (dataUrl) {
        const img = new Image();
        img.alt = '';
        img.src = dataUrl;
        container.appendChild(img);
        return;
      }
    }
    container.textContent = { url: '🌐', browser: '🧭', folder: '📁', file: '📄', command: '⌨️', hotkey: '⌨️', media: '🎵', text: '💬', page: '📑', discord: '💬', multi: '⚡' }[action.type] || '⬛';
  }

  function renderDeck() {
    const { deck } = state.config;
    const pages = deck.pages;
    if (state.page >= pages.length) state.page = 0;
    const page = pages[state.page];

    $('#deck-title').textContent = page.name || 'Stream Deck';
    const nav = $('#deck-pages');
    nav.textContent = '';
    if (pages.length > 1) {
      pages.forEach((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = p.name || `Page ${i + 1}`;
        b.setAttribute('aria-current', String(i === state.page));
        b.addEventListener('click', () => goToPage(i));
        nav.appendChild(b);
      });
    }

    const grid = $('#deck-grid');
    grid.textContent = '';
    state.statefulKeys = [];
    grid.style.gridTemplateColumns = `repeat(${deck.columns}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${deck.rows}, minmax(0, 1fr))`;

    const total = deck.columns * deck.rows;
    for (let i = 0; i < total; i++) {
      const button = (page.buttons || [])[i] || {};
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'key';
      if (!button.action && !button.label && !button.icon) {
        el.classList.add('empty');
        el.disabled = true;
        el.setAttribute('aria-hidden', 'true');
        grid.appendChild(el);
        continue;
      }
      if (button.color) el.style.setProperty('--key-color', button.color);
      const icon = document.createElement('span');
      icon.className = 'key-icon';
      const label = document.createElement('span');
      label.className = 'key-label';
      label.textContent = button.label || '';
      el.append(icon, label);
      el.title = button.label || '';
      renderIcon(icon, button);
      if (hasState(button.action)) {
        const sub = document.createElement('span');
        sub.className = 'key-sub';
        sub.textContent = button.label || '';
        label.textContent = '…';
        el.appendChild(sub);
        state.statefulKeys.push({ el, button });
      }
      el.addEventListener('click', () => press(el, button.action, button));
      grid.appendChild(el);
    }
    refreshKeyStates();
  }

  /* Boutons à état (ex. sortie audio Sonar) : affichent la valeur courante. */

  const hasState = (action) => !!(action && action.type === 'sonar' && api.getActionState);

  function applyKeyState(el, button, st) {
    const label = el.querySelector('.key-label');
    const icon = el.querySelector('.key-icon');
    if (st && (st.label || st.deviceName)) {
      label.textContent = st.label || st.deviceName;
      el.title = st.deviceName ? `${button.label || ''} : ${st.deviceName}` : button.label || '';
      renderIcon(icon, { ...button, icon: st.icon || button.icon });
      el.classList.remove('stale');
    } else {
      label.textContent = '?';
      el.classList.add('stale');
    }
  }

  async function refreshKeyStates() {
    for (const { el, button } of state.statefulKeys) {
      if (!el.isConnected) continue;
      try {
        const res = await api.getActionState(button.action);
        applyKeyState(el, button, res && res.ok ? res.state : null);
        if (res && !res.ok) el.title = res.error;
      } catch (_) {
        applyKeyState(el, button, null);
      }
    }
  }

  function goToPage(i) {
    state.page = i;
    renderDeck();
  }

  function flash(el, cls) {
    el.classList.remove('ok', 'error');
    void el.offsetWidth; // relance l'animation
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), cls === 'error' ? 900 : 450);
  }

  /** Actions gérées localement (navigation entre pages, Discord). */
  function runLocal(action) {
    if (action.type === 'page') {
      const target = typeof action.page === 'number' ? action.page : state.config.deck.pages.findIndex((p) => p.name === action.page);
      if (target >= 0 && target < state.config.deck.pages.length) goToPage(target);
      return true;
    }
    if (action.type === 'discord') {
      if (action.url) navigateDiscord(action.url);
      return true;
    }
    return false;
  }

  async function press(el, action, button = {}) {
    if (!action) return;
    try {
      if (runLocal(action)) return;
      if (action.type === 'multi') (action.actions || []).forEach((a) => runLocal(a));
      const res = await api.runAction(action);
      if (res && res.ok) {
        flash(el, 'ok');
        if (res.result && hasState(action)) {
          applyKeyState(el, button, res.result);
          toast(`Sortie audio : ${res.result.label || res.result.deviceName}`);
        }
      }
      else {
        flash(el, 'error');
        toast(res && res.error ? res.error : 'Échec de l’action', 'error');
      }
    } catch (err) {
      flash(el, 'error');
      toast(err.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Statistiques                                                      */
  /* ---------------------------------------------------------------- */

  const RING_LEN = 2 * Math.PI * 52;

  function tempLevel(t) {
    const { tempWarning, tempCritical } = state.config.stats;
    if (!isNum(t)) return { level: '', label: 'N/D' };
    if (t >= tempCritical) return { level: 'critical', label: 'Critique' };
    if (t >= tempWarning) return { level: 'warning', label: 'Chaud' };
    return { level: 'good', label: 'Normal' };
  }

  function setField(card, name, value) {
    const el = card.querySelector(`[data-f="${name}"]`);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function updateHwCard(card, hw, extra) {
    card.style.opacity = hw ? '1' : '0.45';
    hw = hw || {};
    setField(card, 'name', hw.name || 'Non détecté');
    setField(card, 'load', isNum(hw.load) ? nf0.format(hw.load) + '%' : '—');
    const ring = card.querySelector('.ring-value');
    ring.style.strokeDashoffset = String(RING_LEN * (1 - Math.min(100, Math.max(0, hw.load || 0)) / 100));
    // Avec stroke-linecap: round, un arc de longueur nulle dessine quand même un point.
    ring.style.opacity = isNum(hw.load) && hw.load >= 0.5 ? '1' : '0';
    setField(card, 'temp', isNum(hw.temp) ? `${nf0.format(hw.temp)}°C` : '—');
    const { level, label } = tempLevel(hw.temp);
    const status = card.querySelector('[data-f="status"]');
    status.dataset.level = level;
    status.querySelector('b').textContent = label;
    setField(card, 'power', isNum(hw.power) ? `${nf0.format(hw.power)} W` : '—');
    extra(hw);
  }

  function updateStats(s) {
    state.stats = s;
    $('#host-name').textContent = s.host || '';
    $('#host-uptime').textContent = duration(s.uptime);
    const sources = $('#sources');
    sources.innerHTML = '';
    [
      ['LibreHardwareMonitor', s.sources && s.sources.lhm],
      ['nvidia-smi', s.sources && s.sources.nvidia],
    ].forEach(([name, on]) => {
      if (!on) return;
      const span = document.createElement('span');
      span.className = 'on';
      span.textContent = name;
      sources.appendChild(span);
    });

    const cpuCard = $('#card-cpu');
    updateHwCard(cpuCard, s.cpu, (cpu) => {
      setField(cpuCard, 'clock', isNum(cpu.clock) ? `${nf1.format(cpu.clock / 1000)} GHz` : '—');
      const cores = cpuCard.querySelector('[data-f="cores"]');
      const loads = (cpu.cores || []).slice(0, 64);
      if (cores.children.length !== loads.length) {
        cores.textContent = '';
        loads.forEach(() => cores.appendChild(document.createElement('span')));
      }
      loads.forEach((l, i) => (cores.children[i].style.height = `${Math.max(4, l)}%`));
    });

    const gpuCard = $('#card-gpu');
    updateHwCard(gpuCard, s.gpu, (gpu) => {
      setField(gpuCard, 'fan', isNum(gpu.fan) ? (gpu.fan > 100 ? `${nf0.format(gpu.fan)} tr/min` : `${nf0.format(gpu.fan)} %`) : '—');
      const hasVram = isNum(gpu.memUsed) && isNum(gpu.memTotal) && gpu.memTotal > 0;
      setField(gpuCard, 'vram', hasVram ? `${bytes(gpu.memUsed * 1048576)} / ${bytes(gpu.memTotal * 1048576, 0)}` : '—');
      gpuCard.querySelector('[data-f="vram-bar"]').style.width = hasVram ? `${(gpu.memUsed / gpu.memTotal) * 100}%` : '0';
    });

    if (s.mem) {
      const ratio = s.mem.used / s.mem.total;
      document.querySelector('[data-f="mem"]').textContent = `${bytes(s.mem.used)} / ${bytes(s.mem.total, 0)}`;
      $('#mem-bar').style.width = `${ratio * 100}%`;
      $('#mem-sub').textContent = `${pct(ratio * 100)} utilisée`;
    }

    renderDisks(s.disks || []);
    $('#net-rx').textContent = rate(s.net && s.net.rx);
    $('#net-tx').textContent = rate(s.net && s.net.tx);
    drawHistory();
  }

  function renderDisks(disks) {
    const box = $('#disks');
    if (box.children.length !== disks.length) {
      box.textContent = '';
      disks.forEach(() => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = '<span class="bar-label"></span><div class="bar"><div class="bar-fill disk-fill"></div></div><span class="bar-value"></span>';
        box.appendChild(row);
      });
    }
    disks.forEach((d, i) => {
      const row = box.children[i];
      const ratio = d.size ? d.used / d.size : 0;
      row.querySelector('.bar-label').textContent = d.name;
      const fill = row.querySelector('.bar-fill');
      fill.style.width = `${ratio * 100}%`;
      fill.dataset.level = ratio > 0.95 ? 'critical' : ratio > 0.85 ? 'warning' : '';
      row.querySelector('.bar-value').textContent = `${bytes(d.size - d.used, 0)} libres`;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Graphique d'historique (canvas)                                   */
  /* ---------------------------------------------------------------- */

  const chart = { hoverX: null };

  function drawHistory() {
    const canvas = $('#history-chart');
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const css = getComputedStyle(document.documentElement);
    const axisW = 48;
    const plot = { x: axisW, y: 10, w: W - axisW - 4, h: H - 18 };

    // Grille discrète 0 / 50 / 100 %
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = css.getPropertyValue('--text-muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 50, 100].forEach((v) => {
      const y = plot.y + plot.h * (1 - v / 100);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, Math.round(y) + 0.5);
      ctx.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(`${v} %`, axisW - 8, y);
    });

    const hist = (state.stats && state.stats.history) || {};
    const N = 90;
    const xAt = (i, len) => plot.x + plot.w * ((N - len + i) / (N - 1));
    const series = [
      { key: 'cpu', color: css.getPropertyValue('--series-cpu').trim() },
      { key: 'gpu', color: css.getPropertyValue('--series-gpu').trim() },
    ];

    series.forEach(({ key, color }) => {
      const data = hist[key] || [];
      // Aire légère sous la courbe
      ctx.beginPath();
      let started = false;
      let firstX = 0;
      let lastX = 0;
      data.forEach((v, i) => {
        if (!isNum(v)) return;
        const x = xAt(i, data.length);
        const y = plot.y + plot.h * (1 - Math.min(100, v) / 100);
        if (!started) {
          ctx.moveTo(x, y);
          firstX = x;
          started = true;
        } else ctx.lineTo(x, y);
        lastX = x;
      });
      if (!started) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.lineTo(lastX, plot.y + plot.h);
      ctx.lineTo(firstX, plot.y + plot.h);
      ctx.closePath();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    // Réticule + infobulle
    const tip = $('#chart-tip');
    if (chart.hoverX !== null && (hist.cpu || []).length) {
      const len = hist.cpu.length;
      const rel = (chart.hoverX - plot.x) / plot.w;
      let i = Math.round(rel * (N - 1)) - (N - len);
      i = Math.max(0, Math.min(len - 1, i));
      const x = xAt(i, len);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.y);
      ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.h);
      ctx.stroke();
      series.forEach(({ key, color }) => {
        const v = (hist[key] || [])[i];
        if (!isNum(v)) return;
        ctx.beginPath();
        ctx.arc(x, plot.y + plot.h * (1 - Math.min(100, v) / 100), 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = css.getPropertyValue('--panel').trim();
        ctx.stroke();
      });
      const ago = len - 1 - i;
      const fmt = (k) => (isNum((hist[k] || [])[i]) ? `${nf0.format(hist[k][i])} %` : '—');
      tip.innerHTML = `<div>${ago === 0 ? 'maintenant' : `il y a ${ago} s`}</div>` +
        `<div><i style="background:${series[0].color}"></i>CPU ${fmt('cpu')}</div>` +
        `<div><i style="background:${series[1].color}"></i>GPU ${fmt('gpu')}</div>`;
      tip.hidden = false;
      tip.style.left = `${Math.min(W - 70, Math.max(70, x))}px`;
    } else {
      tip.hidden = true;
    }
  }

  function bindChartHover() {
    const wrap = $('#history-chart').parentElement;
    const move = (e) => {
      const r = wrap.getBoundingClientRect();
      // getBoundingClientRect est en pixels zoomés : on ramène en pixels CSS.
      chart.hoverX = ((e.clientX - r.left) / r.width) * wrap.clientWidth;
      drawHistory();
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerdown', move);
    wrap.addEventListener('pointerleave', () => {
      chart.hoverX = null;
      drawHistory();
    });
    new ResizeObserver(() => drawHistory()).observe(wrap);
  }

  /* ---------------------------------------------------------------- */
  /* Horloge                                                           */
  /* ---------------------------------------------------------------- */

  function tickClock() {
    const now = new Date();
    $('#clock-time').textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('#clock-date').textContent = date.charAt(0).toUpperCase() + date.slice(1);
  }

  /* ---------------------------------------------------------------- */
  /* Discord                                                           */
  /* ---------------------------------------------------------------- */

  function setupDiscord() {
    const { discord } = state.config;
    const body = $('#discord-body');
    if (!api.isElectron) {
      body.innerHTML =
        '<div class="discord-placeholder"><strong>Discord</strong>' +
        '<div>Le client Discord s’affiche ici dans l’application Electron.</div>' +
        `<code>${discord.url.replace(/[<>&]/g, '')}</code></div>`;
      return;
    }
    if (state.webview && state.discordUrl === discord.url) {
      state.webview.setZoomFactor(Number(discord.zoom) || 1);
      return;
    }
    body.textContent = '';
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:discord');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', discord.url);
    wv.addEventListener('dom-ready', () => wv.setZoomFactor(Number(state.config.discord.zoom) || 1));
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) toast(`Discord : impossible de charger la page (${e.errorDescription})`, 'error');
    });
    body.appendChild(wv);
    state.webview = wv;
    state.discordUrl = discord.url;
  }

  function navigateDiscord(url) {
    if (state.webview) state.webview.loadURL(url);
  }

  function bindDiscordTools() {
    document.querySelectorAll('[data-dc]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const wv = state.webview;
        if (!wv) return;
        const cmd = btn.dataset.dc;
        if (cmd === 'back' && wv.canGoBack()) wv.goBack();
        if (cmd === 'home') wv.loadURL(state.config.discord.url);
        if (cmd === 'reload') wv.reload();
      })
    );
  }

  /* ---------------------------------------------------------------- */
  /* Initialisation                                                    */
  /* ---------------------------------------------------------------- */

  function applyConfig(config) {
    state.config = config;
    document.documentElement.style.setProperty('--accent', (config.theme && config.theme.accent) || '#3987e5');
    applyLayout();
    renderDeck();
    if (config.layout.panels.includes('discord')) setupDiscord();
    if (state.stats) updateStats(state.stats);
  }

  async function init() {
    applyConfig(await api.getConfig());
    bindDiscordTools();
    bindChartHover();
    tickClock();
    setInterval(tickClock, 1000);
    // La sortie peut aussi être changée depuis SteelSeries GG : on resynchronise régulièrement.
    setInterval(refreshKeyStates, 10000);
    api.onStats(updateStats);
    api.onConfig((c) => {
      applyConfig(c);
      toast('Configuration rechargée');
    });
    if (api.onToast) api.onToast((t) => toast(t.message, t.type));
    const last = await api.getLastStats();
    if (last) updateStats(last);
    window.matchMedia('(orientation: portrait)').addEventListener('change', applyLayout);
  }

  init().catch((err) => {
    console.error(err);
    toast(`Erreur au démarrage : ${err.message}`, 'error');
  });
})();
