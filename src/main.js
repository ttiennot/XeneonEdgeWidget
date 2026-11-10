'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { resolveConfigPath, loadConfig, watchConfig } = require('./config');
const { StatsCollector } = require('./stats');
const { createActionRunner } = require('./actions');

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
let collector = null;
let actions = null;
let lastStats = null;

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

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Xeneon Edge Widget');
  const menu = Menu.buildFromTemplate([
    { label: 'Afficher', click: () => win && (win.show(), placeWindow()) },
    { label: 'Recharger', click: () => win && win.webContents.reload() },
    { label: 'Modifier la configuration…', click: () => shell.openPath(configPath) },
    { label: 'Périphériques audio SteelSeries Sonar…', click: showSonarDevices },
    { label: 'Outils de développement', click: () => win && win.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => win && (win.show(), placeWindow()));
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

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

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

  ipcMain.handle('icon:get', async (_e, filePath) => {
    try {
      const { expandEnv } = require('./actions');
      const img = await app.getFileIcon(expandEnv(filePath), { size: 'large' });
      return img.isEmpty() ? null : img.toDataURL();
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('config:open', () => shell.openPath(configPath));
}

function applyConfig(next) {
  config = next;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!config.autostart });
  if (collector) collector.setConfig(config);
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
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!config.autostart });

  actions = createActionRunner({ shell });
  registerIpc();
  createWindow();
  createTray();

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

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (collector) collector.stop();
  if (actions) actions.dispose();
});
