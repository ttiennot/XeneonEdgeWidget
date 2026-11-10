'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createBrowserLauncher } = require('../src/browser');
const { expandEnv } = require('../src/actions');

process.env.LOCALAPPDATA = 'C:\\Users\\Moi\\AppData\\Local';
process.env.APPDATA = 'C:\\Users\\Moi\\AppData\\Roaming';
process.env.ProgramFiles = 'C:\\Program Files';

const FILES = {
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe': '',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe': '',
  'C:\\Users\\Moi\\AppData\\Local\\Google\\Chrome\\User Data/Local State': JSON.stringify({
    profile: { info_cache: { Default: { name: 'Perso' }, 'Profile 2': { name: 'Travail' } } },
  }),
  'C:\\Users\\Moi\\AppData\\Roaming\\Mozilla\\Firefox\\profiles.ini':
    '[General]\r\nStartWithLastProfile=1\r\n\r\n[Profile1]\r\nName=Boulot\r\nPath=Profiles/abcd.Boulot\r\n\r\n[Profile0]\r\nName=default-release\r\nPath=Profiles/x.default\r\n',
};

function launcher(spawned = []) {
  return createBrowserLauncher({
    expandEnv,
    platform: 'win32',
    exists: (p) => p in FILES,
    readFile: (p) => {
      const key = Object.keys(FILES).find((k) => k.replace(/\\/g, '/') === p.replace(/\\/g, '/'));
      if (key === undefined) throw new Error('ENOENT');
      return FILES[key];
    },
    spawnFn: (exe, args) => {
      spawned.push([exe, args]);
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
}

const URLS = ['https://mail.google.com', 'https://github.com'];

test('Chrome : nom affiché du profil -> dossier, nouvelle fenêtre avec les onglets', async () => {
  const spawned = [];
  await launcher(spawned).open({ type: 'browser', browser: 'chrome', profile: 'travail', urls: URLS });
  assert.deepStrictEqual(spawned, [[
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ['--profile-directory=Profile 2', '--new-window', ...URLS],
  ]]);
});

test('Chrome : nom de dossier accepté, profil inconnu -> liste des profils', () => {
  const l = launcher();
  const def = l.resolveBrowser('chrome');
  assert.deepStrictEqual(l.buildArgs({ profile: 'Default', urls: [] }, def), ['--profile-directory=Default', '--new-window']);
  assert.throws(() => l.buildArgs({ profile: 'Jeux' }, def), /Perso \(Default\), Travail \(Profile 2\)/);
});

test('Chrome : profil isolé via userDataDir', () => {
  const l = launcher();
  const args = l.buildArgs({ userDataDir: '%LOCALAPPDATA%\\ProfilTravail', urls: URLS, newWindow: false }, l.resolveBrowser('chrome'));
  assert.deepStrictEqual(args, ['--user-data-dir=C:\\Users\\Moi\\AppData\\Local\\ProfilTravail', ...URLS]);
});

test('Firefox : -P avec le nom exact du profil et onglets', () => {
  const l = launcher();
  const args = l.buildArgs({ profile: 'boulot', urls: URLS }, l.resolveBrowser('firefox'));
  assert.deepStrictEqual(args, ['-P', 'Boulot', '-new-window', URLS[0], '-new-tab', URLS[1]]);
  assert.deepStrictEqual(l.listProfiles('firefox').map((p) => p.name), ['Boulot', 'default-release']);
});

test('navigateur absent -> message clair', () => {
  assert.throws(() => launcher().resolveBrowser('brave'), /Brave est introuvable/);
});
