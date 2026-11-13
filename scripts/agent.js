'use strict';

/**
 * Agent des widgets iCUE sans Electron (sans icône de notification ni icônes de programmes).
 * Pratique pour tester les widgets ; au quotidien, préférez l'application (mode "agent").
 *
 * Usage : npm run agent [-- chemin/vers/config.json]
 */
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, watchConfig, resolveConfigPath } = require('../src/config');
const { StatsCollector } = require('../src/stats');
const { createActionRunner, expandEnv } = require('../src/actions');
const { createAgentServer } = require('../src/agent');
const { createDiscordVoice } = require('../src/discord-voice');

function openWithSystem(target) {
  return new Promise((resolve, reject) => {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [target]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const shell = {
  openExternal: (url) => openWithSystem(url),
  openPath: (p) => openWithSystem(p).then(() => '', (err) => err.message),
};

const configPath = process.argv[2] ? path.resolve(process.argv[2]) : resolveConfigPath({ isPackaged: false });
let config = loadConfig(configPath);
let lastStats = null;

const collector = new StatsCollector(config, (s) => (lastStats = s));
collector.start();
const actions = createActionRunner({ shell });
const voice = createDiscordVoice({ getSettings: () => config.discordVoice || {}, dataFile: path.join(path.dirname(configPath), 'discord-voice.json') });
voice.start();
const server = createAgentServer({ getConfig: () => config, getStats: () => lastStats, actions, expandPath: expandEnv, voice });

server.listen(config.agent.port).then(
  (port) => console.log(`Agent des widgets iCUE : http://localhost:${port}  (config : ${configPath})`),
  (err) => {
    console.error(`Impossible d'écouter sur le port ${config.agent.port} : ${err.message}`);
    process.exit(1);
  }
);

watchConfig(
  configPath,
  (next) => {
    config = next;
    collector.setConfig(config);
    console.log('Configuration rechargée');
  },
  (err) => console.error(`config.json invalide : ${err.message}`)
);

const stop = () => {
  collector.stop();
  actions.dispose();
  server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
