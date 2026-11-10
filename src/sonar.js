'use strict';

/**
 * Pilotage de SteelSeries Sonar (SteelSeries GG) via son API locale non officielle.
 *
 * Découverte : %PROGRAMDATA%\SteelSeries\GG\coreProps.json -> ggEncryptedAddress
 *   -> GET https://<ggEncryptedAddress>/subApps -> subApps.sonar.metadata.webServerAddress
 * Routes utilisées (sur webServerAddress) :
 *   GET  mode                                         "classic" | "stream"
 *   GET  audioDevices                                 [{ id, friendlyName, dataFlow, isVad, ... }]
 *   GET  classicRedirections                          [{ id: game|chat|media|aux|mic, deviceId, ... }]
 *   PUT  classicRedirections/<canal>/deviceId/<id>
 *   GET  streamRedirections                           [{ streamRedirectionId: monitoring|streaming|mic, deviceId, ... }]
 *   PUT  streamRedirections/<mix>/deviceId/<id>
 * Le port change à chaque redémarrage de GG : l'adresse est redécouverte en cas d'échec.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const OUTPUT_CHANNELS = ['game', 'chat', 'media', 'aux'];
const STREAM_MIXES = ['monitoring', 'streaming'];

function corePropsPath() {
  const programData = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
  return path.join(programData, 'SteelSeries', 'GG', 'coreProps.json');
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function request(method, url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!isLoopback(u.hostname)) {
      reject(new Error(`Adresse Sonar inattendue : ${u.hostname}`));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method,
        timeout: timeoutMs,
        // Le serveur local de GG utilise un certificat auto-signé : accepté uniquement en boucle locale.
        rejectUnauthorized: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`Sonar a répondu ${res.statusCode}${body ? ` : ${body.slice(0, 200)}` : ''}`);
            err.status = res.statusCode;
            reject(err);
            return;
          }
          if (!body) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve(body);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Sonar ne répond pas')));
    req.on('error', reject);
    req.end();
  });
}

/** Supprime accents et casse pour comparer les noms de périphériques. */
function simplify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Normalise une entrée de la liste "toggle" :
 *   "Arctis"  ->  { match: "Arctis", label: "Arctis" }
 *   { match, label?, icon? }
 */
function normalizeTarget(t) {
  if (typeof t === 'string') return { match: t, label: t };
  if (t && typeof t === 'object' && (t.match || t.id)) return { label: t.label || t.match || t.id, ...t };
  throw new Error('Entrée de périphérique Sonar invalide');
}

/** Trouve le périphérique physique de sortie correspondant à une cible. */
function findDevice(devices, target) {
  const outputs = devices.filter((d) => d.dataFlow === 'render' && !d.isVad);
  if (target.id) {
    const byId = outputs.find((d) => d.id === target.id);
    if (byId) return byId;
  }
  const needle = simplify(target.match);
  return (
    outputs.find((d) => simplify(d.friendlyName) === needle) ||
    outputs.find((d) => simplify(d.friendlyName).includes(needle)) ||
    null
  );
}

class SonarClient {
  constructor({ corePropsFile = corePropsPath() } = {}) {
    this.corePropsFile = corePropsFile;
    this.base = null;
  }

  async discover() {
    let props;
    try {
      props = JSON.parse(fs.readFileSync(this.corePropsFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch (_) {
      throw new Error('SteelSeries GG introuvable (coreProps.json absent). GG est-il installé et lancé ?');
    }
    if (!props.ggEncryptedAddress) throw new Error('Adresse de SteelSeries GG absente de coreProps.json');
    let subApps;
    try {
      subApps = await request('GET', `https://${props.ggEncryptedAddress}/subApps`);
    } catch (err) {
      throw new Error(`SteelSeries GG ne répond pas (${err.message}). GG est-il lancé ?`);
    }
    const sonar = subApps && subApps.subApps && subApps.subApps.sonar;
    if (!sonar) throw new Error('Sonar n’est pas disponible dans SteelSeries GG');
    const address = sonar.metadata && sonar.metadata.webServerAddress;
    if (!sonar.isRunning || !address) throw new Error('Sonar n’est pas démarré dans SteelSeries GG');
    this.base = address.endsWith('/') ? address : `${address}/`;
    return this.base;
  }

  /** Appelle une route Sonar ; redécouvre l'adresse une fois si GG a changé de port. */
  async call(method, route) {
    if (!this.base) await this.discover();
    try {
      return await request(method, this.base + route);
    } catch (err) {
      if (err.status) throw err; // vraie réponse HTTP : pas un problème d'adresse
      await this.discover();
      return request(method, this.base + route);
    }
  }

  async getMode() {
    const mode = await this.call('GET', 'mode');
    return typeof mode === 'string' ? mode.replace(/"/g, '') : 'classic';
  }

  async getDevices() {
    const list = await this.call('GET', 'audioDevices');
    return Array.isArray(list) ? list : [];
  }

  async getOutputDevices() {
    return (await this.getDevices()).filter((d) => d.dataFlow === 'render' && !d.isVad);
  }

  /** Renvoie { mode, routes: { canal: deviceId } } pour les canaux de sortie. */
  async getRedirections() {
    const mode = await this.getMode();
    const routes = {};
    if (mode === 'stream') {
      const list = await this.call('GET', 'streamRedirections');
      (Array.isArray(list) ? list : []).forEach((r) => {
        if (STREAM_MIXES.includes(r.streamRedirectionId)) routes[r.streamRedirectionId] = r.deviceId;
      });
    } else {
      const list = await this.call('GET', 'classicRedirections');
      (Array.isArray(list) ? list : []).forEach((r) => {
        if (OUTPUT_CHANNELS.includes(r.id)) routes[r.id] = r.deviceId;
      });
    }
    return { mode, routes };
  }

  async setOutput(deviceId, channels, mode) {
    const id = encodeURIComponent(deviceId);
    if (mode === 'stream') {
      // En mode streamer, ce que l'on entend est le mix « monitoring » (personnel).
      const mixes = (channels || ['monitoring']).filter((c) => STREAM_MIXES.includes(c));
      for (const mix of mixes.length ? mixes : ['monitoring']) await this.call('PUT', `streamRedirections/${mix}/deviceId/${id}`);
    } else {
      const list = (channels || OUTPUT_CHANNELS).filter((c) => OUTPUT_CHANNELS.includes(c));
      for (const ch of list.length ? list : OUTPUT_CHANNELS) await this.call('PUT', `classicRedirections/${ch}/deviceId/${id}`);
    }
  }

  /**
   * Indique laquelle des cibles est actuellement utilisée.
   * @returns {{ index: number, target: object|null, deviceName: string|null }}
   */
  async currentTarget(targets, channels) {
    const [devices, { mode, routes }] = await Promise.all([this.getDevices(), this.getRedirections()]);
    const reference = mode === 'stream' ? 'monitoring' : (channels && channels.find((c) => OUTPUT_CHANNELS.includes(c))) || 'game';
    const currentId = routes[reference];
    const current = devices.find((d) => d.id === currentId) || null;
    const index = targets.findIndex((t) => {
      const dev = findDevice(devices, t);
      return dev && dev.id === currentId;
    });
    return { index, target: index >= 0 ? targets[index] : null, deviceName: current ? current.friendlyName : null, mode, devices };
  }

  /**
   * Action « sonar » du Stream Deck.
   *  - { toggle: [cible, cible, ...], channels? }  passe à la cible suivante
   *  - { device: cible, channels? }                sélectionne une cible précise
   * Une cible est un fragment du nom Windows du périphérique ("Arctis", "Realtek") ou { match, label, icon }.
   */
  async run(action) {
    const targets = (action.toggle || (action.device ? [action.device] : [])).map(normalizeTarget);
    if (!targets.length) throw new Error('Action sonar : précisez "toggle" ou "device"');
    const { index, mode, devices } = await this.currentTarget(targets, action.channels);
    const nextIndex = action.toggle ? (index + 1) % targets.length : 0;
    const target = targets[nextIndex];
    const device = findDevice(devices, target);
    if (!device) {
      const names = devices.filter((d) => d.dataFlow === 'render' && !d.isVad).map((d) => d.friendlyName);
      throw new Error(`Sonar : aucun périphérique ne correspond à "${target.match || target.id}". Disponibles : ${names.join(', ')}`);
    }
    await this.setOutput(device.id, action.channels, mode);
    return { index: nextIndex, label: target.label, icon: target.icon, deviceName: device.friendlyName };
  }

  /** État à afficher sur un bouton « toggle ». */
  async state(action) {
    const targets = (action.toggle || (action.device ? [action.device] : [])).map(normalizeTarget);
    const { index, target, deviceName } = await this.currentTarget(targets, action.channels);
    return { index, label: target ? target.label : null, icon: target ? target.icon : null, deviceName };
  }
}

module.exports = { SonarClient, findDevice, normalizeTarget, simplify, corePropsPath, OUTPUT_CHANNELS };
