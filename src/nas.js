'use strict';

/**
 * Bouton « NAS » : affiche l'état d'un NAS (ou d'un PC) et l'allume ou l'éteint.
 *
 *   {
 *     "type": "nas",
 *     "mac": "00-11-22-33-44-55",          // pour l'allumer (Wake-on-LAN)
 *     "host": "192.168.1.50",              // pour connaître son état et l'éteindre
 *     "user": "admin",                     // compte SSH
 *     "key": "%USERPROFILE%\\.ssh\\nas_edge" // clé privée sans phrase secrète
 *   }
 *
 * - Éteint  : le bouton propose « Allumer » et envoie le paquet Wake-on-LAN.
 * - Allumé  : le bouton propose « Éteindre » ; un second appui dans les 5 s confirme,
 *             puis la commande d'extinction est lancée en SSH (sudo sans mot de passe).
 *
 * Options : ports (ports testés pour l'état, défaut [5000, 5001, 22]), sshPort (22),
 *           command ("sudo -n /sbin/poweroff"), labels { on, off, confirm, starting, stopping }.
 */

const net = require('net');
const { execFile } = require('child_process');
const { sendWol } = require('./wol');

const CONFIRM_MS = 5000;
const STARTING_MS = 4 * 60 * 1000;
const STOPPING_MS = 3 * 60 * 1000;

const DEFAULT_LABELS = {
  off: { label: 'Allumer', icon: '🟢' },
  on: { label: 'Éteindre', icon: '🔴' },
  confirm: { label: 'Confirmer ?', icon: '⚠️' },
  starting: { label: 'Démarrage…', icon: '⏳' },
  stopping: { label: 'Extinction…', icon: '⏳' },
};

/** true si un des ports répond (connexion TCP) avant le délai. */
function probeHost(host, ports, timeoutMs = 1200) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return Promise.all(ports.map(tryPort)).then((results) => results.some(Boolean));
}

/** Lance la commande d'extinction en SSH (clé sans phrase secrète, jamais de mot de passe). */
function sshRun({ host, user, key, sshPort, command }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', key,
      '-p', String(sshPort || 22),
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=6',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${user}@${host}`,
      command,
    ];
    execFile('ssh', args, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stderr || '').trim();
      // La connexion est souvent coupée par le NAS pendant qu'il s'éteint : ce n'est pas une erreur.
      if (!err || /closed by remote host|Connection reset|Connection to .* closed/i.test(text)) return resolve();
      if (err.code === 'ENOENT') return reject(new Error('Client SSH introuvable sur ce PC (OpenSSH)'));
      if (/Permission denied/i.test(text)) return reject(new Error('Le NAS refuse la clé SSH (clé non installée ?)'));
      if (/password is required|a terminal is required/i.test(text)) return reject(new Error('Le NAS demande un mot de passe pour s’éteindre (réglage sudo manquant)'));
      reject(new Error(`Extinction impossible : ${text.split(/\r?\n/).pop() || err.message}`));
    });
  });
}

/**
 * @param {object} [deps] dépendances remplaçables pour les tests
 */
function createNasController(deps = {}) {
  const probe = deps.probe || probeHost;
  const wake = deps.wake || sendWol;
  const shutdown = deps.shutdown || sshRun;
  const now = deps.now || Date.now;
  const expand = deps.expandPath || ((p) => p);
  const memory = new Map(); // host -> { confirmUntil, startingUntil, stoppingUntil }

  const mem = (action) => {
    const id = String(action.host || action.mac || '');
    if (!memory.has(id)) memory.set(id, { confirmUntil: 0, startingUntil: 0, stoppingUntil: 0 });
    return memory.get(id);
  };

  const describe = (action, name, online) => {
    const custom = (action.labels && action.labels[name]) || {};
    const base = DEFAULT_LABELS[name];
    const part = typeof custom === 'string' ? { label: custom } : custom;
    return { status: name, online, label: part.label || base.label, icon: part.icon || base.icon };
  };

  const isOnline = (action) => {
    if (!action.host) return Promise.resolve(false);
    const ports = Array.isArray(action.ports) && action.ports.length ? action.ports.map(Number) : [5000, 5001, 22];
    return probe(String(action.host), ports);
  };

  const state = async (action) => {
    const m = mem(action);
    const online = await isOnline(action);
    const t = now();
    if (online) m.startingUntil = 0;
    else m.stoppingUntil = 0;
    if (online && m.stoppingUntil > t) return describe(action, 'stopping', online);
    if (!online && m.startingUntil > t) return describe(action, 'starting', online);
    if (online && m.confirmUntil > t) return describe(action, 'confirm', online);
    return describe(action, online ? 'on' : 'off', online);
  };

  const run = async (action) => {
    if (!action.mac) throw new Error('Adresse MAC manquante (action "nas")');
    const m = mem(action);
    const online = await isOnline(action);
    const t = now();

    if (!online) {
      m.confirmUntil = 0;
      m.stoppingUntil = 0;
      await wake({ mac: action.mac, address: action.address, port: action.port });
      m.startingUntil = t + STARTING_MS;
      return { ...describe(action, 'starting', false), message: 'Signal d’allumage envoyé au NAS' };
    }

    if (m.stoppingUntil > t) return { ...describe(action, 'stopping', true), message: 'Extinction déjà en cours' };
    if (!action.host || !action.user || !action.key) throw new Error('Pour éteindre : "host", "user" et "key" sont nécessaires (action "nas")');

    if (m.confirmUntil <= t) {
      m.confirmUntil = t + CONFIRM_MS;
      return { ...describe(action, 'confirm', true), message: 'Appuyez de nouveau pour éteindre le NAS' };
    }

    m.confirmUntil = 0;
    await shutdown({
      host: String(action.host),
      user: String(action.user),
      key: expand(String(action.key)),
      sshPort: action.sshPort,
      command: action.command || 'sudo -n /sbin/poweroff',
    });
    m.stoppingUntil = t + STOPPING_MS;
    return { ...describe(action, 'stopping', true), message: 'Extinction du NAS demandée' };
  };

  return { run, state };
}

module.exports = { createNasController, probeHost, CONFIRM_MS };
