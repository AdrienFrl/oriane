// Test de bout en bout du lot 2.2-0 (Playwright + Chromium) : enregistrement d'une marche dans l'appli,
// fichier téléchargé, relu sous Node et rejoué (mêmes alertes que le direct), puis rejeu dans l'appli.
// Fausse caméra Chromium ; faux module transformers (un poteau qui se rapproche) ; aucun accès réseau.
//
//   npm run e2e        (Chromium et Playwright préinstallés ; sinon PLAYWRIGHT_CHROMIUM=/chemin/chrome)

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ADE_LABELS } from '../../js/classes.js';
import { parseRecording, ReplaySession } from '../../js/rejeu.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}/`;
const step = (m) => console.log('• ' + m);

const FAKE_TRANSFORMERS = `
export const env = {};
export class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
const SIDEWALK = ${ADE_LABELS.indexOf('sidewalk')}, POLE = ${ADE_LABELS.indexOf('pole')}, SKY = ${ADE_LABELS.indexOf('sky')};
let n = 0;
export const AutoModelForSemanticSegmentation = {
  from_pretrained: async () => async ({ pixel_values }) => {
    const [, , h, w] = pixel_values.dims;
    const lh = h / 4, lw = w / 4, C = 150, plane = lh * lw;
    const data = new Float32Array(C * plane);
    n++;
    // Le pied du poteau descend d'une ligne toutes les 1,3 analyses : il se rapproche
    // (caméra de test en paysage, 24 lignes : de 6,3 m à 2,2 m environ).
    const foot = Math.min(lh - 1, Math.round(lh / 3) + Math.floor(n * 0.75));
    const sky = Math.round(lh * 0.08);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const c = x >= 26 && x < 30 && y < foot ? POLE : y < sky ? SKY : SIDEWALK;
      data[c * plane + y * lw + x] = 1;
    }
    return { logits: { dims: [1, C, lh, lw], data } };
  },
};`;

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('serveur local injoignable');
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
let failed = false;
try {
  await waitServer();
  const context = await browser.newContext({ acceptDownloads: true, permissions: ['camera'] });
  // Aucun accès extérieur : faux modèle, tout le reste refusé
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) =>
    route.request().url().includes('@huggingface/transformers')
      ? route.fulfill({ contentType: 'text/javascript', body: FAKE_TRANSFORMERS })
      : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const logText = () => page.locator('#log').textContent();

  await page.goto(BASE);
  assert.match(await page.locator('header .ver').innerText(), /v2\.2-0/);
  step('page chargée, version 2.2-0');

  await page.locator('details.tools > summary').click();
  assert.equal(await page.locator('#recBox').isVisible(), false, 'enregistrement masqué par défaut');
  await page.getByLabel('Enregistrement et rejeu de marches').check();
  assert.equal(await page.locator('#recBox').isVisible(), true);
  step('outils de test : enregistrement activable');

  // Enregistrement d'une marche (fausse caméra, faux modèle)
  await page.locator('#btnRec').click();
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('Enregistrement démarré'), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__oriane.recorder?.frameCount >= 24, null, { timeout: 30000 });
  assert.match(await page.locator('#visionStatus').innerText(), /ENREGISTREMENT.*|alertes 1 min/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btnRec').click()]);
  const dir = await mkdtemp(join(tmpdir(), 'oriane-e2e-'));
  const file = join(dir, download.suggestedFilename());
  await download.saveAs(file);
  assert.match(download.suggestedFilename(), /^oriane-rejeu-.*\.json\.gz$/);
  step(`enregistrement téléchargé : ${download.suggestedFilename()}`);

  const rec = await parseRecording(await readFile(file));
  assert.ok(rec.frames.length >= 24, `${rec.frames.length} analyses`);
  assert.ok(rec.frames.every((f) => f.jpeg && f.labels && f.lw === 56), 'images et cartes de classes présentes');
  assert.ok(rec.live.length > 0, 'des alertes en direct');
  const s = new ReplaySession(rec, { pitch: 'enregistree' });
  s.run();
  const pick = (evs) => evs.map((e) => [e.type, e.label, e.output].join('|'));
  assert.deepEqual(pick(s.events.filter((e) => e.emitted)), pick(rec.live), 'rejeu sous Node = alertes du direct');
  step(`rejeu sous Node : ${rec.frames.length} analyses, ${rec.live.length} alertes, identiques au direct`);

  // Journal détaillé du direct
  const log = await logText();
  assert.match(log, /🔔 Entrée · poteau · .* → bip/);
  await page.locator('details:has(#log) > summary').click();
  const [alertsCsv] = await Promise.all([page.waitForEvent('download'), page.locator('#btnExportAlerts').click()]);
  const csv = await readFile(await alertsCsv.path(), 'utf8');
  assert.match(csv, /^temps;type;emis;danger;objet;cle;niveau;distance_m/);
  assert.match(csv, /\n\d{4}-\d\d-\d\dT[^;]+;entree;oui;non;poteau;/);
  step('journal détaillé et export CSV des alertes');

  // Rejeu dans l'appli : analyse instantanée, puis temps réel
  await page.locator('#replayFile').setInputFiles(file);
  await page.waitForFunction(() => !document.querySelector('#btnReplayRun').disabled);
  await page.locator('#btnReplayRun').click();
  assert.match(await page.locator('#replayInfo').innerText(), /^Rejeu : \d+ alerte\(s\)/);
  assert.match(await logText(), /▶ 🔔 Entrée · poteau/);
  step('rejeu dans l’appli : analyse instantanée');

  await page.locator('#btnReplayPlay').click();
  assert.equal(await page.locator('#replayView').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#replayInfo').innerText.startsWith('Rejeu terminé'), null, { timeout: 30000 });
  const [replayCsv] = await Promise.all([page.waitForEvent('download'), page.locator('#btnReplayCsv').click()]);
  assert.match(await readFile(await replayCsv.path(), 'utf8'), /;entree;oui;non;poteau;/);
  step('rejeu en temps réel terminé, export CSV du rejeu');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript');
  step('aucune erreur JavaScript');
  console.log('e2e 2.2-0 : OK');
} catch (e) {
  failed = true;
  console.error('e2e 2.2-0 : ÉCHEC —', e.message);
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    console.error('Ligne d’état : ' + (await page.locator('#visionStatus').innerText().catch(() => '?')));
    console.error('Journal (récent en premier) :\n' + (await page.locator('#log').evaluate((n) => [...n.children].map((li) => li.textContent).join('\n')).catch(() => '?')).split('\n').slice(0, 25).join('\n'));
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
