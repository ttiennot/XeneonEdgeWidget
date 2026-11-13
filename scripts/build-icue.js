'use strict';

/**
 * Construit les widgets iCUE :
 *   icue/widgets/<nom>  +  icue/shared  ->  build/icue/<nom>/  ->  icue/packages/<nom>.icuewidget
 * La validation et la création des paquets utilisent l'outil officiel icuewidget-cli de Corsair.
 *
 * Usage : npm run build:icue            (tous les widgets)
 *         npm run build:icue -- deck    (un seul)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'icue', 'widgets');
const SHARED = path.join(ROOT, 'icue', 'shared');
const BUILD = path.join(ROOT, 'build', 'icue');
const OUT = path.join(ROOT, 'icue', 'packages');
const CLI = require.resolve('icuewidget-cli/node-bin/icuewidget.js');

const only = process.argv.slice(2);
const widgets = fs.readdirSync(SRC).filter((n) => fs.statSync(path.join(SRC, n)).isDirectory() && (!only.length || only.includes(n)));

fs.mkdirSync(OUT, { recursive: true });
let failed = false;

for (const name of widgets) {
  const dest = path.join(BUILD, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(SRC, name), dest, { recursive: true });
  fs.cpSync(SHARED, path.join(dest, 'shared'), { recursive: true });

  const out = path.join(OUT, `edge-${name}.icuewidget`);
  const res = spawnSync(process.execPath, [CLI, 'package', dest, '-o', out], { encoding: 'utf8', env: { ...process.env, NO_UPDATE_NOTIFIER: '1', ICUEWIDGET_NO_UPDATE_CHECK: '1' } });
  const output = `${res.stdout || ''}${res.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const warnings = output.split('\n').filter((l) => /warn/i.test(l));
  if (res.status !== 0) {
    failed = true;
    console.error(`✗ ${name}\n${output}`);
  } else {
    console.log(`✓ ${name} -> ${path.relative(ROOT, out)}${warnings.length ? `\n  ${warnings.join('\n  ')}` : ''}`);
  }
}

process.exit(failed ? 1 : 0);
