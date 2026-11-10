'use strict';

/**
 * Ouverture d'un navigateur sur un profil précis avec une liste d'onglets.
 *
 *   { "type": "browser", "browser": "chrome", "profile": "Travail", "urls": ["https://...", ...] }
 *
 * - browser : chrome | edge | brave | vivaldi | firefox, ou chemin complet d'un exécutable Chromium.
 * - profile : nom affiché du profil ("Travail") ou nom de dossier ("Profile 1").
 * - userDataDir (Chromium) : dossier de profil totalement séparé, créé au premier lancement.
 * - newWindow : ouvre une nouvelle fenêtre (true par défaut).
 * - args : arguments supplémentaires.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BROWSERS = {
  chrome: {
    kind: 'chromium',
    label: 'Google Chrome',
    exe: ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe', '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'],
    unix: ['google-chrome', 'google-chrome-stable', 'chromium'],
    userData: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
  },
  edge: {
    kind: 'chromium',
    label: 'Microsoft Edge',
    exe: ['%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'],
    unix: ['microsoft-edge', 'microsoft-edge-stable'],
    userData: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
  },
  brave: {
    kind: 'chromium',
    label: 'Brave',
    exe: ['%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    unix: ['brave-browser', 'brave'],
    userData: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data',
  },
  vivaldi: {
    kind: 'chromium',
    label: 'Vivaldi',
    exe: ['%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe', '%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe'],
    unix: ['vivaldi', 'vivaldi-stable'],
    userData: '%LOCALAPPDATA%\\Vivaldi\\User Data',
  },
  firefox: {
    kind: 'firefox',
    label: 'Mozilla Firefox',
    exe: ['%ProgramFiles%\\Mozilla Firefox\\firefox.exe', '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe'],
    unix: ['firefox'],
    profilesIni: '%APPDATA%\\Mozilla\\Firefox\\profiles.ini',
  },
};
BROWSERS.msedge = BROWSERS.edge;
BROWSERS['google-chrome'] = BROWSERS.chrome;

function simplify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function createBrowserLauncher({ expandEnv, platform = process.platform, exists = fs.existsSync, readFile = (f) => fs.readFileSync(f, 'utf8'), spawnFn = spawn } = {}) {
  const resolveBrowser = (name) => {
    const key = simplify(name || 'chrome');
    const def = BROWSERS[key];
    if (def) {
      if (platform !== 'win32') {
        const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const exePath = def.unix.flatMap((n) => dirs.map((d) => path.join(d, n))).find((p) => exists(p));
        if (!exePath) throw new Error(`${def.label} est introuvable.`);
        return { ...def, exePath };
      }
      const exePath = def.exe.map(expandEnv).find((p) => exists(p));
      if (!exePath) throw new Error(`${def.label} est introuvable. Indiquez le chemin complet dans "browser".`);
      return { ...def, exePath };
    }
    // Chemin explicite vers un exécutable (considéré comme Chromium, sauf firefox.exe).
    const exePath = expandEnv(name);
    if (!exists(exePath)) throw new Error(`Navigateur introuvable : ${exePath}`);
    const kind = /firefox/i.test(path.basename(exePath)) ? 'firefox' : 'chromium';
    return { kind, label: path.basename(exePath), exePath };
  };

  /** Profils Chromium : [{ dir: "Profile 1", name: "Travail" }] lus dans "Local State". */
  const chromiumProfiles = (def, userDataDir) => {
    const dir = userDataDir ? expandEnv(userDataDir) : def.userData && expandEnv(def.userData);
    if (!dir) return [];
    try {
      const state = JSON.parse(readFile(path.join(dir, 'Local State')).replace(/^﻿/, ''));
      const cache = (state.profile && state.profile.info_cache) || {};
      return Object.entries(cache).map(([d, info]) => ({ dir: d, name: (info && info.name) || d }));
    } catch (_) {
      return [];
    }
  };

  /** Profils Firefox : [{ dir: "xxxx.Travail", name: "Travail" }] lus dans profiles.ini. */
  const firefoxProfiles = (def) => {
    const file = def.profilesIni && expandEnv(def.profilesIni);
    if (!file) return [];
    try {
      const out = [];
      let current = null;
      for (const raw of readFile(file).split(/\r?\n/)) {
        const line = raw.trim();
        const section = line.match(/^\[(.+)\]$/);
        if (section) {
          current = /^Profile\d+$/i.test(section[1]) ? {} : null;
          if (current) out.push(current);
          continue;
        }
        const kv = line.match(/^([^=]+)=(.*)$/);
        if (current && kv) {
          if (kv[1] === 'Name') current.name = kv[2];
          if (kv[1] === 'Path') current.dir = kv[2];
        }
      }
      return out.filter((p) => p.name);
    } catch (_) {
      return [];
    }
  };

  const listProfiles = (browserName, userDataDir) => {
    const def = BROWSERS[simplify(browserName)] || { kind: 'chromium' };
    return def.kind === 'firefox' ? firefoxProfiles(def) : chromiumProfiles(def, userDataDir);
  };

  /** Arguments de ligne de commande pour l'action (sans lancer le navigateur). */
  const buildArgs = (action, def) => {
    const urls = (action.urls || (action.url ? [action.url] : [])).map(String);
    const extra = (action.args || []).map((a) => expandEnv(String(a)));
    const wanted = action.profile;

    if (def.kind === 'firefox') {
      const args = [];
      if (wanted) {
        const profiles = firefoxProfiles(def);
        const found = profiles.find((p) => p.name === wanted) || profiles.find((p) => simplify(p.name) === simplify(wanted));
        if (profiles.length && !found) throw new Error(`Profil Firefox "${wanted}" introuvable. Profils : ${profiles.map((p) => p.name).join(', ')}`);
        args.push('-P', found ? found.name : wanted);
      }
      if (action.newWindow !== false && urls.length) args.push('-new-window', urls[0], ...urls.slice(1).flatMap((u) => ['-new-tab', u]));
      else args.push(...urls);
      return [...args, ...extra];
    }

    const args = [];
    if (action.userDataDir) args.push(`--user-data-dir=${expandEnv(action.userDataDir)}`);
    if (wanted) {
      const profiles = chromiumProfiles(def, action.userDataDir);
      const found =
        profiles.find((p) => p.dir === wanted) ||
        profiles.find((p) => simplify(p.name) === simplify(wanted)) ||
        profiles.find((p) => simplify(p.dir) === simplify(wanted));
      if (profiles.length && !found) {
        throw new Error(`Profil "${wanted}" introuvable dans ${def.label}. Profils : ${profiles.map((p) => `${p.name} (${p.dir})`).join(', ')}`);
      }
      args.push(`--profile-directory=${found ? found.dir : wanted}`);
    }
    if (action.newWindow !== false) args.push('--new-window');
    return [...args, ...extra, ...urls];
  };

  const open = (action) => {
    const def = resolveBrowser(action.browser);
    const args = buildArgs(action, def);
    return new Promise((resolve, reject) => {
      const child = spawnFn(def.exePath, args, { detached: true, stdio: 'ignore' });
      child.once('error', (e) => reject(new Error(`Impossible de lancer ${def.label} : ${e.message}`)));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  };

  return { open, buildArgs, resolveBrowser, listProfiles };
}

module.exports = { createBrowserLauncher, BROWSERS };
