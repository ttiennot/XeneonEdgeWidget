'use strict';

const fs = require('fs');
const path = require('path');

const EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');

const DEFAULTS = {
  mode: 'window',
  agent: { enabled: true, port: 17890 },
  display: { target: 'auto', alwaysOnTop: false, zoom: 1 },
  autostart: false,
  layout: { panels: ['deck', 'stats', 'discord'], widths: [1, 1.3, 1.1] },
  theme: { accent: '#3987e5' },
  stats: {
    intervalMs: 1000,
    librehardwaremonitor: { enabled: true, url: 'http://localhost:8085/data.json' },
    nvidiaSmi: true,
    disks: [],
    tempWarning: 70,
    tempCritical: 85,
  },
  deck: { columns: 4, rows: 3, pages: [{ name: 'Principal', buttons: [] }] },
  discord: { url: 'https://discord.com/channels/@me', zoom: 0.8 },
  // Widget Edge Voice : identifiants de l'application créée sur discord.com/developers.
  discordVoice: { clientId: '', clientSecret: '', redirectUri: 'http://localhost' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Fusion profonde : les objets sont fusionnés, les tableaux et scalaires remplacés. */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Retire les clés "_comment" (documentation inline du JSON). */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!k.startsWith('_')) out[k] = stripComments(v);
  }
  return out;
}

function normalize(config) {
  const cfg = deepMerge(DEFAULTS, stripComments(config));
  cfg.deck.columns = Math.max(1, Math.min(8, Number(cfg.deck.columns) || 4));
  cfg.deck.rows = Math.max(1, Math.min(6, Number(cfg.deck.rows) || 3));
  if (!Array.isArray(cfg.deck.pages) || cfg.deck.pages.length === 0) cfg.deck.pages = DEFAULTS.deck.pages;
  const known = new Set(['deck', 'stats', 'discord']);
  cfg.layout.panels = (cfg.layout.panels || []).filter((p) => known.has(p));
  if (cfg.layout.panels.length === 0) cfg.layout.panels = ['stats'];
  cfg.stats.intervalMs = Math.max(250, Number(cfg.stats.intervalMs) || 1000);
  cfg.mode = cfg.mode === 'agent' ? 'agent' : 'window';
  cfg.agent.port = Math.min(65535, Math.max(1, Number(cfg.agent.port) || 17890));
  return cfg;
}

/**
 * Détermine le chemin du fichier de config :
 *  - en développement : ./config.json à la racine du projet
 *  - application packagée : %APPDATA%/Xeneon Edge Widget/config.json
 * Le fichier est créé à partir de config.example.json s'il n'existe pas.
 */
function resolveConfigPath({ isPackaged, userDataDir }) {
  const dir = isPackaged ? userDataDir : path.join(__dirname, '..');
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(EXAMPLE_PATH, file);
  }
  return file;
}

function loadConfig(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return normalize(JSON.parse(raw));
}

/** Surveille le fichier et rappelle onChange(config) ou onError(err), avec anti-rebond. */
function watchConfig(file, onChange, onError) {
  let timer = null;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onChange(loadConfig(file));
      } catch (err) {
        onError(err);
      }
    }, 250);
  };
  // fs.watchFile fonctionne aussi quand les éditeurs remplacent le fichier (écriture atomique).
  fs.watchFile(file, { interval: 1000 }, reload);
  return () => fs.unwatchFile(file, reload);
}

/**
 * Modifie des clés de premier niveau de config.json en conservant le reste du fichier
 * (y compris les commentaires "_comment"). Crée le fichier depuis l'exemple s'il manque.
 */
function patchConfigFile(file, patch) {
  if (!fs.existsSync(file)) fs.copyFileSync(EXAMPLE_PATH, file);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);
  const next = {};
  // Les nouvelles clés sont placées en tête, les existantes gardent leur position.
  for (const key of Object.keys(patch)) if (!(key in data)) next[key] = patch[key];
  for (const [key, value] of Object.entries(data)) next[key] = key in patch ? patch[key] : value;
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

module.exports = { DEFAULTS, deepMerge, normalize, resolveConfigPath, loadConfig, watchConfig, patchConfigFile, EXAMPLE_PATH };
