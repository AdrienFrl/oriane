// Test de bout en bout de la voix (v2.2-0.1) : Chrome ne liste aucune voix (cas du OnePlus) et une
// voix choisie à la main reste dans les réglages. L'appli doit quand même parler, en fr-FR, sans voix
// imposée : aide, « Qu'y a-t-il devant ? », recherche de lieu. Faux speechSynthesis qui note les phrases.
//
//   npm run e2e

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8767;
const BASE = `http://127.0.0.1:${PORT}/`;
const step = (m) => console.log('• ' + m);

/** Faux moteur : aucune voix listée, chaque phrase est « dite » en 300 ms et notée. */
const FAKE_SPEECH = () => {
  const spoken = [];
  window.__spoken = spoken;
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [],
    addEventListener() {},
    speak(u) {
      spoken.push({ text: u.text, lang: u.lang, voice: u.voice ? u.voice.name : null, volume: u.volume });
      this.speaking = true;
      setTimeout(() => {
        u.onstart && u.onstart();
        setTimeout(() => { this.speaking = false; u.onend && u.onend(); }, 300);
      }, 20);
    },
    cancel() { this.speaking = false; },
    resume() { this.paused = false; },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  // Réglages d'un téléphone qui avait choisi une voix (v2.1)
  localStorage.setItem('oriane.settings', JSON.stringify({ voiceURI: 'com.oneplus.tts:fr-FR', settingsVersion: 21 }));
};

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
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
let failed = false;
try {
  await waitServer();
  const context = await browser.newContext();
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort()); // services OSM injoignables
  await context.addInitScript(FAKE_SPEECH);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  const spoken = () => page.evaluate(() => window.__spoken.filter((s) => s.text.trim()));
  const waitSaid = (re) => page.waitForFunction((src) => window.__spoken.some((s) => new RegExp(src).test(s.text)), re.source, { timeout: 15000 });

  const stored = await page.evaluate(() => window.__oriane.settings.voiceURI);
  assert.equal(stored, '', 'voix choisie à la main remise sur « Automatique »');
  assert.match(await page.locator('#voiceDiag').textContent(), /Chrome ne liste aucune voix/);
  step('aucune voix listée, réglage ancien remis sur la voix de Chrome');

  await page.locator('#btnHelp').click();
  await waitSaid(/^Dites « Dis Oriane »/);
  const first = await page.evaluate(() => window.__spoken[0]);
  assert.deepEqual(first, { text: ' ', lang: 'fr-FR', voice: null, volume: 0 }, 'déverrouillage muet au premier appui');
  step('aide dite');

  await page.locator('#btnDescribe').click();
  await waitSaid(/La détection n’est pas active/);
  step('« Qu’y a-t-il devant ? » répond');

  await page.locator('#destInput').fill('la pharmacie la plus proche');
  await page.locator('#destForm button[type=submit]').click();
  await waitSaid(/^Je cherche\.$/);
  await waitSaid(/ne répond pas|Je n’ai rien trouvé|position/);
  step('recherche de lieu : réponses dites');

  const all = await spoken();
  assert.ok(all.length >= 4, `${all.length} phrases`);
  assert.ok(all.every((s) => s.lang === 'fr-FR' && s.voice === null), 'toutes en fr-FR, voix de Chrome');
  assert.equal(await page.locator('#voiceWarn').isVisible(), false, 'pas d’alerte « voix muette »');
  assert.deepEqual(errors, [], 'aucune erreur JavaScript');
  step(`${all.length} phrases dites en fr-FR avec la voix de Chrome, aucune erreur`);
  console.log('e2e voix : OK');
} catch (e) {
  failed = true;
  console.error('e2e voix : ÉCHEC —', e.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
