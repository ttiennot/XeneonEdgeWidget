'use strict';

/**
 * Collecte des statistiques système.
 *
 * Sources (par ordre de priorité pour chaque valeur) :
 *  1. LibreHardwareMonitor (serveur web local, data.json) : températures, charges, puissances, VRAM.
 *  2. nvidia-smi : GPU NVIDIA (température, charge, VRAM, puissance, ventilateur).
 *  3. systeminformation : charge CPU, mémoire, disques, réseau, température CPU si disponible.
 */

const { execFile } = require('child_process');
const http = require('http');
const https = require('https');
const si = require('systeminformation');

const HISTORY_LENGTH = 90;

/* ------------------------------------------------------------------ */
/* LibreHardwareMonitor                                                */
/* ------------------------------------------------------------------ */

function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** "45,3 °C" / "12.4 %" / "3 456.0 MB" -> nombre (gère la virgule décimale des Windows FR). */
function parseNumber(text) {
  if (typeof text === 'number') return text;
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[\s  ]/g, '').replace(',', '.');
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function unitOf(text) {
  if (typeof text !== 'string') return '';
  const m = text.trim().match(/[^\d\s.,\-]+$/);
  return m ? m[0] : '';
}

const TYPE_BY_UNIT = { '°C': 'Temperature', '%': 'Load', W: 'Power', MHz: 'Clock', RPM: 'Fan', MB: 'Data', GB: 'Data', V: 'Voltage' };
const TYPE_BY_GROUP = {
  temperatures: 'Temperature',
  load: 'Load',
  powers: 'Power',
  clocks: 'Clock',
  fans: 'Fan',
  controls: 'Control',
  data: 'Data',
  smalldata: 'SmallData',
  voltages: 'Voltage',
  throughput: 'Throughput',
};

function hardwareKind(node) {
  const img = (node.ImageURL || '').toLowerCase();
  if (img.includes('cpu')) return 'cpu';
  if (img.includes('nvidia')) return 'gpu-nvidia';
  if (img.includes('ati') || img.includes('amd')) return 'gpu-amd';
  if (img.includes('intel')) return 'gpu-intel';
  if (img.includes('ram')) return 'memory';
  if (img.includes('hdd')) return 'storage';
  if (img.includes('mainboard')) return 'motherboard';
  if (img.includes('nic')) return 'network';
  return null;
}

function kindFromSensorId(id) {
  if (typeof id !== 'string') return null;
  if (/^\/(amd|intel)cpu\//.test(id)) return 'cpu';
  if (/^\/(gpu-nvidia|nvidiagpu)\//.test(id)) return 'gpu-nvidia';
  if (/^\/(gpu-amd|atigpu|amdgpu)\//.test(id)) return 'gpu-amd';
  if (/^\/(gpu-intel|intelgpu)\//.test(id)) return 'gpu-intel';
  return null;
}

/**
 * Aplatit l'arbre data.json de LibreHardwareMonitor en une liste de capteurs :
 * { hardware, kind, type, name, value, unit }.
 */
function flattenLhm(root) {
  const sensors = [];
  const walk = (node, ctx) => {
    if (!node || typeof node !== 'object') return;
    const children = Array.isArray(node.Children) ? node.Children : [];
    const kind = hardwareKind(node);
    let next = ctx;
    if (kind) next = { ...ctx, hardware: node.Text, kind };
    const groupType = TYPE_BY_GROUP[String(node.Text || '').toLowerCase()];
    if (groupType && children.length) next = { ...next, group: groupType };

    if (children.length === 0 && node.Value !== undefined && node.Value !== '') {
      const value = parseNumber(node.Value);
      if (value !== null) {
        const unit = unitOf(node.Value);
        sensors.push({
          hardware: next.hardware || null,
          kind: kindFromSensorId(node.SensorId) || next.kind || null,
          type: node.Type || next.group || TYPE_BY_UNIT[unit] || null,
          name: String(node.Text || ''),
          value,
          unit,
        });
      }
    }
    children.forEach((c) => walk(c, next));
  };
  walk(root, {});
  return sensors;
}

function pick(sensors, type, names) {
  const ofType = sensors.filter((s) => s.type === type);
  for (const name of names) {
    const re = name instanceof RegExp ? name : new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const found = ofType.find((s) => re.test(s.name));
    if (found) return found.value;
  }
  return null;
}

function toMB(sensor) {
  if (!sensor) return null;
  return /GB/i.test(sensor.unit) ? sensor.value * 1024 : sensor.value;
}

/** Extrait les métriques utiles (CPU / GPU) de la liste des capteurs LHM. */
function summarizeLhm(sensors) {
  const cpuSensors = sensors.filter((s) => s.kind === 'cpu');
  const gpuKinds = ['gpu-nvidia', 'gpu-amd', 'gpu-intel'];
  // GPU dédié en priorité sur l'iGPU Intel.
  const gpuKind = gpuKinds.find((k) => sensors.some((s) => s.kind === k));
  const gpuSensors = gpuKind ? sensors.filter((s) => s.kind === gpuKind) : [];
  const gpuName = gpuSensors[0]?.hardware || null;
  const firstGpu = gpuSensors.filter((s) => s.hardware === gpuName);

  const cpu = cpuSensors.length
    ? {
        name: cpuSensors[0].hardware,
        temp:
          pick(cpuSensors, 'Temperature', ['CPU Package', 'Core (Tctl/Tdie)', 'Tctl/Tdie', 'Tdie', 'Tctl', 'Core Average', 'CPU Cores']) ??
          maxOf(cpuSensors.filter((s) => s.type === 'Temperature').map((s) => s.value)),
        load: pick(cpuSensors, 'Load', ['CPU Total']),
        power: pick(cpuSensors, 'Power', ['CPU Package', 'Package', /^CPU Cores?$/]),
        clock: avgOf(cpuSensors.filter((s) => s.type === 'Clock' && /^(CPU )?Core #\d+$/i.test(s.name)).map((s) => s.value)),
      }
    : null;

  let gpu = null;
  if (firstGpu.length) {
    const memUsed = firstGpu.find((s) => /^GPU Memory Used$/i.test(s.name) && /B$/i.test(s.unit));
    const memTotal = firstGpu.find((s) => /^GPU Memory Total$/i.test(s.name) && /B$/i.test(s.unit));
    gpu = {
      name: gpuName,
      temp: pick(firstGpu, 'Temperature', ['GPU Core', 'GPU Temperature', /^GPU/]),
      hotspot: pick(firstGpu, 'Temperature', ['GPU Hot Spot', 'GPU Hotspot']),
      load: pick(firstGpu, 'Load', ['GPU Core', 'D3D 3D', /^GPU/]),
      power: pick(firstGpu, 'Power', ['GPU Package', 'GPU Power', 'GPU Core', /^GPU/]),
      clock: pick(firstGpu, 'Clock', ['GPU Core']),
      fan: pick(firstGpu, 'Fan', [/fan/i]),
      memUsed: toMB(memUsed),
      memTotal: toMB(memTotal),
    };
  }
  return { cpu, gpu };
}

function maxOf(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
}

function avgOf(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/* ------------------------------------------------------------------ */
/* nvidia-smi                                                          */
/* ------------------------------------------------------------------ */

const NVIDIA_FIELDS = ['name', 'temperature.gpu', 'utilization.gpu', 'memory.used', 'memory.total', 'power.draw', 'fan.speed', 'clocks.gr'];

function parseNvidiaSmi(stdout) {
  const line = String(stdout).split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const parts = line.split(',').map((p) => p.trim());
  const num = (i) => {
    const n = parseFloat(parts[i]);
    return Number.isFinite(n) ? n : null;
  };
  return {
    name: parts[0] || null,
    temp: num(1),
    load: num(2),
    memUsed: num(3),
    memTotal: num(4),
    power: num(5),
    fan: num(6),
    clock: num(7),
  };
}

function queryNvidiaSmi() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      [`--query-gpu=${NVIDIA_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => resolve(err ? null : parseNvidiaSmi(stdout))
    );
  });
}

/* ------------------------------------------------------------------ */
/* Collecteur                                                          */
/* ------------------------------------------------------------------ */

function mergeDefined(base, extra) {
  if (!extra) return base;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))) out[k] = v;
  }
  return out;
}

/**
 * Extrait les compteurs d'octets (reçus, envoyés) de la sortie de `netstat -e`.
 * La première ligne de données est celle des octets, quelle que soit la langue de Windows.
 */
function parseNetstatBytes(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = line.match(/\S\s+(\d+)\s+(\d+)\s*$/);
    if (m) return { rx: Number(m[1]), tx: Number(m[2]) };
  }
  return null;
}

/** Windows : total des octets reçus / envoyés par les cartes réseau (null si indisponible). */
function queryNetstat() {
  return new Promise((resolve) => {
    execFile('netstat', ['-e'], { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? null : parseNetstatBytes(stdout)));
  });
}

class StatsCollector {
  constructor(config, onStats) {
    this.config = config;
    this.onStats = onStats;
    this.timer = null;
    this.busy = false;
    this.tick = 0;
    this.cache = { static: null, disks: [], lhm: null, nvidia: null, siTemp: null, lhmFailures: 0, nvidiaAvailable: true };
    this.history = { cpu: [], gpu: [], cpuTemp: [], gpuTemp: [], rx: [], tx: [] };
  }

  setConfig(config) {
    this.config = config;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  async start() {
    if (process.platform === 'win32' && typeof si.powerShellStart === 'function') {
      // Garde une instance PowerShell persistante : beaucoup plus rapide pour les requêtes WMI.
      try {
        si.powerShellStart();
      } catch (_) {
        /* ignore */
      }
    }
    if (!this.cache.static) {
      try {
        const [cpu, os] = await Promise.all([si.cpu(), si.osInfo()]);
        this.cache.static = { cpuName: `${cpu.manufacturer} ${cpu.brand}`.trim(), cores: cpu.cores, host: os.hostname, os: `${os.distro}` };
      } catch (_) {
        this.cache.static = { cpuName: 'CPU', cores: null, host: '', os: '' };
      }
    }
    const loop = async () => {
      await this.collect();
      this.timer = setTimeout(loop, this.config.stats.intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    if (process.platform === 'win32' && typeof si.powerShellRelease === 'function') {
      try {
        si.powerShellRelease();
      } catch (_) {
        /* ignore */
      }
    }
  }

  async refreshSlow() {
    const cfg = this.config.stats;
    const every = (n) => this.tick % n === 0;
    const tasks = [];

    if (every(30)) {
      tasks.push(
        si
          .fsSize()
          .then((list) => {
            const wanted = (cfg.disks || []).map((d) => String(d).toLowerCase());
            const seen = new Set();
            this.cache.disks = list
              .filter((d) => d.size > 1e9)
              .filter((d) => !wanted.length || wanted.includes(String(d.mount).toLowerCase()) || wanted.includes(String(d.fs).toLowerCase()))
              .filter((d) => (seen.has(d.mount) ? false : seen.add(d.mount)))
              .slice(0, 6)
              .map((d) => ({ name: d.mount, used: d.used, size: d.size }));
          })
          .catch(() => {})
      );
    }

    const lhm = cfg.librehardwaremonitor;
    // En cas d'échec répété, on espace les tentatives (toutes les 15 s).
    if (lhm && lhm.enabled && (this.cache.lhmFailures < 3 || every(15))) {
      tasks.push(
        fetchJson(lhm.url)
          .then((json) => {
            this.cache.lhm = summarizeLhm(flattenLhm(json));
            this.cache.lhmFailures = 0;
          })
          .catch(() => {
            this.cache.lhm = null;
            this.cache.lhmFailures++;
          })
      );
    } else if (!lhm || !lhm.enabled) {
      this.cache.lhm = null;
    }

    const lhmHasGpu = this.cache.lhm && this.cache.lhm.gpu && this.cache.lhm.gpu.temp !== null;
    if (cfg.nvidiaSmi && !lhmHasGpu && (this.cache.nvidiaAvailable || every(60)) && every(2)) {
      tasks.push(
        queryNvidiaSmi().then((res) => {
          this.cache.nvidia = res;
          this.cache.nvidiaAvailable = !!res;
        })
      );
    }

    const lhmHasCpuTemp = this.cache.lhm && this.cache.lhm.cpu && this.cache.lhm.cpu.temp !== null;
    if (!lhmHasCpuTemp && every(5)) {
      tasks.push(
        si
          .cpuTemperature()
          .then((t) => {
            this.cache.siTemp = Number.isFinite(t.main) && t.main > 0 ? t.main : maxOf(t.cores || []) || null;
          })
          .catch(() => {})
      );
    }
    await Promise.all(tasks);
  }

  /** Débit réseau (octets/s) calculé entre deux lectures des compteurs Windows. */
  async windowsNetRate() {
    const now = Date.now();
    const totals = await queryNetstat();
    const prev = this.netPrev;
    this.netPrev = totals ? { ...totals, time: now } : null;
    if (!totals || !prev) return { rx: 0, tx: 0 };
    const seconds = (now - prev.time) / 1000;
    // Compteur remis à zéro (carte désactivée, dépassement) : on ignore cet intervalle.
    if (seconds <= 0 || totals.rx < prev.rx || totals.tx < prev.tx) return { rx: 0, tx: 0 };
    return { rx: (totals.rx - prev.rx) / seconds, tx: (totals.tx - prev.tx) / seconds };
  }

  async collect() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.refreshSlow();
      const [load, mem, net, time] = await Promise.all([
        si.currentLoad().catch(() => null),
        si.mem().catch(() => null),
        // Sous Windows, systeminformation renvoie des débits nuls sur certaines machines
        // (noms de cartes localisés) : on lit directement les compteurs du système.
        process.platform === 'win32' ? Promise.resolve([]) : si.networkStats('*').catch(() => []),
        Promise.resolve(si.time()),
      ]);
      const netRate = process.platform === 'win32' ? await this.windowsNetRate() : null;

      const lhm = this.cache.lhm || {};
      let cpu = {
        name: this.cache.static.cpuName,
        load: load ? load.currentLoad : null,
        cores: load ? load.cpus.map((c) => Math.round(c.load)) : [],
        temp: this.cache.siTemp,
        power: null,
        clock: null,
      };
      cpu = mergeDefined(cpu, lhm.cpu ? { ...lhm.cpu, name: undefined } : null);
      if (lhm.cpu && lhm.cpu.name) cpu.name = lhm.cpu.name;

      let gpu = null;
      if (lhm.gpu) gpu = mergeDefined(null, lhm.gpu);
      if (this.cache.nvidia) gpu = mergeDefined(this.cache.nvidia, gpu);

      const ifaces = Array.isArray(net) ? net : [];
      const rx = netRate ? netRate.rx : ifaces.reduce((a, n) => a + (n.rx_sec > 0 ? n.rx_sec : 0), 0);
      const tx = netRate ? netRate.tx : ifaces.reduce((a, n) => a + (n.tx_sec > 0 ? n.tx_sec : 0), 0);

      const stats = {
        time: Date.now(),
        host: this.cache.static.host,
        uptime: time.uptime,
        cpu,
        gpu,
        mem: mem ? { used: mem.active, total: mem.total } : null,
        disks: this.cache.disks,
        net: { rx, tx },
        sources: { lhm: !!this.cache.lhm, nvidia: !!this.cache.nvidia },
      };
      this.pushHistory(stats);
      stats.history = this.history;
      this.tick++;
      this.onStats(stats);
    } catch (err) {
      console.error('[stats]', err);
    } finally {
      this.busy = false;
    }
  }

  pushHistory(s) {
    const push = (key, v) => {
      const arr = this.history[key];
      arr.push(Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      if (arr.length > HISTORY_LENGTH) arr.shift();
    };
    push('cpu', s.cpu.load);
    push('gpu', s.gpu ? s.gpu.load : null);
    push('cpuTemp', s.cpu.temp);
    push('gpuTemp', s.gpu ? s.gpu.temp : null);
    push('rx', s.net.rx);
    push('tx', s.net.tx);
  }
}

module.exports = { StatsCollector, flattenLhm, summarizeLhm, parseNvidiaSmi, parseNetstatBytes, parseNumber, HISTORY_LENGTH };
