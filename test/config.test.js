'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadConfig, normalize } = require('../src/config');

test('config.example.json est valide', () => {
  const cfg = loadConfig(path.join(__dirname, '..', 'config.example.json'));
  assert.deepStrictEqual(cfg.layout.panels, ['deck', 'stats', 'discord']);
  assert.ok(cfg.deck.pages.length >= 2);
  assert.ok(!('_comment' in cfg.display));
  for (const page of cfg.deck.pages) assert.ok(page.buttons.length <= cfg.deck.columns * cfg.deck.rows);
});

test('normalize complète les valeurs manquantes', () => {
  const cfg = normalize({ layout: { panels: ['stats', 'inconnu'] }, deck: { columns: 99 } });
  assert.deepStrictEqual(cfg.layout.panels, ['stats']);
  assert.strictEqual(cfg.deck.columns, 8);
  assert.strictEqual(cfg.discord.url, 'https://discord.com/channels/@me');
});

test('patchConfigFile conserve le fichier et ajoute les clés', () => {
  const fs = require('fs');
  const os = require('os');
  const { patchConfigFile } = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xew-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ _comment: 'x', autostart: false, deck: { columns: 2 } }));
  const out = patchConfigFile(file, { mode: 'agent', autostart: true });
  assert.deepStrictEqual(Object.keys(out), ['mode', '_comment', 'autostart', 'deck']);
  assert.strictEqual(out.autostart, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).deck, { columns: 2 });
  const created = path.join(path.dirname(file), 'neuf.json');
  assert.strictEqual(patchConfigFile(created, { mode: 'agent' }).mode, 'agent');
  assert.ok(JSON.parse(fs.readFileSync(created, 'utf8')).deck.pages.length >= 2, 'créé depuis l’exemple');
});
