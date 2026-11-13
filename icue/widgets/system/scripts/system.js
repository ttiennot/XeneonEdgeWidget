'use strict';

/* Widget iCUE « Edge System » : capteurs iCUE + statistiques de l'agent local. */
(function () {
  var Edge = window.Edge;
  var Sensors = window.IcueSensors;
  var fmt = Edge.fmt;
  var isNum = fmt.isNum;
  var N = 90;
  var RING_LEN = 2 * Math.PI * 52;
  var SENSOR_PROPS = { cpuTemp: 'cpuTempSensor', cpuLoad: 'cpuLoadSensor', gpuTemp: 'gpuTempSensor', gpuLoad: 'gpuLoadSensor' };

  var state = {
    icue: {}, // cpuTemp: { id, value, units }
    names: {}, // cpu / gpu : nom du matériel selon iCUE
    agent: null,
    agentOnline: false,
    history: { cpu: [], gpu: [] },
    hoverX: null,
  };

  function source() {
    return Edge.prop('dataSource', 'auto');
  }

  /* -------------------------------------------------------------- */
  /* Capteurs iCUE                                                   */
  /* -------------------------------------------------------------- */

  function sensorId(key) {
    return String(Edge.prop(SENSOR_PROPS[key], '') || '');
  }

  function refreshSensors() {
    if (!Sensors.available() || source() === 'agent') return;
    Object.keys(SENSOR_PROPS).forEach(function (key) {
      var id = sensorId(key);
      if (!id) {
        delete state.icue[key];
        return;
      }
      Promise.all([Sensors.value(id), Sensors.units(id)])
        .then(function (r) {
          state.icue[key] = { id: id, value: parseFloat(r[0]), units: String(r[1] || '') };
        })
        .catch(function () {
          delete state.icue[key];
        });
    });
    ['cpu', 'gpu'].forEach(function (hw) {
      var id = sensorId(hw + 'Temp') || sensorId(hw + 'Load');
      if (!id) return;
      Sensors.deviceName(id)
        .then(function (name) { if (name) state.names[hw] = String(name); })
        .catch(function () {});
    });
  }

  Sensors.onValue(function (id, value) {
    Object.keys(SENSOR_PROPS).forEach(function (key) {
      if (state.icue[key] && state.icue[key].id === id) state.icue[key].value = parseFloat(value);
    });
  });

  function icueValue(key) {
    if (source() === 'agent') return null;
    var s = state.icue[key];
    return s && isNum(s.value) ? s : null;
  }

  /* -------------------------------------------------------------- */
  /* Fusion des sources                                              */
  /* -------------------------------------------------------------- */

  function toCelsius(s) {
    return /F/.test(s.units) ? ((s.value - 32) * 5) / 9 : s.value;
  }

  function compose() {
    var a = (source() !== 'icue' && state.agent) || {};
    var cpu = Object.assign({}, a.cpu || {});
    var gpu = a.gpu ? Object.assign({}, a.gpu) : null;
    var unit = '°C';

    var ct = icueValue('cpuTemp');
    if (ct) {
      cpu.temp = ct.value;
      cpu.tempC = toCelsius(ct);
      if (/F/.test(ct.units)) unit = '°F';
    } else cpu.tempC = cpu.temp;
    var cl = icueValue('cpuLoad');
    if (cl) cpu.load = cl.value;
    if (state.names.cpu && source() !== 'agent') cpu.name = state.names.cpu;

    var gt = icueValue('gpuTemp');
    var gl = icueValue('gpuLoad');
    if (gt || gl || state.names.gpu) gpu = gpu || {};
    if (gpu) {
      if (gt) {
        gpu.temp = gt.value;
        gpu.tempC = toCelsius(gt);
      } else gpu.tempC = gpu.temp;
      if (gl) gpu.load = gl.value;
      if (state.names.gpu && source() !== 'agent') gpu.name = state.names.gpu;
    }
    return { cpu: cpu, gpu: gpu, unit: unit, agent: a };
  }

  /* -------------------------------------------------------------- */
  /* Rendu                                                           */
  /* -------------------------------------------------------------- */

  function setText(root, sel, value) {
    var el = root.querySelector(sel);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function tempLevel(c) {
    if (!isNum(c)) return { level: '', label: Edge.t('na') };
    if (c >= Edge.numProp('tempCritical', 85)) return { level: 'critical', label: Edge.t('critical') };
    if (c >= Edge.numProp('tempWarning', 70)) return { level: 'warning', label: Edge.t('hot') };
    return { level: 'good', label: Edge.t('normal') };
  }

  function renderCard(id, hw, unit, extra) {
    var card = document.getElementById(id);
    card.classList.toggle('missing', !hw);
    hw = hw || {};
    setText(card, '[data-f="name"]', hw.name || Edge.t('notDetected'));
    setText(card, '[data-f="load"]', isNum(hw.load) ? fmt.num(hw.load) + '%' : '-');
    var ring = card.querySelector('.ring-value');
    ring.style.strokeDashoffset = String(RING_LEN * (1 - Math.min(100, Math.max(0, hw.load || 0)) / 100));
    ring.style.opacity = isNum(hw.load) && hw.load >= 0.5 ? '1' : '0';
    setText(card, '[data-f="temp"]', isNum(hw.temp) ? fmt.num(hw.temp) + unit : '-');
    var lv = tempLevel(hw.tempC);
    var status = card.querySelector('[data-f="status"]');
    status.setAttribute('data-level', lv.level);
    setText(status, 'b', lv.label);
    setText(card, '[data-f="power"]', isNum(hw.power) ? fmt.num(hw.power) + ' W' : '-');
    extra(card, hw);
  }

  function render() {
    var d = compose();
    renderCard('card-cpu', d.cpu, d.unit, function (card, cpu) {
      setText(card, '[data-f="clock"]', isNum(cpu.clock) ? fmt.num(cpu.clock / 1000, 1) + ' GHz' : '-');
    });
    renderCard('card-gpu', d.gpu, d.unit, function (card, gpu) {
      var ok = isNum(gpu.memUsed) && isNum(gpu.memTotal) && gpu.memTotal > 0;
      setText(card, '[data-f="vram"]', ok ? fmt.bytes(gpu.memUsed * 1048576) + ' / ' + fmt.bytes(gpu.memTotal * 1048576, 0) : '-');
    });

    var a = d.agent;
    setText(document, '#host-name', a.host || '');
    setText(document, '#host-uptime', isNum(a.uptime) ? Edge.t('uptime', { d: fmt.duration(a.uptime) }) : '');
    var sources = [];
    if (Object.keys(state.icue).length && source() !== 'agent') sources.push('iCUE');
    if (state.agentOnline && source() !== 'icue') sources.push(a.sources && a.sources.lhm ? 'LibreHardwareMonitor' : 'Agent');
    setText(document, '#sources', sources.join(' · '));

    if (a.mem) {
      setText(document, '#mem', fmt.bytes(a.mem.used) + ' / ' + fmt.bytes(a.mem.total, 0));
      document.getElementById('mem-bar').style.width = (a.mem.used / a.mem.total) * 100 + '%';
    } else setText(document, '#mem', '-');
    renderDisks(a.disks || []);
    setText(document, '#net-rx', a.net ? fmt.bytes(a.net.rx) + '/s' : '-');
    setText(document, '#net-tx', a.net ? fmt.bytes(a.net.tx) + '/s' : '-');
    document.getElementById('details').classList.toggle('no-agent', !state.agentOnline || source() === 'icue');
    drawChart();
  }

  function renderDisks(disks) {
    var box = document.getElementById('disks');
    if (box.children.length !== disks.length) {
      box.textContent = '';
      disks.forEach(function () {
        var row = document.createElement('div');
        row.className = 'disk';
        row.innerHTML = '<span class="disk-name"></span><div class="bar"><div class="bar-fill"></div></div><span class="disk-free"></span>';
        box.appendChild(row);
      });
    }
    disks.forEach(function (disk, i) {
      var row = box.children[i];
      var ratio = disk.size ? disk.used / disk.size : 0;
      row.querySelector('.disk-name').textContent = disk.name;
      var fill = row.querySelector('.bar-fill');
      fill.style.width = ratio * 100 + '%';
      fill.setAttribute('data-level', ratio > 0.95 ? 'critical' : ratio > 0.85 ? 'warning' : '');
      row.querySelector('.disk-free').textContent = fmt.bytes(disk.size - disk.used, 0);
    });
  }

  /* -------------------------------------------------------------- */
  /* Historique                                                      */
  /* -------------------------------------------------------------- */

  function pushHistory() {
    var d = compose();
    [['cpu', d.cpu], ['gpu', d.gpu]].forEach(function (p) {
      var arr = state.history[p[0]];
      arr.push(p[1] && isNum(p[1].load) ? p[1].load : null);
      if (arr.length > N) arr.shift();
    });
  }

  function drawChart() {
    var canvas = document.getElementById('chart');
    var wrap = canvas.parentElement;
    var W = wrap.clientWidth;
    var H = wrap.clientHeight;
    if (!W || !H || !Edge.boolProp('showChart', true)) return;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var css = getComputedStyle(document.documentElement);
    var fontSize = Math.max(9, Math.min(12, H / 9));
    var axisW = fontSize * 3.6;
    var plot = { x: axisW, y: fontSize / 2 + 2, w: W - axisW - 2, h: H - fontSize - 4 };

    ctx.font = fontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = css.getPropertyValue('--text-muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 50, 100].forEach(function (v) {
      var y = Math.round(plot.y + plot.h * (1 - v / 100)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.fillText(v + ' %', axisW - 6, y);
    });

    [['cpu', '--series-cpu'], ['gpu', '--series-gpu']].forEach(function (s) {
      var data = state.history[s[0]];
      var color = css.getPropertyValue(s[1]).trim();
      var started = false;
      var firstX = 0;
      var lastX = 0;
      ctx.beginPath();
      data.forEach(function (v, i) {
        if (!isNum(v)) return;
        var x = plot.x + plot.w * ((N - data.length + i) / (N - 1));
        var y = plot.y + plot.h * (1 - Math.min(100, v) / 100);
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
  }

  /* -------------------------------------------------------------- */
  /* Boucles                                                         */
  /* -------------------------------------------------------------- */

  function pollAgent() {
    if (source() === 'icue') {
      state.agentOnline = false;
      return Promise.resolve();
    }
    return Edge.agent
      .stats()
      .then(function (s) {
        state.agent = s && s.cpu ? s : null;
        state.agentOnline = !!state.agent;
      })
      .catch(function () {
        state.agent = null;
        state.agentOnline = false;
      });
  }

  function tick() {
    pollAgent().then(function () {
      pushHistory();
      render();
    });
  }

  function tickClock() {
    var now = new Date();
    setText(document, '#clock-time', now.toLocaleTimeString(fmt.locale(), { hour: '2-digit', minute: '2-digit' }));
    var date = now.toLocaleDateString(fmt.locale(), { weekday: 'long', day: 'numeric', month: 'long' });
    setText(document, '#clock-date', date.charAt(0).toUpperCase() + date.slice(1));
  }

  function applyVisibility() {
    document.getElementById('top').style.display = Edge.boolProp('showClock', true) ? '' : 'none';
    document.getElementById('history').style.display = Edge.boolProp('showChart', true) ? '' : 'none';
    document.getElementById('details').style.display = Edge.boolProp('showDetails', true) ? '' : 'none';
  }

  Edge.start({
    init: function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-t]'), function (el) {
        el.textContent = Edge.t(el.getAttribute('data-t'));
      });
      Sensors.whenReady(refreshSensors);
      tickClock();
      setInterval(tickClock, 1000);
      tick();
      setInterval(tick, 1000);
      // Rafraîchit aussi les capteurs iCUE périodiquement (si le signal de changement est rare).
      setInterval(refreshSensors, 3000);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(drawChart).observe(document.getElementById('chart').parentElement);
    },
    update: function () {
      Edge.applyTheme();
      applyVisibility();
      refreshSensors();
      render();
    },
  });
})();
