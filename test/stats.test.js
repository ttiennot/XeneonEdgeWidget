'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { flattenLhm, summarizeLhm, parseNvidiaSmi, parseNumber } = require('../src/stats');

// Extrait représentatif du data.json de LibreHardwareMonitor (Windows en français : virgule décimale).
const LHM = {
  id: 0, Text: 'Sensor', Value: 'Value', ImageURL: '',
  Children: [{
    id: 1, Text: 'PC-GAMING', ImageURL: 'images_icon/computer.png', Value: '',
    Children: [
      {
        id: 2, Text: 'AMD Ryzen 7 7800X3D', ImageURL: 'images_icon/cpu.png', Value: '',
        Children: [
          { id: 3, Text: 'Clocks', ImageURL: 'images_icon/clock.png', Value: '', Children: [
            { id: 4, Text: 'Core #1', Value: '4 700,0 MHz', ImageURL: 'images/transparent.png', Children: [] },
            { id: 5, Text: 'Core #2', Value: '4 900,0 MHz', ImageURL: 'images/transparent.png', Children: [] },
          ] },
          { id: 6, Text: 'Temperatures', ImageURL: 'images_icon/temperature.png', Value: '', Children: [
            { id: 7, Text: 'Core (Tctl/Tdie)', Value: '61,3 °C', SensorId: '/amdcpu/0/temperature/2', Type: 'Temperature', Children: [] },
            { id: 8, Text: 'CCD1 (Tdie)', Value: '58,0 °C', Children: [] },
          ] },
          { id: 9, Text: 'Load', ImageURL: 'images_icon/load.png', Value: '', Children: [
            { id: 10, Text: 'CPU Total', Value: '23,5 %', Children: [] },
          ] },
          { id: 11, Text: 'Powers', ImageURL: 'images_icon/power.png', Value: '', Children: [
            { id: 12, Text: 'Package', Value: '71,2 W', Children: [] },
          ] },
        ],
      },
      {
        id: 20, Text: 'NVIDIA GeForce RTX 4080', ImageURL: 'images_icon/nvidia.png', Value: '',
        Children: [
          { id: 21, Text: 'Temperatures', Value: '', Children: [
            { id: 22, Text: 'GPU Core', Value: '66,0 °C', Children: [] },
            { id: 23, Text: 'GPU Hot Spot', Value: '78,0 °C', Children: [] },
          ] },
          { id: 24, Text: 'Load', Value: '', Children: [
            { id: 25, Text: 'GPU Core', Value: '97,0 %', Children: [] },
            { id: 26, Text: 'GPU Memory', Value: '45,0 %', Children: [] },
          ] },
          { id: 27, Text: 'Powers', Value: '', Children: [ { id: 28, Text: 'GPU Package', Value: '280,4 W', Children: [] } ] },
          { id: 29, Text: 'Fans', Value: '', Children: [ { id: 30, Text: 'GPU Fan 1', Value: '1 450 RPM', Children: [] } ] },
          { id: 31, Text: 'Data', Value: '', Children: [
            { id: 32, Text: 'GPU Memory Used', Value: '7,5 GB', Children: [] },
            { id: 33, Text: 'GPU Memory Total', Value: '16,0 GB', Children: [] },
          ] },
        ],
      },
      { id: 40, Text: 'Intel UHD Graphics', ImageURL: 'images_icon/intel.png', Value: '', Children: [
        { id: 41, Text: 'Load', Value: '', Children: [ { id: 42, Text: 'D3D 3D', Value: '2,0 %', Children: [] } ] },
      ] },
    ],
  }],
};

test('parseNumber gère virgules et espaces insécables', () => {
  assert.strictEqual(parseNumber('45,3 °C'), 45.3);
  assert.strictEqual(parseNumber('1\u202f450 RPM'), 1450);
  assert.strictEqual(parseNumber('12.5 %'), 12.5);
  assert.strictEqual(parseNumber('Value'), null);
});

test('LibreHardwareMonitor : CPU', () => {
  const { cpu } = summarizeLhm(flattenLhm(LHM));
  assert.strictEqual(cpu.name, 'AMD Ryzen 7 7800X3D');
  assert.strictEqual(cpu.temp, 61.3);
  assert.strictEqual(cpu.load, 23.5);
  assert.strictEqual(cpu.power, 71.2);
  assert.strictEqual(cpu.clock, 4800);
});

test('LibreHardwareMonitor : GPU dédié prioritaire sur l’iGPU', () => {
  const { gpu } = summarizeLhm(flattenLhm(LHM));
  assert.strictEqual(gpu.name, 'NVIDIA GeForce RTX 4080');
  assert.strictEqual(gpu.temp, 66);
  assert.strictEqual(gpu.hotspot, 78);
  assert.strictEqual(gpu.load, 97);
  assert.strictEqual(gpu.power, 280.4);
  assert.strictEqual(gpu.fan, 1450);
  assert.strictEqual(gpu.memUsed, 7.5 * 1024);
  assert.strictEqual(gpu.memTotal, 16 * 1024);
});

test('nvidia-smi', () => {
  const out = 'NVIDIA GeForce RTX 3070, 54, 12, 1234, 8192, 45.67, 30, 1500\r\n';
  assert.deepStrictEqual(parseNvidiaSmi(out), {
    name: 'NVIDIA GeForce RTX 3070', temp: 54, load: 12, memUsed: 1234, memTotal: 8192, power: 45.67, fan: 30, clock: 1500,
  });
  assert.strictEqual(parseNvidiaSmi('NVIDIA X, 50, 3, 100, 200, [N/A], [N/A], 300').power, null);
  assert.strictEqual(parseNvidiaSmi(''), null);
});

test('parseNetstatBytes : lit les octets reçus / envoyés de netstat -e (Windows en français)', () => {
  const { parseNetstatBytes } = require('../src/stats');
  const out = [
    "Statistiques de l'interface",
    '',
    '                                    Reçus            Émis',
    '',
    'Octets                         3877576797       676574885',
    'Paquets monodiffusion            12020135         5640775',
    'Protocoles inconnus                     0',
  ].join('\r\n');
  assert.deepStrictEqual(parseNetstatBytes(out), { rx: 3877576797, tx: 676574885 });
  assert.strictEqual(parseNetstatBytes(''), null);
});
