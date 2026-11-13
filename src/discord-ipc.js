'use strict';

/**
 * Liaison locale avec l'application Discord du PC (canal « discord-ipc », le même que celui
 * utilisé par les Stream Deck et les overlays). Rien ne passe par Internet : c'est un tube
 * nommé de Windows ouvert par Discord quand il tourne.
 *
 * Format d'une trame : 4 octets (opération) + 4 octets (longueur) + JSON.
 */

const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Renvoie une fonction à alimenter avec les octets reçus ; appelle onFrame(op, data) par trame complète. */
function createDecoder(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readInt32LE(0);
      const length = buffer.readInt32LE(4);
      if (length < 0 || length > 16 * 1024 * 1024) {
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < 8 + length) return;
      const json = buffer.subarray(8, 8 + length).toString('utf8');
      buffer = buffer.subarray(8 + length);
      let data = null;
      try {
        data = JSON.parse(json);
      } catch (_) {
        /* trame illisible : ignorée */
      }
      onFrame(op, data);
    }
  };
}

function pipePath(index) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${index}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir();
  return path.join(dir, `discord-ipc-${index}`);
}

function openSocket(file) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(file);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/**
 * Se connecte à Discord et effectue la poignée de main.
 * @returns {Promise<EventEmitter & { send(payload): void, close(): void }>} émet 'frame' (data) et 'close'.
 */
async function connectPipe(clientId) {
  let socket = null;
  for (let i = 0; i < 10 && !socket; i++) {
    try {
      socket = await openSocket(pipePath(i));
    } catch (_) {
      /* essai suivant */
    }
  }
  if (!socket) throw Object.assign(new Error('Discord n’est pas lancé sur ce PC'), { code: 'NO_DISCORD' });

  const transport = new EventEmitter();
  transport.send = (payload) => socket.write(encode(OP.FRAME, payload));
  transport.close = () => socket.destroy();

  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Discord ne répond pas'));
    }, 8000);
    const decode = createDecoder((op, data) => {
      if (op === OP.PING) return socket.write(encode(OP.PONG, data));
      if (op === OP.CLOSE) {
        const message = (data && data.message) || 'connexion refusée';
        socket.destroy();
        if (!ready) {
          clearTimeout(timer);
          reject(Object.assign(new Error(`Discord a refusé la connexion : ${message}`), { code: 'REFUSED' }));
        }
        return;
      }
      if (op !== OP.FRAME || !data) return;
      if (!ready) {
        if (data.evt !== 'READY') return;
        ready = true;
        clearTimeout(timer);
        resolve(transport);
        return;
      }
      transport.emit('frame', data);
    });
    socket.on('data', decode);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      if (!ready) reject(Object.assign(new Error('Discord a fermé la connexion'), { code: 'NO_DISCORD' }));
      else transport.emit('close');
    });
    socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: String(clientId) }));
  });
}

module.exports = { connectPipe, encode, createDecoder, pipePath, OP };
