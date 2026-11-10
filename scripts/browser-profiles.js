'use strict';

/**
 * Liste les profils des navigateurs installés (Chrome, Edge, Brave, Vivaldi, Firefox).
 * Usage : npm run browser-profiles
 */
const { createBrowserLauncher } = require('../src/browser');
const { expandEnv } = require('../src/actions');

const launcher = createBrowserLauncher({ expandEnv });
let found = false;
for (const name of ['chrome', 'edge', 'brave', 'vivaldi', 'firefox']) {
  try {
    launcher.resolveBrowser(name);
  } catch (_) {
    continue;
  }
  found = true;
  const profiles = launcher.listProfiles(name);
  console.log(`${name} :`);
  if (!profiles.length) console.log('   (profil par défaut uniquement)');
  profiles.forEach((p) => console.log(`   • ${p.name}${p.dir && p.dir !== p.name ? `   (${p.dir})` : ''}`));
  console.log('');
}
if (!found) console.log('Aucun navigateur détecté.');
console.log('Dans config.json : "browser": "<navigateur>", "profile": "<nom du profil>".');
