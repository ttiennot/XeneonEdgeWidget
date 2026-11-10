'use strict';

/**
 * Mode prévisualisation : quand l'interface est ouverte dans un navigateur classique
 * (npm run preview), window.edge n'existe pas. On simule alors la configuration et
 * des statistiques réalistes pour pouvoir travailler sur le design sans Windows.
 */
(() => {
  if (window.edge) return;

  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) o[k] = strip(x);
      return o;
    }
    return v;
  };

  const listeners = { stats: [] };
  const N = 90;
  const walk = (v, min, max, step) => Math.min(max, Math.max(min, v + (Math.random() - 0.5) * step));
  let cpu = 28;
  let gpu = 62;
  let cpuT = 58;
  let gpuT = 66;
  const history = { cpu: [], gpu: [], cpuTemp: [], gpuTemp: [], rx: [], tx: [] };
  const cores = Array.from({ length: 16 }, () => Math.random() * 40);

  function step() {
    cpu = walk(cpu, 4, 96, 14);
    gpu = walk(gpu, 10, 99, 16);
    cpuT = walk(cpuT, 40, 90, 3);
    gpuT = walk(gpuT, 40, 88, 2.5);
    cores.forEach((c, i) => (cores[i] = walk(c, 0, 100, 30)));
    const push = (k, v) => {
      history[k].push(Math.round(v * 10) / 10);
      if (history[k].length > N) history[k].shift();
    };
    const rx = Math.random() * 6e6;
    const tx = Math.random() * 8e5;
    push('cpu', cpu);
    push('gpu', gpu);
    push('cpuTemp', cpuT);
    push('gpuTemp', gpuT);
    push('rx', rx);
    push('tx', tx);
    return {
      time: Date.now(),
      host: 'PC-GAMING',
      uptime: 3 * 3600 + 1240 + performance.now() / 1000,
      cpu: { name: 'AMD Ryzen 7 7800X3D', load: cpu, temp: cpuT, power: 40 + cpu * 0.8, clock: 4650 + Math.random() * 300, cores: cores.map(Math.round) },
      gpu: { name: 'NVIDIA GeForce RTX 4080 SUPER', load: gpu, temp: gpuT, power: 60 + gpu * 2.4, fan: 38 + gpu / 4, memUsed: 6800 + gpu * 20, memTotal: 16376 },
      mem: { used: 18.4 * 1024 ** 3 + Math.random() * 2e8, total: 32 * 1024 ** 3 },
      disks: [
        { name: 'C:', used: 612e9, size: 1000e9 },
        { name: 'D:', used: 1650e9, size: 2000e9 },
        { name: 'E:', used: 3800e9, size: 4000e9 },
      ],
      net: { rx, tx },
      sources: { lhm: true, nvidia: false },
      history,
    };
  }

  for (let i = 0; i < N - 1; i++) step();
  let last = step();

  setInterval(() => {
    last = step();
    listeners.stats.forEach((cb) => cb(last));
  }, 1000);

  let sonarIndex = 0;
  const sonarState = (action) => {
    const t = action.toggle[sonarIndex];
    return typeof t === 'string' ? { label: t, deviceName: t } : { label: t.label || t.match, icon: t.icon, deviceName: t.match };
  };

  window.edge = {
    isElectron: false,
    getConfig: async () => strip(await (await fetch('/config.example.json')).json()),
    getLastStats: async () => last,
    runAction: async (action) => {
      console.log('[preview] action', action);
      if (action.type === 'sonar' && action.toggle) {
        sonarIndex = (sonarIndex + 1) % action.toggle.length;
        return { ok: true, result: sonarState(action) };
      }
      return { ok: true };
    },
    getActionState: async (action) => ({ ok: true, state: action.type === 'sonar' ? sonarState(action) : null }),
    getAppIcon: async () => null,
    openConfig: async () => {},
    onStats: (cb) => listeners.stats.push(cb),
    onConfig: () => {},
    onToast: () => {},
  };
})();
