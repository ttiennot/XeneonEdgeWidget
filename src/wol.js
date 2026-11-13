'use strict';

/**
 * Wake-on-LAN : envoie un « paquet magique » pour allumer un appareil du réseau local
 * (NAS, PC…) à partir de son adresse MAC.
 *
 *   { "type": "wol", "mac": "00-11-22-33-44-55" }
 *
 * Le paquet est diffusé sur chaque carte réseau IPv4 active, pour qu'il parte bien sur le
 * réseau local même si le PC a aussi des cartes virtuelles (Hyper-V, VPN…).
 */

const dgram = require('dgram');
const os = require('os');

/** « 00-11-22-33-44-55 », « 00:11:22:33:44:55 » ou « 001122334455 » -> 6 octets. */
function parseMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12 || /[^0-9a-f:.\-\s]/i.test(String(mac))) throw new Error(`Adresse MAC invalide : "${mac}"`);
  return Buffer.from(hex, 'hex');
}

/** Paquet magique : 6 octets 0xFF suivis de 16 fois l'adresse MAC. */
function buildMagicPacket(mac) {
  const bytes = parseMac(mac);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

/** Adresse de diffusion d'un réseau IPv4 (ex. 192.168.1.20 / 255.255.255.0 -> 192.168.1.255). */
function broadcastAddress(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((part, i) => (part & m[i]) | (~m[i] & 255)).join('.');
}

/** Cartes IPv4 actives : [{ address, broadcast }]. */
function localTargets(interfaces = os.networkInterfaces()) {
  const targets = [];
  for (const list of Object.values(interfaces)) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      targets.push({ address: ni.address, broadcast: broadcastAddress(ni.address, ni.netmask) });
    }
  }
  return targets;
}

function sendFrom(packet, bindAddress, destination, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(0, bindAddress, () => {
      socket.setBroadcast(true);
      socket.send(packet, port, destination, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/**
 * @param {{ mac: string, address?: string, port?: number }} action
 *   address : adresse de diffusion à utiliser à la place de la détection automatique.
 */
async function sendWol(action) {
  const packet = buildMagicPacket(action && action.mac);
  const port = Number(action.port) || 9;
  const targets = action.address ? [{ address: undefined, broadcast: String(action.address) }] : localTargets();
  if (!targets.length) throw new Error('Aucune carte réseau active pour envoyer le paquet Wake-on-LAN');
  // Trois envois espacés : un paquet UDP isolé peut se perdre.
  let sent = 0;
  let lastError = null;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 150));
    for (const t of targets) {
      try {
        await sendFrom(packet, t.address, t.broadcast, port);
        sent++;
      } catch (err) {
        lastError = err;
      }
    }
  }
  if (!sent) throw new Error(`Envoi Wake-on-LAN impossible : ${lastError ? lastError.message : 'erreur inconnue'}`);
  return { sent, targets: targets.map((t) => t.broadcast) };
}

module.exports = { sendWol, buildMagicPacket, parseMac, broadcastAddress, localTargets };
