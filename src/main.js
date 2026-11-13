'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { resolveConfigPath, loadConfig, watchConfig, patchConfigFile } = require('./config');
const { StatsCollector } = require('./stats');
const { createActionRunner, expandEnv } = require('./actions');
const { createAgentServer, DEFAULT_PORT } = require('./agent');
const { createDiscordVoice } = require('./discord-voice');

const WINDOWED = process.argv.includes('--windowed');
// User-Agent de Chrome : évite l'écran "navigateur non supporté" de Discord.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  process.versions.chrome +
  ' Safari/537.36';

let win = null;
let tray = null;
let config = null;
let configPath = null;
let voice = null;
let collector = null;
let actions = null;
let lastStats = null;
let agent = null;
let agentStatus = 'arrêté';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && win.show());
}

/* ------------------------------------------------------------------ */
/* Choix de l'écran                                                    */
/* ------------------------------------------------------------------ */

function findEdgeDisplay(target) {
  const displays = screen.getAllDisplays();
  if (Number.isInteger(target) && displays[target]) return displays[target];
  // Le Xeneon Edge est un écran 2560x720 (ou 720x2560 en portrait).
  // On compare en pixels physiques pour ignorer la mise à l'échelle Windows.
  const isEdge = (d) => {
    const w = Math.round(d.size.width * d.scaleFactor);
    const h = Math.round(d.size.height * d.scaleFactor);
    const ratio = Math.max(w, h) / Math.min(w, h);
    return (Math.max(w, h) === 2560 && Math.min(w, h) === 720) || (ratio > 3.3 && ratio < 3.8);
  };
  return displays.find(isEdge) || null;
}

function placeWindow() {
  if (!win) return;
  const edge = WINDOWED ? null : findEdgeDisplay(config.display.target);
  let bounds;
  if (edge) {
    bounds = edge.bounds;
    win.setBounds(bounds);
    win.setFullScreen(true);
  } else {
    // Pas d'écran Edge détecté : fenêtre de prévisualisation au ratio 32:9 sur l'écran principal.
    win.setFullScreen(false);
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1600, area.width - 80);
    const height = Math.round((width * 720) / 2560);
    bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + 60, width, height };
    win.setBounds(bounds);
  }
  win.setAlwaysOnTop(!!config.display.alwaysOnTop, 'screen-saver');
  // L'interface est dessinée pour 2560x720 (ou 720x2560) pixels CSS : on compense la mise à
  // l'échelle Windows et la taille de la fenêtre de prévisualisation.
  const designWidth = bounds.width >= bounds.height ? 2560 : 720;
  win.webContents.setZoomFactor((bounds.width / designWidth) * (Number(config.display.zoom) || 1));
}

/* ------------------------------------------------------------------ */
/* Fenêtre                                                             */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 450,
    frame: WINDOWED,
    backgroundColor: '#0b0c10',
    show: false,
    skipTaskbar: !WINDOWED,
    autoHideMenuBar: true,
    title: 'Xeneon Edge Widget',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    placeWindow();
    win.show();
  });
  win.on('closed', () => {
    win = null;
  });

  // Écran branché / débranché / réglages d'affichage modifiés.
  const replace = () => setTimeout(placeWindow, 500);
  screen.on('display-added', replace);
  screen.on('display-removed', replace);
  screen.on('display-metrics-changed', replace);
}

/**
 * Sécurise le <webview> Discord : pas de preload, liens externes ouverts dans le navigateur,
 * et autorise uniquement les permissions utiles (micro / notifications).
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (!/^https:\/\//.test(params.src)) params.src = 'about:blank';
  });

  if (contents.getType() === 'webview') {
    contents.setUserAgent(CHROME_UA);
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }
});

/* ------------------------------------------------------------------ */
/* Tray                                                                */
/* ------------------------------------------------------------------ */

/**
 * Lancement au démarrage de Windows (clé « Run » de l'utilisateur, nom XeneonEdgeWidget).
 * Hors exécutable packagé, on enregistre electron.exe + le dossier du projet.
 */
function loginItemOptions() {
  const opts = { name: 'XeneonEdgeWidget' };
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [app.getAppPath()];
  }
  return opts;
}

function setAutostart(enabled) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: !!enabled });
}

function isAutostart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    placeWindow();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.on('click', showWindow);
  refreshTray();
}

/** (Re)construit le menu : il affiche l'état de l'agent iCUE. */
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`Xeneon Edge Widget — agent iCUE ${agentStatus}`);
  const menu = Menu.buildFromTemplate([
    { label: `Agent des widgets iCUE : ${agentStatus}`, enabled: false },
    { type: 'separator' },
    { label: 'Afficher le tableau de bord (fenêtre)', click: showWindow },
    { label: 'Recharger', click: () => win && win.webContents.reload() },
    { label: 'Modifier la configuration…', click: () => shell.openPath(configPath) },
    { label: 'Périphériques audio SteelSeries Sonar…', click: showSonarDevices },
    { label: 'Profils des navigateurs…', click: showBrowserProfiles },
    { label: 'Outils de développement', click: () => win && win.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: isAutostart(),
      // Écrit dans config.json : le réglage est ensuite appliqué par le rechargement à chaud.
      click: (item) => patchConfigFile(configPath, { autostart: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

/** Affiche les noms des sorties connues de Sonar, à recopier dans config.json. */
async function showSonarDevices() {
  const { SonarClient } = require('./sonar');
  try {
    const client = new SonarClient();
    const [devices, { mode, routes }] = await Promise.all([client.getOutputDevices(), client.getRedirections()]);
    const used = new Set(Object.values(routes));
    const lines = devices.map((d) => `${used.has(d.id) ? '▶' : '   '} ${d.friendlyName}`);
    dialog.showMessageBox({
      type: 'info',
      title: 'SteelSeries Sonar',
      message: `Sorties audio disponibles (mode ${mode === 'stream' ? 'streamer' : 'classique'}) :`,
      detail: `${lines.join('\n')}\n\n▶ = sortie actuellement utilisée.\nRecopiez une partie du nom dans "match" de l'action "sonar".`,
    });
  } catch (err) {
    dialog.showErrorBox('SteelSeries Sonar', err.message);
  }
}

/** Affiche les profils de chaque navigateur installé, à recopier dans "profile". */
function showBrowserProfiles() {
  const { createBrowserLauncher } = require('./browser');
  const { expandEnv } = require('./actions');
  const launcher = createBrowserLauncher({ expandEnv });
  const sections = [];
  for (const name of ['chrome', 'edge', 'brave', 'vivaldi', 'firefox']) {
    try {
      launcher.resolveBrowser(name);
    } catch (_) {
      continue; // non installé
    }
    const profiles = launcher.listProfiles(name);
    sections.push(`${name} :\n${profiles.length ? profiles.map((p) => `   • ${p.name}${p.dir && p.dir !== p.name ? `   (${p.dir})` : ''}`).join('\n') : '   (profil par défaut uniquement)'}`);
  }
  dialog.showMessageBox({
    type: 'info',
    title: 'Profils des navigateurs',
    message: 'Profils disponibles :',
    detail: `${sections.join('\n\n') || 'Aucun navigateur détecté.'}\n\nUtilisez le nom du navigateur dans "browser" et le nom du profil dans "profile".`,
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

async function getIconDataUrl(filePath) {
  try {
    const img = await app.getFileIcon(expandEnv(filePath), { size: 'large' });
    return img.isEmpty() ? null : img.toDataURL();
  } catch (_) {
    return null;
  }
}

function registerIpc() {
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('stats:last', () => lastStats);

  ipcMain.handle('action:run', async (_e, action) => {
    try {
      const result = await actions.run(action);
      return { ok: true, result: result && typeof result === 'object' ? result : null };
    } catch (err) {
      console.error('[action]', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('action:state', async (_e, action) => {
    try {
      return { ok: true, state: await actions.state(action) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('icon:get', (_e, filePath) => getIconDataUrl(filePath));

  ipcMain.handle('config:open', () => shell.openPath(configPath));
}

/* ------------------------------------------------------------------ */
/* Agent local pour les widgets iCUE                                   */
/* ------------------------------------------------------------------ */

async function startAgent() {
  const wanted = config.agent.enabled ? Number(config.agent.port) || DEFAULT_PORT : null;
  if (agent && agent.port === wanted) return;
  if (agent) {
    await agent.server.close();
    agent = null;
    agentStatus = 'arrêté';
  }
  if (!wanted) return refreshTray();
  const server = createAgentServer({
    getConfig: () => config,
    getStats: () => lastStats,
    actions,
    getIcon: getIconDataUrl,
    expandPath: expandEnv,
    voice,
    version: app.getVersion(),
  });
  try {
    await server.listen(wanted);
    agent = { server, port: wanted };
    agentStatus = `actif sur le port ${wanted}`;
  } catch (err) {
    agentStatus = `erreur (${err.code || err.message})`;
    dialog.showErrorBox(
      'Agent des widgets iCUE',
      `Impossible d'écouter sur le port ${wanted} : ${err.message}\n\nUne autre instance est peut-être déjà lancée.`
    );
  }
  refreshTray();
}

function applyConfig(next) {
  const previousMode = config && config.mode;
  config = next;
  setAutostart(config.autostart);
  if (collector) collector.setConfig(config);
  startAgent();
  if (config.mode === 'agent' && previousMode !== 'agent' && win) win.close();
  if (config.mode !== 'agent' && !win) createWindow();
  if (win) {
    placeWindow();
    win.webContents.send('config:changed', config);
  }
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  configPath = resolveConfigPath({ isPackaged: app.isPackaged, userDataDir: app.getPath('userData') });
  try {
    config = loadConfig(configPath);
  } catch (err) {
    dialog.showErrorBox('Configuration invalide', `${configPath}\n\n${err.message}\n\nLa configuration d'exemple est utilisée.`);
    config = loadConfig(path.join(__dirname, '..', 'config.example.json'));
  }
  setAutostart(config.autostart);

  actions = createActionRunner({ shell });
  // Vocal Discord (widget Edge Voice) : jetons et favoris à côté de config.json.
  voice = createDiscordVoice({ getSettings: () => (config && config.discordVoice) || {}, dataFile: path.join(path.dirname(configPath), 'discord-voice.json') });
  voice.start();
  registerIpc();
  // Mode "agent" : pas de fenêtre, seulement l'agent pour les widgets iCUE et l'icône de notification.
  if (config.mode !== 'agent') createWindow();
  createTray();
  startAgent();

  collector = new StatsCollector(config, (stats) => {
    lastStats = stats;
    if (win && !win.isDestroyed()) win.webContents.send('stats:update', stats);
  });
  collector.start();

  watchConfig(
    configPath,
    (next) => applyConfig(next),
    (err) => win && win.webContents.send('toast', { type: 'error', message: `config.json invalide : ${err.message}` })
  );
});

app.on('window-all-closed', () => {
  if (!config || config.mode !== 'agent') app.quit();
});
app.on('before-quit', () => {
  if (collector) collector.stop();
  if (actions) actions.dispose();
  if (voice) voice.stop();
  if (agent) agent.server.close();
});
