'use strict';

/**
 * Installation automatique (lancée par Installer.bat, ou : node scripts/install.js).
 *
 *  1. installe les dépendances (npm install)
 *  2. configure config.json : mode agent (widgets iCUE) + lancement au démarrage de Windows
 *  3. démarre l'application et vérifie que l'agent répond
 *  4. propose d'installer LibreHardwareMonitor (températures précises)
 *  5. copie les widgets .icuewidget sur le Bureau et ouvre le dossier
 *
 * Options : --window      tableau de bord plein écran au lieu des widgets iCUE
 *           --uninstall   arrête l'application et retire le lancement au démarrage
 *           --yes / --no  répond automatiquement aux questions
 *           --skip-npm    ne relance pas npm install
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const PACKAGES = path.join(ROOT, 'icue', 'packages');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'XeneonEdgeWidget';
const IS_WIN = process.platform === 'win32';

const argv = new Set(process.argv.slice(2));
const opts = {
  window: argv.has('--window'),
  uninstall: argv.has('--uninstall'),
  yes: argv.has('--yes'),
  no: argv.has('--no'),
  skipNpm: argv.has('--skip-npm'),
  noLaunch: argv.has('--no-launch'),
  desktop: (process.argv.find((a) => a.startsWith('--desktop=')) || '').slice('--desktop='.length) || null,
};

/* ---------------------------------------------------------------- */
/* Affichage                                                         */
/* ---------------------------------------------------------------- */

let stepNo = 0;
const step = (title) => console.log(`\n[${++stepNo}] ${title}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);
const warn = (msg) => console.log(`    ! ${msg}`);
const info = (msg) => console.log(`      ${msg}`);

function ask(question) {
  if (opts.yes) return Promise.resolve(true);
  if (opts.no || !process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`    ? ${question} [o/N] `, (answer) => {
      rl.close();
      resolve(/^(o|oui|y|yes)$/i.test(answer.trim()));
    })
  );
}

/* ---------------------------------------------------------------- */
/* Outils                                                            */
/* ---------------------------------------------------------------- */

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN, cwd: ROOT, ...options });
}

function powershell(command) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true });
  return res.status === 0 ? String(res.stdout || '').trim() : null;
}

function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function desktopDir() {
  if (opts.desktop) return opts.desktop;
  // Le Bureau peut être redirigé (OneDrive) : on demande le vrai chemin à Windows.
  const fromWindows = IS_WIN ? powershell("[Environment]::GetFolderPath('Desktop')") : null;
  return fromWindows || path.join(os.homedir(), 'Desktop');
}

/** Arrête les instances de l'application lancées depuis ce dossier. */
function stopApp() {
  if (!IS_WIN) return;
  const root = ROOT.replace(/'/g, "''");
  powershell(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${root}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
  );
}

function electronPath() {
  try {
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (_) {
    return null;
  }
}

/* ---------------------------------------------------------------- */
/* Étapes                                                            */
/* ---------------------------------------------------------------- */

function installDependencies() {
  step('Installation des dépendances (npm install)');
  if (opts.skipNpm) return ok('ignorée (--skip-npm)');
  const res = run('npm', ['install', '--no-audit', '--no-fund']);
  if (res.status !== 0) throw new Error('npm install a échoué. Vérifiez votre connexion internet puis relancez.');
  ok('dépendances installées');
}

function configure() {
  step('Configuration');
  const { patchConfigFile, loadConfig } = require('../src/config');
  const existed = fs.existsSync(CONFIG);
  patchConfigFile(CONFIG, { mode: opts.window ? 'window' : 'agent', autostart: true });
  loadConfig(CONFIG); // vérifie que le fichier reste valide
  ok(`${existed ? 'config.json mis à jour' : 'config.json créé'} : ${CONFIG}`);
  info(opts.window ? 'mode « window » : tableau de bord plein écran sur le Xeneon Edge' : 'mode « agent » : les widgets iCUE affichent l’interface, l’application tourne en arrière-plan');
  info('lancement automatique au démarrage de Windows : activé');
}

async function launch() {
  step('Démarrage de l’application');
  if (opts.noLaunch) return ok('ignoré (--no-launch)');
  const exe = electronPath();
  if (!exe || !fs.existsSync(exe)) throw new Error('Electron est introuvable : relancez l’installation (npm install).');
  stopApp();
  // --electron-arg=... : arguments supplémentaires pour Electron (tests, ex. --no-sandbox sous Linux).
  const extra = process.argv.filter((a) => a.startsWith('--electron-arg=')).map((a) => a.slice('--electron-arg='.length));
  const child = spawn(exe, [ROOT, ...extra], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  ok('application démarrée (icône dans la zone de notification)');

  if (opts.window) return;
  for (let i = 0; i < 30; i++) {
    const pong = await httpGet('http://127.0.0.1:17890/api/ping');
    if (pong) return ok('agent des widgets iCUE joignable sur http://localhost:17890');
    await sleep(500);
  }
  warn('l’agent ne répond pas encore. Vérifiez l’icône de l’application dans la zone de notification.');
}

async function hardwareMonitor() {
  step('Températures précises (LibreHardwareMonitor, facultatif)');
  if (await httpGet('http://127.0.0.1:8085/data.json')) return ok('LibreHardwareMonitor est déjà actif');
  info('Sans lui, les températures CPU / GPU viennent d’iCUE (widget Edge System) ou de nvidia-smi.');
  if (!IS_WIN || !(await ask('Installer LibreHardwareMonitor avec winget ?'))) {
    return info('ignoré. Plus tard : https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases');
  }
  const res = run('winget', ['install', '--id', 'LibreHardwareMonitor.LibreHardwareMonitor', '-e', '--accept-package-agreements', '--accept-source-agreements']);
  if (res.status !== 0) return warn('installation via winget impossible. Téléchargez-le : https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases');
  ok('LibreHardwareMonitor installé. À faire une fois dans LibreHardwareMonitor :');
  info('- le lancer en administrateur');
  info('- Options > Remote Web Server > Run');
  info('- Options > Run On Windows Startup, Start Minimized, Minimize To Tray');
}

function copyWidgets() {
  step('Widgets iCUE');
  if (opts.window) return ok('non nécessaires en mode plein écran');
  const files = fs.existsSync(PACKAGES) ? fs.readdirSync(PACKAGES).filter((f) => f.endsWith('.icuewidget')) : [];
  if (!files.length) return warn(`aucun widget trouvé dans ${PACKAGES} (npm run build:icue)`);
  const dest = path.join(desktopDir(), 'Widgets Xeneon Edge');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(PACKAGES, f), path.join(dest, f));
  ok(`${files.length} widgets copiés dans : ${dest}`);
  if (IS_WIN) spawn('explorer.exe', [dest], { detached: true, stdio: 'ignore' }).unref();
  return dest;
}

/* ---------------------------------------------------------------- */
/* Désinstallation                                                   */
/* ---------------------------------------------------------------- */

function uninstall() {
  step('Arrêt de l’application');
  stopApp();
  ok('application arrêtée');
  step('Lancement au démarrage de Windows');
  if (IS_WIN) spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { stdio: 'ignore' });
  if (fs.existsSync(CONFIG)) require('../src/config').patchConfigFile(CONFIG, { autostart: false });
  ok('désactivé');
  console.log('\nPour finir : supprimez les widgets dans iCUE, puis ce dossier si vous le souhaitez.');
}

/* ---------------------------------------------------------------- */

async function main() {
  console.log('Xeneon Edge Widget — installation\n' + '='.repeat(34));
  if (opts.uninstall) return uninstall();

  installDependencies();
  configure();
  await launch();
  await hardwareMonitor();
  const dest = copyWidgets();

  console.log('\nInstallation terminée.');
  if (!opts.window) {
    console.log('\nDernière étape, dans iCUE (elle ne peut pas être automatisée) :');
    console.log('  1. ouvrez iCUE > votre Xeneon Edge > Widgets');
    console.log('  2. cliquez sur « + » au-dessus de la liste des widgets');
    console.log(`  3. importez les 3 fichiers .icuewidget${dest ? ` du dossier « ${path.basename(dest)} » (Bureau)` : ''}`);
    console.log('  4. placez Edge Deck, Edge System et Edge Discord sur l’écran et acceptez les autorisations');
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
