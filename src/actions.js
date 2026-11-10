'use strict';

/**
 * Exécution des actions du Stream Deck.
 *
 * Types d'actions :
 *  - app     { path, args?, cwd? }     lance un programme (ou ouvre un raccourci .lnk)
 *  - url     { url }                   ouvre une URL (http, steam://, spotify:, ...)
 *  - folder  { path }                  ouvre un dossier / fichier avec l'application par défaut
 *  - command { command }               exécute une ligne de commande
 *  - hotkey  { keys: "ctrl+shift+m" }  envoie une combinaison de touches
 *  - media   { key: "playpause" }      touche multimédia (playpause, next, prev, stop, volumeup, volumedown, mute)
 *  - text    { text }                  tape un texte
 *  - multi   { actions: [...], delayMs? } enchaîne plusieurs actions
 *  - sonar   { toggle: [...] } | { device } change la sortie audio de SteelSeries Sonar (voir sonar.js)
 *  - browser { browser, profile, urls }  ouvre un navigateur sur un profil avec des onglets (voir browser.js)
 *  (page et discord sont gérées directement par l'interface)
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const { SonarClient } = require('./sonar');
const { createBrowserLauncher } = require('./browser');

/* ------------------------------------------------------------------ */
/* Codes de touches virtuelles Windows                                 */
/* ------------------------------------------------------------------ */

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, printscreen: 0x2c, prtsc: 0x2c, pause: 0x13,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, apps: 0x5d, menu: 0x5d,
  volumemute: 0xad, mute: 0xad, volumedown: 0xae, volumeup: 0xaf,
  next: 0xb0, nexttrack: 0xb0, prev: 0xb1, previous: 0xb1, prevtrack: 0xb1, stop: 0xb2, playpause: 0xb3, play: 0xb3,
  ';': 0xba, '=': 0xbb, plus: 0xbb, ',': 0xbc, comma: 0xbc, '-': 0xbd, minus: 0xbd, '.': 0xbe, period: 0xbe,
  '+': 0xbb, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
  multiply: 0x6a, add: 0x6b, subtract: 0x6d, decimal: 0x6e, divide: 0x6f,
};
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;
for (let i = 0; i <= 9; i++) {
  VK[String(i)] = 0x30 + i;
  VK[`num${i}`] = 0x60 + i;
  VK[`numpad${i}`] = 0x60 + i;
}
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c).toLowerCase()] = c;

/** Touches nécessitant le drapeau KEYEVENTF_EXTENDEDKEY. */
const EXTENDED = new Set([0x2d, 0x2e, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x2c, 0x90, 0x6f, 0x5b, 0x5d,
  0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3]);

const MEDIA_KEYS = new Set(['playpause', 'play', 'next', 'nexttrack', 'prev', 'previous', 'prevtrack', 'stop', 'volumeup', 'volumedown', 'mute', 'volumemute']);

/** "ctrl+shift+m" -> [{ vk: 0x11, ext: false }, ...] ; lève une erreur pour une touche inconnue. */
function parseHotkey(keys) {
  const parts = String(keys || '')
    .toLowerCase()
    .split(/\s*\+\s*(?!$)/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('Combinaison de touches vide');
  return parts.map((name) => {
    const vk = VK[name];
    if (vk === undefined) throw new Error(`Touche inconnue : "${name}"`);
    return { vk, ext: EXTENDED.has(vk) };
  });
}

/** Échappe un texte pour System.Windows.Forms.SendKeys. */
function escapeSendKeys(text) {
  return String(text)
    .replace(/[+^%~(){}[\]]/g, '{$&}')
    .replace(/\r?\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
}

/** Remplace %VAR% (Windows) et $VAR / ~ (Unix) par leurs valeurs. */
function expandEnv(str) {
  if (typeof str !== 'string') return str;
  let out = str.replace(/%([^%]+)%/g, (m, name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? process.env[key] : m;
  });
  out = out.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
  if (out.startsWith('~') && process.env.HOME) out = path.join(process.env.HOME, out.slice(1));
  return out;
}

/* ------------------------------------------------------------------ */
/* Assistant PowerShell persistant (injection clavier Windows)         */
/* ------------------------------------------------------------------ */

function buildPowerShellHelper(ownPid) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class XeneonKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  // Si notre fenêtre a le focus, le rend à la fenêtre située juste en dessous (jeu, navigateur...).
  public static void ReleaseFocus(uint ownPid) {
    uint pid;
    IntPtr fg = GetForegroundWindow();
    GetWindowThreadProcessId(fg, out pid);
    if (fg != IntPtr.Zero && pid != ownPid) return;
    IntPtr h = GetTopWindow(IntPtr.Zero);
    while (h != IntPtr.Zero) {
      GetWindowThreadProcessId(h, out pid);
      if (pid != ownPid && IsWindowVisible(h) && !IsIconic(h) && GetWindowTextLength(h) > 0) {
        StringBuilder cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        string c = cls.ToString();
        if (c != "Shell_TrayWnd" && c != "Progman" && c != "WorkerW") {
          keybd_event(0x12, 0, 0, UIntPtr.Zero);
          keybd_event(0x12, 0, 2, UIntPtr.Zero);
          SetForegroundWindow(h);
          System.Threading.Thread.Sleep(80);
          return;
        }
      }
      h = GetWindow(h, 2);
    }
  }

  public static void Press(string spec) {
    string[] items = spec.Split(',');
    byte[] vks = new byte[items.Length];
    uint[] flags = new uint[items.Length];
    for (int i = 0; i < items.Length; i++) {
      string[] p = items[i].Split(':');
      vks[i] = (byte)int.Parse(p[0]);
      flags[i] = p[1] == "1" ? 1u : 0u;
    }
    for (int i = 0; i < vks.Length; i++) { keybd_event(vks[i], 0, flags[i], UIntPtr.Zero); System.Threading.Thread.Sleep(15); }
    System.Threading.Thread.Sleep(30);
    for (int i = vks.Length - 1; i >= 0; i--) { keybd_event(vks[i], 0, flags[i] | 2u, UIntPtr.Zero); System.Threading.Thread.Sleep(10); }
  }
}
"@
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $cmd, $arg = $line -split ' ', 2
    switch ($cmd) {
      'KEYS' { [XeneonKeys]::ReleaseFocus(${ownPid}); [XeneonKeys]::Press($arg) }
      'MEDIA' { [XeneonKeys]::Press($arg) }
      'TEXT' {
        [XeneonKeys]::ReleaseFocus(${ownPid})
        $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg))
        [System.Windows.Forms.SendKeys]::SendWait($t)
      }
    }
    [Console]::Out.WriteLine('OK')
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
}
`;
}

class WindowsKeyHelper {
  constructor(ownPid) {
    this.ownPid = ownPid;
    this.proc = null;
    this.pending = [];
    this.buffer = '';
  }

  ensure() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    const encoded = Buffer.from(buildPowerShellHelper(this.ownPid), 'utf16le').toString('base64');
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
        if (line.startsWith('ERR')) waiter.reject(new Error(line.slice(4)));
        else waiter.resolve();
      }
    });
    this.proc.stderr.on('data', (d) => console.error('[keys]', String(d).trim()));
    this.proc.on('exit', () => {
      this.pending.splice(0).forEach((w) => w.reject(new Error('Assistant clavier arrêté')));
      this.proc = null;
    });
  }

  send(line) {
    this.ensure();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Délai dépassé (assistant clavier)')), 10000);
      this.pending.push({
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.proc.stdin.write(line + '\n');
    });
  }

  dispose() {
    if (this.proc) this.proc.kill();
  }
}

/* ------------------------------------------------------------------ */
/* Linux (développement) : xdotool                                     */
/* ------------------------------------------------------------------ */

const XDOTOOL_NAMES = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', win: 'super', meta: 'super', esc: 'Escape', escape: 'Escape',
  enter: 'Return', del: 'Delete', delete: 'Delete', pageup: 'Prior', pagedown: 'Next', space: 'space', tab: 'Tab',
  playpause: 'XF86AudioPlay', play: 'XF86AudioPlay', next: 'XF86AudioNext', prev: 'XF86AudioPrev', previous: 'XF86AudioPrev',
  stop: 'XF86AudioStop', volumeup: 'XF86AudioRaiseVolume', volumedown: 'XF86AudioLowerVolume', mute: 'XF86AudioMute',
  volumemute: 'XF86AudioMute', printscreen: 'Print',
};

function runFile(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} a échoué (${code})`))));
  });
}

/* ------------------------------------------------------------------ */
/* Exécuteur                                                           */
/* ------------------------------------------------------------------ */

function createActionRunner({ shell, ownPid = process.pid, platform = process.platform }) {
  const keyHelper = platform === 'win32' ? new WindowsKeyHelper(ownPid) : null;
  let sonarClient = null;
  const sonar = () => (sonarClient = sonarClient || new SonarClient());
  const browsers = createBrowserLauncher({ expandEnv, platform });
  if (keyHelper) keyHelper.ensure(); // pré-chargement : la compilation C# prend ~1 s

  const sendHotkey = async (keys) => {
    const parsed = parseHotkey(keys);
    if (keyHelper) return keyHelper.send('KEYS ' + parsed.map((k) => `${k.vk}:${k.ext ? 1 : 0}`).join(','));
    const combo = String(keys).toLowerCase().split('+').map((k) => XDOTOOL_NAMES[k.trim()] || k.trim()).join('+');
    return runFile('xdotool', ['key', '--clearmodifiers', combo]);
  };

  const sendMedia = async (key) => {
    const name = String(key || '').toLowerCase();
    if (!MEDIA_KEYS.has(name)) throw new Error(`Touche média inconnue : "${key}"`);
    if (keyHelper) return keyHelper.send(`MEDIA ${VK[name]}:1`);
    return runFile('xdotool', ['key', XDOTOOL_NAMES[name]]);
  };

  const sendText = async (text) => {
    if (keyHelper) return keyHelper.send('TEXT ' + Buffer.from(escapeSendKeys(text), 'utf8').toString('base64'));
    return runFile('xdotool', ['type', '--', String(text)]);
  };

  const launchApp = async (action) => {
    const target = expandEnv(action.path);
    if (!target) throw new Error('Chemin manquant');
    const args = (action.args || []).map(expandEnv);
    // Raccourcis, documents, .url : ouverture par l'application associée.
    if (!args.length && /\.(lnk|url|appref-ms|bat|cmd)$/i.test(target)) {
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
      return;
    }
    await new Promise((resolve, reject) => {
      const child = spawn(target, args, {
        cwd: action.cwd ? expandEnv(action.cwd) : path.dirname(target) !== '.' ? path.dirname(target) : undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.once('error', (e) => reject(new Error(`Impossible de lancer ${target} : ${e.message}`)));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  };

  const runCommand = (command) =>
    new Promise((resolve, reject) => {
      const child = exec(expandEnv(command), { windowsHide: true, timeout: 60000 }, (err) => {
        if (err && !err.killed && err.code !== 0 && err.code !== undefined) console.warn('[command]', err.message);
      });
      child.once('error', reject);
      child.once('spawn', () => resolve());
    });

  const run = async (action) => {
    if (!action || !action.type) throw new Error('Action invalide');
    switch (action.type) {
      case 'app':
        return launchApp(action);
      case 'url':
        if (!action.url) throw new Error('URL manquante');
        return shell.openExternal(action.url);
      case 'folder':
      case 'file': {
        const err = await shell.openPath(expandEnv(action.path));
        if (err) throw new Error(err);
        return undefined;
      }
      case 'command':
        return runCommand(action.command);
      case 'hotkey':
        return sendHotkey(action.keys);
      case 'media':
        return sendMedia(action.key);
      case 'text':
        return sendText(action.text || '');
      case 'multi': {
        const delay = Math.max(0, Number(action.delayMs) || 150);
        for (const [i, sub] of (action.actions || []).entries()) {
          if (i > 0) await new Promise((r) => setTimeout(r, delay));
          await run(sub);
        }
        return undefined;
      }
      case 'sonar':
        return sonar().run(action);
      case 'browser':
        return browsers.open(action);
      case 'page':
      case 'discord':
        return undefined; // gérées par l'interface
      default:
        throw new Error(`Type d'action inconnu : "${action.type}"`);
    }
  };

  /** État courant à afficher sur un bouton (null si le type n'a pas d'état). */
  const state = async (action) => {
    if (action && action.type === 'sonar') return sonar().state(action);
    return null;
  };

  return {
    run,
    state,
    dispose: () => keyHelper && keyHelper.dispose(),
  };
}

module.exports = { createActionRunner, parseHotkey, escapeSendKeys, expandEnv, VK, buildPowerShellHelper };
