'use strict';

/**
 * Bouton « son » à état : coupe tout le son du PC, puis propose de le rétablir.
 *
 *   { "type": "sound" }
 *
 * - Couper : toutes les sorties audio actives sont mises en muet (avec SteelSeries Sonar ou
 *   plusieurs périphériques, la touche « muet » de Windows n'en coupe qu'un seul).
 * - Rétablir : seules les sorties coupées par ce bouton sont réactivées ; celles que vous aviez
 *   coupées vous-même le restent.
 * - État affiché : celui de la sortie par défaut de Windows.
 *
 * Options : labels { on: { label, icon, color }, muted: { label, icon, color } }.
 *
 * Windows uniquement : un assistant PowerShell persistant parle à l'API audio de Windows.
 */

const { spawn } = require('child_process');

const DEFAULT_LABELS = {
  on: { label: 'Couper son', icon: '🔊', color: '#8f1f1f' },
  muted: { label: 'Rétablir son', icon: '🔇', color: '#1f6f3a' },
};

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, IntPtr ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int access, out IntPtr store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  int GetCount(out uint count);
  int Item(uint index, out IMMDevice device);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public class XeneonAudio {
  static List<string> mutedByUs = new List<string>();

  static IMMDeviceEnumerator Enumerator() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject()); }

  static IAudioEndpointVolume Volume(IMMDevice device) {
    Guid id = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(device.Activate(ref id, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }

  static string Id(IMMDevice device) { string id; Marshal.ThrowExceptionForHR(device.GetId(out id)); return id; }

  // Sorties audio actives (dataFlow 0 = lecture, stateMask 1 = actives).
  static List<IMMDevice> Outputs() {
    var list = new List<IMMDevice>();
    IMMDeviceCollection col;
    Marshal.ThrowExceptionForHR(Enumerator().EnumAudioEndpoints(0, 1, out col));
    uint count; Marshal.ThrowExceptionForHR(col.GetCount(out count));
    for (uint i = 0; i < count; i++) { IMMDevice d; if (col.Item(i, out d) == 0 && d != null) list.Add(d); }
    return list;
  }

  static IMMDevice Default(int role) {
    IMMDevice d;
    return Enumerator().GetDefaultAudioEndpoint(0, role, out d) == 0 ? d : null;
  }

  static bool IsMuted(IMMDevice device) { bool m; Marshal.ThrowExceptionForHR(Volume(device).GetMute(out m)); return m; }

  // Etat affiche : sortie multimedia par defaut.
  public static bool State() {
    IMMDevice d = Default(1);
    return d != null && IsMuted(d);
  }

  public static string Describe() {
    var outputs = Outputs();
    int muted = 0;
    foreach (var d in outputs) if (IsMuted(d)) muted++;
    return outputs.Count + " " + muted;
  }

  public static void Mute() {
    foreach (var d in Outputs()) {
      if (IsMuted(d)) continue;
      Marshal.ThrowExceptionForHR(Volume(d).SetMute(true, IntPtr.Zero));
      string id = Id(d);
      if (!mutedByUs.Contains(id)) mutedByUs.Add(id);
    }
  }

  public static void Unmute() {
    if (mutedByUs.Count > 0) {
      foreach (var d in Outputs()) if (mutedByUs.Contains(Id(d))) Volume(d).SetMute(false, IntPtr.Zero);
      mutedByUs.Clear();
    }
    // Sorties par defaut (console, multimedia, communications) : toujours retablies.
    for (int role = 0; role < 3; role++) { IMMDevice d = Default(role); if (d != null) Volume(d).SetMute(false, IntPtr.Zero); }
  }
}
"@
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    switch ($line.Trim()) {
      'MUTE' { [XeneonAudio]::Mute() }
      'UNMUTE' { [XeneonAudio]::Unmute() }
      'INFO' { [Console]::Out.WriteLine('OK ' + [XeneonAudio]::Describe()); continue }
    }
    $state = 0
    if ([XeneonAudio]::State()) { $state = 1 }
    [Console]::Out.WriteLine('OK ' + $state)
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
}
`;

/** Assistant PowerShell persistant : une ligne envoyée, une ligne de réponse. */
class WindowsSoundHelper {
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
        if (line.startsWith('ERR')) waiter.reject(new Error(`Audio Windows : ${line.slice(4)}`));
        else waiter.resolve(line.replace(/^OK\s*/, ''));
      }
    });
    this.proc.stderr.on('data', (d) => {
      const text = String(d).trim();
      // PowerShell écrit un en-tête technique (CLIXML) sur la sortie d'erreur : sans intérêt.
      if (text && !/CLIXML|^<Objs/.test(text)) console.error('[son]', text);
    });
    this.proc.on('exit', () => {
      this.pending.splice(0).forEach((w) => w.reject(new Error('Assistant audio arrêté')));
      this.proc = null;
    });
    this.proc.on('error', () => {});
  }

  send(command) {
    this.ensure();
    return new Promise((resolve, reject) => {
      // Le premier appel compile l'assistant (~1 à 2 s).
      const timer = setTimeout(() => reject(new Error('Délai dépassé (assistant audio)')), 15000);
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

/**
 * @param {object} [deps]
 * @param {{ send(command: string): Promise<string>, dispose?(): void }} [deps.helper] remplaçable pour les tests
 */
function createSoundController({ helper, platform = process.platform } = {}) {
  let h = helper || null;
  const backend = () => {
    if (h) return h;
    if (platform !== 'win32') throw new Error('Le bouton « son » ne fonctionne que sous Windows');
    h = new WindowsSoundHelper();
    return h;
  };

  const describe = (action, muted) => {
    const name = muted ? 'muted' : 'on';
    const custom = (action && action.labels && action.labels[name]) || {};
    const part = typeof custom === 'string' ? { label: custom } : custom;
    const base = DEFAULT_LABELS[name];
    return { muted, index: muted ? 1 : 0, label: part.label || base.label, icon: part.icon || base.icon, color: part.color || base.color };
  };

  const isMuted = async () => (await backend().send('STATE')) === '1';

  return {
    state: async (action) => describe(action, await isMuted()),
    /** Bascule : coupe si le son est actif, rétablit s'il est coupé. */
    run: async (action) => {
      const muted = await isMuted();
      const after = (await backend().send(muted ? 'UNMUTE' : 'MUTE')) === '1';
      return { ...describe(action, after), message: after ? 'Son coupé' : 'Son rétabli' };
    },
    info: async () => backend().send('INFO'),
    dispose: () => h && h.dispose && h.dispose(),
  };
}

module.exports = { createSoundController };
