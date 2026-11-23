// Tests de la synthèse vocale avec un faux moteur Chrome (voix muette sur Android, v2.2-0).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const GOOGLE = { name: 'Google français', lang: 'fr-FR', localService: false, voiceURI: 'Google français' };
const LOCAL = { name: 'Français France', lang: 'fr-FR', localService: true, voiceURI: 'fr-fr' };

/**
 * Faux speechSynthesis.
 * voices : voix listées ; failNext : nombre de phrases en erreur `synthesis-failed` avant le début ;
 * noStart : Chrome Android qui ne signale pas le début ; durationMs : durée d'une phrase.
 */
class FakeSynth extends EventTarget {
  constructor() {
    super();
    this.spoken = [];
    this.calls = [];
    this.voices = [LOCAL, GOOGLE];
    this.failNext = 0;
    this.noStart = false;
    this.durationMs = 500;
    this.speaking = false;
    this.pending = false;
    this.paused = false;
    this.current = null;
  }
  getVoices() {
    return this.voices;
  }
  speak(u) {
    this.calls.push({ text: u.text, voice: u.voice?.name || null, lang: u.lang, volume: u.volume });
    this.speaking = true;
    this.current = u;
    if (this.failNext > 0) {
      this.failNext--;
      setTimeout(() => {
        if (this.current !== u) return;
        this.current = null;
        this.speaking = false;
        u.onerror?.({ error: 'synthesis-failed' });
      }, 30);
      return;
    }
    setTimeout(() => {
      if (this.current !== u) return;
      if (!this.noStart) u.onstart?.();
      setTimeout(() => {
        if (this.current !== u) return;
        this.spoken.push(u.text);
        this.current = null;
        this.speaking = false;
        u.onend?.();
      }, this.durationMs);
    }, 50);
  }
  cancel() {
    this.calls.push({ cancel: true });
    const u = this.current;
    this.current = null;
    this.speaking = false;
    if (u) setTimeout(() => u.onerror?.({ error: 'interrupted' }), 0);
  }
  resume() {
    this.calls.push({ resume: true });
    this.paused = false;
  }
}

let synth;
async function load(setup = () => {}) {
  synth = new FakeSynth();
  setup(synth);
  globalThis.window = { speechSynthesis: synth };
  globalThis.speechSynthesis = synth;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const { Voice } = await import('../js/speech.js?' + Math.random());
  return new Voice();
}
/** Avance le temps simulé par petits pas (les promesses ont le temps de se résoudre). */
async function run(ms) {
  for (let t = 0; t < ms; t += 10) {
    mock.timers.tick(10);
    await new Promise((r) => setImmediate(r));
  }
}

test('voix : phrases dites dans l’ordre des priorités', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  v.say('Je cherche.', { priority: 2 });
  v.say('info', { priority: 1 });
  v.say('Virage à droite.', { priority: 2 });
  await run(3000);
  assert.deepEqual(synth.spoken, ['Je cherche.', 'Virage à droite.', 'info']);
  assert.equal(v.successes, 3);
  mock.timers.reset();
});

test('voix : la voix Google de Chrome est choisie, même si une voix locale est listée avant', async () => {
  const v = await load();
  assert.equal(v.voice.name, 'Google français');
  assert.equal(v.frenchVoices[0].name, 'Google français');
  v.setPreferred('fr-fr');
  assert.equal(v.voice.name, 'Français France', 'voix choisie à la main');
  v.setPreferred('system');
  assert.equal(v.voice, null, 'voix par défaut de Chrome');
  v.setPreferred('voix-disparue');
  assert.equal(v.voice.name, 'Google français', 'voix choisie absente : retour à Google');
});

test('voix : aucune voix listée (Android) → la phrase part quand même, en fr-FR, sans voix imposée', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load((s) => (s.voices = []));
  assert.equal(v.voice, null);
  assert.match(v.diagnose().chosen, /voix française par défaut de Chrome/);
  v.say('Je cherche.', { priority: 2 });
  await run(1000);
  assert.deepEqual(synth.calls, [{ text: 'Je cherche.', voice: null, lang: 'fr-FR', volume: undefined }]);
  assert.deepEqual(synth.spoken, ['Je cherche.']);
  mock.timers.reset();
});

test('voix : Chrome ne signale pas le début → une longue phrase n’est jamais coupée', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load((s) => {
    s.noStart = true;
    s.durationMs = 6000;
  });
  const errors = [];
  v.onerror = (c) => errors.push(c);
  const text = 'J’ai trouvé 3 lieux. Un : Intermarché, à 800 mètres. Deux : Carrefour, à 1,2 kilomètre.';
  v.say(text, { priority: 2 });
  await run(7000);
  assert.deepEqual(synth.spoken, [text]);
  assert.ok(!synth.calls.some((c) => c.cancel), 'aucune coupure');
  assert.deepEqual(errors, []);
  mock.timers.reset();
});

test('voix : erreur de la voix choisie → phrase redite avec la voix de Chrome ; erreur sans voix → signalée, la file continue', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load((s) => (s.failNext = 1));
  const rec = [];
  const errors = [];
  v.onrecover = (c) => rec.push(c);
  v.onerror = (c, t) => errors.push([c, t]);
  v.say('Poteau, droite.', { priority: 2 });
  await run(1500);
  assert.deepEqual(synth.calls.map((c) => c.voice), ['Google français', null]);
  assert.deepEqual(synth.spoken, ['Poteau, droite.']);
  assert.deepEqual(rec, ['synthesis-failed']);
  assert.deepEqual(errors, []);
  synth.failNext = 2;
  v.say('Un.', { priority: 2 });
  v.say('Deux.', { priority: 2 });
  await run(3000);
  assert.deepEqual(errors, [['synthesis-failed', 'Un.']]);
  assert.deepEqual(synth.spoken, ['Poteau, droite.', 'Deux.']);
  mock.timers.reset();
});

test('voix : déverrouillage au premier appui (phrase muette, une seule fois)', async () => {
  const v = await load();
  v.unlock();
  v.unlock();
  assert.deepEqual(synth.calls, [{ text: ' ', voice: null, lang: 'fr-FR', volume: 0 }]);
});

test('voix : moteur en pause (arrière-plan) → resume avant de parler', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  synth.paused = true;
  v.say('Bonjour.', { priority: 2 });
  await run(1000);
  assert.ok(synth.calls[0].resume, 'resume appelé avant de parler');
  assert.deepEqual(synth.spoken, ['Bonjour.']);
  mock.timers.reset();
});

test('voix : mains libres, on attend la libération du micro avant de parler', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  let release;
  v.beforeSpeak = () => new Promise((r) => (release = r));
  v.say('Stop, poteau.', { priority: 3 });
  await run(500);
  assert.equal(synth.calls.length, 0, 'rien n’est envoyé au moteur tant que le micro est ouvert');
  release();
  await run(1000);
  assert.deepEqual(synth.spoken, ['Stop, poteau.']);
  mock.timers.reset();
});

test('voix : une alerte remplace une phrase qui attend encore le micro', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  const releases = [];
  v.beforeSpeak = () => new Promise((r) => releases.push(r));
  v.say('Information.', { priority: 1 });
  await run(50);
  v.say('Stop, poteau.', { priority: 3 });
  await run(50);
  releases.forEach((r) => r());
  await run(50);
  releases.forEach((r) => r());
  await run(1500);
  assert.deepEqual(synth.spoken, ['Stop, poteau.']);
  mock.timers.reset();
});

test('voix : stop() avant une écoute abandonne aussi la phrase qui attend le micro', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  let release;
  v.beforeSpeak = () => new Promise((r) => (release = r));
  const said = v.say('Je cherche.', { priority: 2 });
  await run(50);
  v.stop();
  await said; // la promesse est résolue tout de suite
  release();
  await run(1500);
  assert.deepEqual(synth.spoken, []);
  assert.equal(v.speaking, false);
  mock.timers.reset();
});

test('voix : une alerte coupe une phrase en cours (comportement v2 conservé)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  v.say('Vous êtes près de la mairie.', { priority: 2 });
  await run(100);
  v.say('Stop, poteau.', { priority: 3 });
  await run(2000);
  assert.deepEqual(synth.spoken, ['Stop, poteau.']);
  mock.timers.reset();
});

test('mains libres : release() coupe l’écoute et attend sa fin réelle (400 ms au plus)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const recs = [];
  globalThis.window = {
    webkitSpeechRecognition: class {
      constructor() { recs.push(this); }
      start() {}
      abort() { this.aborted = true; setTimeout(() => this.onend?.(), 120); }
    },
  };
  const { WakeWord } = await import('../js/wake.js?' + Math.random());
  const w = new WakeWord({});
  w.start();
  let done = false;
  w.release(400).then(() => (done = true));
  await run(100);
  assert.equal(recs[0].aborted, true);
  assert.equal(done, false, 'pas encore libéré');
  await run(40);
  assert.equal(done, true, 'libéré dès la fin réelle de l’écoute');
  // Écoute qui ne signale jamais sa fin : on parle quand même après 400 ms
  w.unblock('x');
  await run(600);
  recs[recs.length - 1].abort = function () { this.aborted = true; };
  done = false;
  w.release(400).then(() => (done = true));
  await run(390);
  assert.equal(done, false);
  await run(20);
  assert.equal(done, true);
  assert.equal(await new WakeWord({}).release().then(() => 'ok'), 'ok', 'sans écoute : immédiat');
  w.stop();
  mock.timers.reset();
});
