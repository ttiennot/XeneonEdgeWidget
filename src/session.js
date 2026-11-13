'use strict';

/**
 * Bouton « session » à état : ouvre un espace de travail (une fenêtre de navigateur avec des
 * onglets + des applications), puis propose de tout refermer.
 *
 *   {
 *     "type": "session",
 *     "id": "travail",
 *     "browser": { "browser": "edge", "urls": ["https://…", "https://…"] },
 *     "apps": [
 *       { "process": "OUTLOOK", "launch": { "type": "app", "path": "C:\\…\\OUTLOOK.EXE" } },
 *       { "process": "ms-teams", "launch": { … }, "close": "kill", "state": false }
 *     ]
 *   }
 *
 * - Démarrer : ouvre la fenêtre du navigateur (dans votre profil habituel, connexions conservées)
 *   et lance les applications qui ne tournent pas déjà.
 * - Arrêter : ferme uniquement la fenêtre ouverte par le bouton (pas vos autres fenêtres), puis
 *   les applications. "close": "graceful" (défaut) demande à l'application de se fermer, comme
 *   un clic sur la croix ; "kill" l'arrête de force (utile pour celles qui restent en arrière-plan).
 * - État : actif si la fenêtre du bouton existe encore, ou si une application tourne
 *   ("state": false exclut une application qui tourne souvent en arrière-plan).
 *
 * Windows uniquement : un assistant PowerShell persistant suit les fenêtres et les processus.
 */

const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_LABELS = {
  off: { label: 'Travail', icon: '💼', color: '#1f4f8f' },
  on: { label: 'Stop travail', icon: '⏹️', color: '#8f1f1f' },
};

const BROWSER_PROCESS = { edge: 'msedge', chrome: 'chrome', brave: 'brave', vivaldi: 'vivaldi', firefox: 'firefox' };

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class XeneonSession {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  static string ProcessOf(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  static bool Same(string a, string b) { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }

  // Fenetres principales visibles d'un processus (navigateur) : identifiants separes par des virgules.
  public static string Windows(string proc) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && Same(ProcessOf(h), proc)) {
        var cls = new StringBuilder(256); GetClassName(h, cls, 256);
        string c = cls.ToString();
        if (c.StartsWith("Chrome_WidgetWin") || c == "MozillaWindowClass") found.Add(h.ToInt64().ToString());
      }
      return true;
    }, IntPtr.Zero);
    return string.Join(",", found.ToArray());
  }

  public static bool Alive(long hwnd, string proc) {
    IntPtr h = new IntPtr(hwnd);
    return IsWindow(h) && Same(ProcessOf(h), proc);
  }

  public static void Close(long hwnd, string proc) {
    if (Alive(hwnd, proc)) PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero);
  }

  public static string Running(string names) {
    var parts = new List<string>();
    foreach (string n in names.Split(',')) parts.Add(Process.GetProcessesByName(n.Trim()).Length > 0 ? "1" : "0");
    return string.Join(",", parts.ToArray());
  }

  public static void Quit(string name) {
    foreach (var p in Process.GetProcessesByName(name)) { try { p.CloseMainWindow(); } catch { } }
  }

  public static void Kill(string name) {
    foreach (var p in Process.GetProcessesByName(name)) { try { p.Kill(); } catch { } }
  }
}
"@
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $p = $line.Trim() -split ' '
    $out = ''
    switch ($p[0]) {
      'WINS' { $out = [XeneonSession]::Windows($p[1]) }
      'ALIVE' { if ([XeneonSession]::Alive([long]$p[1], $p[2])) { $out = '1' } else { $out = '0' } }
      'CLOSE' { [XeneonSession]::Close([long]$p[1], $p[2]) }
      'RUNNING' { $out = [XeneonSession]::Running($p[1]) }
      'QUIT' { [XeneonSession]::Quit($p[1]) }
      'KILL' { [XeneonSession]::Kill($p[1]) }
    }
    [Console]::Out.WriteLine('OK ' + $out)
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
}
`;

/** Assistant PowerShell persistant : une ligne envoyée, une ligne de réponse. */
class WindowsSessionHelper {
  constructor() {
    this.proc = null;
    this.pending = [];
    this.buffer = '';
  }

  ensure() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buffer = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line || line === 'READY') continue;
        const waiter = this.pending.shift();
        if (!waiter) continue;
        if (line.startsWith('ERR')) waiter.reject(new Error(`Session Windows : ${line.slice(4)}`));
        else waiter.resolve(line.replace(/^OK\s*/, ''));
      }
    });
    this.proc.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text && !/CLIXML|^<Objs/.test(text)) console.error('[session]', text);
    });
    this.proc.on('exit', () => {
      this.pending.splice(0).forEach((w) => w.reject(new Error('Assistant de session arrêté')));
      this.proc = null;
    });
    this.proc.on('error', () => {});
  }

  send(command) {
    this.ensure();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Délai dépassé (assistant de session)')), 15000);
      this.pending.push({
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.proc.stdin.write(command + '\n');
    });
  }

  dispose() {
    if (this.proc) this.proc.kill();
  }
}

const safeName = (name) => String(name || '').replace(/\.exe$/i, '').replace(/[^\w.-]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {(action: object) => Promise<any>} deps.runAction lance une action classique (browser, app…)
 * @param {string} [deps.stateFile] mémorise la fenêtre ouverte (survit au redémarrage de l'agent)
 * @param {{ send(command: string): Promise<string> }} [deps.helper] remplaçable pour les tests
 */
function createSessionController({ runAction, stateFile, helper, platform = process.platform, wait = sleep }) {
  let h = helper || null;
  const backend = () => {
    if (h) return h;
    if (platform !== 'win32') throw new Error('Le bouton « session » ne fonctionne que sous Windows');
    h = new WindowsSessionHelper();
    return h;
  };

  let memory = {};
  if (stateFile) {
    try {
      memory = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
    } catch (_) {
      memory = {};
    }
  }
  const remember = (id, hwnd) => {
    if (hwnd) memory[id] = { hwnd };
    else delete memory[id];
    if (!stateFile) return;
    try {
      fs.writeFileSync(stateFile, JSON.stringify(memory, null, 2) + '\n', 'utf8');
    } catch (_) {
      /* la mémorisation est un confort : sans elle, la fenêtre n'est plus suivie après un redémarrage */
    }
  };

  const idOf = (action) => String(action.id || 'session');
  const browserProcess = (action) => {
    const b = action.browser && action.browser.browser;
    return safeName(BROWSER_PROCESS[String(b || '').toLowerCase()] || (action.browser && action.browser.process) || 'msedge');
  };
  const apps = (action) => (Array.isArray(action.apps) ? action.apps : []).filter((a) => a && safeName(a.process));

  const windowAlive = async (action) => {
    const saved = memory[idOf(action)];
    if (!saved || !saved.hwnd || !action.browser) return false;
    return (await backend().send(`ALIVE ${Number(saved.hwnd)} ${browserProcess(action)}`)) === '1';
  };

  /** { nom du processus: true/false } pour les applications de la session. */
  const running = async (action) => {
    const list = apps(action);
    if (!list.length) return {};
    const names = list.map((a) => safeName(a.process));
    const flags = (await backend().send(`RUNNING ${names.join(',')}`)).split(',');
    return Object.fromEntries(names.map((n, i) => [n, flags[i] === '1']));
  };

  const isActive = async (action) => {
    if (await windowAlive(action)) return true;
    const run = await running(action);
    return apps(action).some((a) => a.state !== false && run[safeName(a.process)]);
  };

  const describe = (action, active) => {
    const name = active ? 'on' : 'off';
    const base = DEFAULT_LABELS[name];
    const custom = (action.labels && action.labels[name]) || {};
    const part = typeof custom === 'string' ? { label: custom } : custom;
    return { active, index: active ? 1 : 0, label: part.label || base.label, icon: part.icon || base.icon, color: part.color || base.color };
  };

  const windows = async (proc) => (await backend().send(`WINS ${proc}`)).split(',').filter(Boolean);

  async function start(action) {
    if (action.browser && !(await windowAlive(action))) {
      const proc = browserProcess(action);
      const before = new Set(await windows(proc));
      await runAction({ type: 'browser', newWindow: true, ...action.browser });
      // La nouvelle fenêtre apparaît quelques instants après le lancement : on la repère pour pouvoir la refermer.
      let found = null;
      for (let i = 0; i < 40 && !found; i++) {
        await wait(250);
        found = (await windows(proc)).find((w) => !before.has(w)) || null;
      }
      remember(idOf(action), found ? Number(found) : null);
    }
    const run = await running(action);
    for (const app of apps(action)) {
      if (app.launch && !run[safeName(app.process)]) await runAction(app.launch).catch((err) => console.warn('[session]', err.message));
    }
  }

  async function stop(action) {
    const saved = memory[idOf(action)];
    if (saved && saved.hwnd && action.browser) await backend().send(`CLOSE ${Number(saved.hwnd)} ${browserProcess(action)}`);
    remember(idOf(action), null);
    for (const app of apps(action)) {
      await backend().send(`${app.close === 'kill' ? 'KILL' : 'QUIT'} ${safeName(app.process)}`);
    }
  }

  return {
    state: async (action) => describe(action, await isActive(action)),
    /** Bascule : démarre la session si elle est arrêtée, la referme sinon. */
    run: async (action) => {
      const active = await isActive(action);
      if (active) await stop(action);
      else await start(action);
      return { ...describe(action, !active), message: active ? 'Session fermée' : 'Session ouverte' };
    },
    dispose: () => h && h.dispose && h.dispose(),
  };
}

module.exports = { createSessionController };
