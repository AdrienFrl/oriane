#!/usr/bin/env node
// ORIANE v2.2 — rejeu d'une marche enregistrée, en ligne de commande (Node ≥ 18).
//
//   node tools/rejeu.mjs <fichier.json.gz> [options]
//
// Options :
//   --tout                    affiche aussi les alertes retenues (non émises) et leur raison
//   --inclinaison=enregistree utilise l'inclinaison du direct au lieu du filtre actuel
//   --set cle=valeur          remplace un réglage (répétable), ex. --set alertRange=4 ou --set levels.poteau=jamais
//   --csv=sortie.csv          écrit le journal détaillé en CSV
//   --json                    sortie JSON (pour comparer des versions)

import { readFile, writeFile } from 'node:fs/promises';
import { parseRecording, ReplaySession } from '../js/rejeu.js';
import { formatEvent, summaryText, eventsToCsv, fmtDuration } from '../js/instruments.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^[\w]+=/.test(a));
if (!file) {
  console.error('Usage : node tools/rejeu.mjs <fichier.json.gz> [--tout] [--inclinaison=enregistree] [--set cle=valeur] [--csv=sortie.csv] [--json]');
  process.exit(2);
}
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const rec0 = file ? await parseRecording(await readFile(file)).catch((e) => {
  console.error('Lecture impossible : ' + e.message);
  process.exit(1);
}) : null;
const overrides = {};
args.forEach((a, i) => {
  if (a === '--set' && args[i + 1]) {
    const [k, v] = args[i + 1].split('=');
    const val = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
    const [k1, k2] = k.split('.'); // levels.poteau=jamais : un niveau d'alerte
    if (k2) overrides[k1] = { ...(overrides[k1] || rec0?.settings?.[k1] || {}), [k2]: val };
    else overrides[k] = val;
  }
});

const rec = rec0;
const session = new ReplaySession(rec, { settings: overrides, pitch: opt('inclinaison') || 'filtre' });
const sum = session.run();

if (args.includes('--json')) {
  console.log(JSON.stringify({ summary: { ...sum, emitted: undefined }, events: session.events }, null, 1));
} else {
  console.log(`Enregistrement ORIANE ${rec.appVersion || '?'} du ${rec.startedAt || '?'}`);
  console.log(`Durée ${fmtDuration(sum.durationMs)} · ${sum.frames} analyses (${(sum.frames / Math.max(1, sum.durationMs / 1000)).toFixed(1).replace('.', ',')}/s)` +
    ` · ${rec.sensors.orientation.length} orientations, ${rec.sensors.motion.length} mouvements, ${rec.sensors.gps.length} positions`);
  if (Object.keys(overrides).length) console.log('Réglages remplacés : ' + JSON.stringify(overrides));
  console.log('');
  const show = args.includes('--tout') ? session.events : session.events.filter((e) => e.emitted);
  for (const e of show) console.log(`${(e.t / 1000).toFixed(1).padStart(6)} s  ${formatEvent(e)}`);
  console.log('');
  console.log('Rejeu : ' + summaryText(sum.counter));
  console.log(`Direct : ${sum.liveEmitted} alerte(s) émise(s) pendant l'enregistrement.`);
  const keys = Object.entries(sum.counter.byKey).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  if (keys) console.log('Par type : ' + keys);
}
const csv = opt('csv');
if (csv) {
  await writeFile(csv, eventsToCsv(session.events));
  console.log(`Journal détaillé écrit dans ${csv}`);
}
