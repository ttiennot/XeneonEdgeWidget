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
