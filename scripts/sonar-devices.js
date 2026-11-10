'use strict';

/**
 * Liste les sorties audio connues de SteelSeries Sonar et celles actuellement utilisées.
 * Usage : npm run sonar-devices
 */
const { SonarClient } = require('../src/sonar');

(async () => {
  const client = new SonarClient();
  const [devices, { mode, routes }] = await Promise.all([client.getOutputDevices(), client.getRedirections()]);
  console.log(`Sonar : mode ${mode === 'stream' ? 'streamer' : 'classique'}\n`);
  console.log('Sorties disponibles :');
  for (const d of devices) {
    const usedBy = Object.entries(routes)
      .filter(([, id]) => id === d.id)
      .map(([ch]) => ch);
    console.log(`  ${usedBy.length ? '▶' : ' '} ${d.friendlyName}${usedBy.length ? `   (${usedBy.join(', ')})` : ''}`);
  }
  console.log('\nRecopiez une partie du nom dans "match" de l\'action "sonar" de config.json.');
})().catch((err) => {
  console.error(`Erreur : ${err.message}`);
  process.exit(1);
});
