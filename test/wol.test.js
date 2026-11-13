'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildMagicPacket, parseMac, broadcastAddress, localTargets } = require('../src/wol');

test('parseMac : accepte tirets, deux-points et forme compacte', () => {
  const expected = Buffer.from([0x90, 0x09, 0xd0, 0x46, 0x19, 0xfb]);
  assert.deepStrictEqual(parseMac('90-09-D0-46-19-FB'), expected);
  assert.deepStrictEqual(parseMac('90:09:d0:46:19:fb'), expected);
  assert.deepStrictEqual(parseMac('9009D04619FB'), expected);
});

test('parseMac : refuse une adresse incomplète ou invalide', () => {
  assert.throws(() => parseMac('90-09-D0-46-19'), /MAC invalide/);
  assert.throws(() => parseMac('zz-09-D0-46-19-FB'), /MAC invalide/);
  assert.throws(() => parseMac(''), /MAC invalide/);
});

test('buildMagicPacket : 6 octets FF puis 16 fois la MAC', () => {
  const packet = buildMagicPacket('90-09-D0-46-19-FB');
  assert.strictEqual(packet.length, 102);
  assert.ok(packet.subarray(0, 6).every((b) => b === 0xff));
  for (let i = 0; i < 16; i++) {
    assert.strictEqual(packet.subarray(6 + i * 6, 12 + i * 6).toString('hex'), '9009d04619fb');
  }
});

test('broadcastAddress et localTargets', () => {
  assert.strictEqual(broadcastAddress('192.168.1.20', '255.255.255.0'), '192.168.1.255');
  assert.strictEqual(broadcastAddress('10.4.7.9', '255.255.240.0'), '10.4.15.255');
  const targets = localTargets({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    eth: [
      { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff::' },
      { family: 'IPv4', internal: false, address: '192.168.1.20', netmask: '255.255.255.0' },
    ],
  });
  assert.deepStrictEqual(targets, [{ address: '192.168.1.20', broadcast: '192.168.1.255' }]);
});
