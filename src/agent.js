'use strict';

/**
 * Agent local : petite API HTTP utilisée par les widgets iCUE.
 *
 * Les widgets iCUE tournent dans une vue web isolée : ils ne peuvent ni lancer une application,
 * ni envoyer un raccourci clavier, ni piloter SteelSeries Sonar. Ils demandent donc ces actions
 * à cet agent, qui écoute uniquement en boucle locale (127.0.0.1 / ::1).
 *
 *   GET  /api/ping              -> { ok, name, version }
 *   GET  /api/config            -> configuration utile aux widgets (deck, seuils, thème, discord)
 *   GET  /api/stats             -> dernières statistiques système
 *   POST /api/action  {action}  -> { ok, result | error }
 *   POST /api/state   {action}  -> { ok, state | error }
 *   GET  /api/icon?path=...     -> { dataUrl }   icône d'un programme
 *   GET  /api/image?path=...    -> { dataUrl }   image locale (png, jpg, svg…) utilisée comme icône de bouton
 *
 * Sécurité : seules les requêtes adressées à localhost sont acceptées (protection contre le
 * « DNS rebinding »), et les pages web publiques (Origin http(s) non local) sont refusées, pour
 * qu'un site visité dans un navigateur ne puisse pas déclencher d'action sur le PC.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const MAX_IMAGE = 2 * 1024 * 1024;

/** Lit une image locale (uniquement des fichiers image, 2 Mo max) et la renvoie en data: URL. */
async function readImageDataUrl(filePath, expand = (p) => p) {
  const file = expand(String(filePath || ''));
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE) return null;
    return `data:${type};base64,${(await fs.promises.readFile(file)).toString('base64')}`;
  } catch (_) {
    return null;
  }
}

const DEFAULT_PORT = 17890;
const MAX_BODY = 64 * 1024;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = String(hostHeader).toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/** true si l'origine est une page web publique (à refuser). */
function isForeignWebOrigin(origin) {
  if (!origin || origin === 'null') return false;
  let url;
  try {
    url = new URL(origin);
  } catch (_) {
    return false; // schéma exotique (vue web iCUE, file://…) : accepté
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) && !LOOPBACK_HOSTS.has(`[${url.hostname}]`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(Object.assign(new Error('JSON invalide'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Partie de la configuration exposée aux widgets. */
function publicConfig(config) {
  return {
    deck: config.deck,
    theme: config.theme,
    discord: config.discord,
    stats: { tempWarning: config.stats.tempWarning, tempCritical: config.stats.tempCritical },
  };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {() => object|null} deps.getStats
 * @param {{ run: Function, state: Function }} deps.actions
 * @param {(path: string) => Promise<string|null>} [deps.getIcon]
 * @param {string} [deps.version]
 */
function createAgentServer({ getConfig, getStats, actions, getIcon, expandPath, voice, version = '1.0.0' }) {
  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin && origin !== 'null' ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      };
      // Chromium : autorise une page à joindre un service en boucle locale (Private Network Access).
      if (req.headers['access-control-request-private-network']) headers['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(status, headers);
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) return send(403, { ok: false, error: 'Hôte refusé' });
    if (isForeignWebOrigin(origin)) return send(403, { ok: false, error: 'Origine refusée' });
    if (req.method === 'OPTIONS') return send(204);

    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(200, { ok: true, name: 'xeneon-edge-agent', version });
      if (req.method === 'GET' && url.pathname === '/api/config') return send(200, publicConfig(getConfig()));
      if (req.method === 'GET' && url.pathname === '/api/stats') return send(200, getStats() || {});
      if (req.method === 'GET' && url.pathname === '/api/icon') {
        const p = url.searchParams.get('path');
        return send(200, { dataUrl: p && getIcon ? await getIcon(p) : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/image') {
        return send(200, { dataUrl: await readImageDataUrl(url.searchParams.get('path'), expandPath) });
      }
      // Vocal Discord (widget Edge Voice) : état, salons, commandes.
      if (url.pathname === '/api/voice' || url.pathname.startsWith('/api/voice/')) {
        if (!voice) return send(200, { status: 'unavailable' });
        if (req.method === 'GET' && url.pathname === '/api/voice') return send(200, voice.snapshot());
        try {
          if (req.method === 'GET' && url.pathname === '/api/voice/guilds') return send(200, { ok: true, guilds: await voice.guilds() });
          if (req.method === 'GET' && url.pathname === '/api/voice/channels') {
            return send(200, { ok: true, channels: await voice.channels(url.searchParams.get('guild')) });
          }
          if (req.method === 'POST' && url.pathname === '/api/voice') {
            if (!/application\/json/i.test(req.headers['content-type'] || '')) return send(415, { ok: false, error: 'Content-Type: application/json requis' });
            const body = await readJsonBody(req);
            switch (body.op) {
              case 'authorize':
                await voice.authorize();
                break;
              case 'join':
                await voice.join(body.channelId);
                break;
              case 'leave':
                await voice.leave();
                break;
              case 'mute':
                await voice.setMute(body.value);
                break;
              case 'deaf':
                await voice.setDeaf(body.value);
                break;
              case 'favorite':
                voice.toggleFavorite(body.channel);
                break;
              case 'user':
                await voice.setUserVoice(body.userId, { volume: body.volume, mute: body.mute });
                break;
              case 'forget':
                voice.forgetRecent(body.channelId);
                break;
              default:
                return send(400, { ok: false, error: 'Opération inconnue' });
            }
            return send(200, { ok: true, voice: voice.snapshot() });
          }
        } catch (err) {
          return send(200, { ok: false, error: err.message, voice: voice.snapshot() });
        }
        return send(404, { ok: false, error: 'Route inconnue' });
      }
      if (req.method === 'POST' && (url.pathname === '/api/action' || url.pathname === '/api/state')) {
        // Exige un corps JSON : oblige le navigateur à une requête préliminaire CORS.
        if (!/application\/json/i.test(req.headers['content-type'] || '')) return send(415, { ok: false, error: 'Content-Type: application/json requis' });
        const { action } = await readJsonBody(req);
        if (!action || typeof action !== 'object') return send(400, { ok: false, error: 'Champ "action" manquant' });
        try {
          if (url.pathname === '/api/action') {
            const result = await actions.run(action);
            return send(200, { ok: true, result: result && typeof result === 'object' ? result : null });
          }
          return send(200, { ok: true, state: await actions.state(action) });
        } catch (err) {
          return send(200, { ok: false, error: err.message });
        }
      }
      return send(404, { ok: false, error: 'Route inconnue' });
    } catch (err) {
      return send(err.status || 500, { ok: false, error: err.message });
    }
  };

  const servers = [];

  /** Écoute sur 127.0.0.1 et ::1 (si IPv6 est disponible). */
  const listen = async (port = DEFAULT_PORT) => {
    const bind = (host) =>
      new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          servers.push(server);
          resolve(server);
        });
      });
    const first = await bind('127.0.0.1');
    const actualPort = first.address().port;
    if (port !== 0) {
      try {
        await bind('::1');
      } catch (_) {
        /* IPv6 indisponible : 127.0.0.1 suffit */
      }
    }
    return actualPort;
  };

  const close = () => Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));

  return { listen, close, handler };
}

module.exports = { createAgentServer, isForeignWebOrigin, publicConfig, readImageDataUrl, DEFAULT_PORT };
