// Tests de la synthèse vocale avec un faux moteur Chrome (voix muette sur Android, v2.2-0).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

/** Faux speechSynthesis : `stuck` = le moteur accepte les phrases mais ne parle jamais. */
class FakeSynth extends EventTarget {
  constructor() {
    super();
    this.spoken = [];
    this.calls = [];
    this.stuck = 0; // nombre de phrases qui resteront bloquées
    this.speaking = false;
    this.pending = false;
    this.paused = false;
    this.current = null;
  }
  getVoices() {
    return [{ name: 'Français France', lang: 'fr-FR', localService: true, voiceURI: 'fr-fr' }];
  }
  speak(u) {
    this.calls.push({ text: u.text, voice: u.voice?.name || null });
    this.speaking = true;
    if (this.stuck > 0) {
      this.stuck--;
      this.current = u; // ne démarre jamais
      return;
    }
    this.current = u;
    setTimeout(() => {
      if (this.current !== u) return;
      u.onstart?.();
      setTimeout(() => {
        if (this.current !== u) return;
        this.spoken.push(u.text);
        this.current = null;
        this.speaking = false;
        u.onend?.();
      }, 500);
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
async function load() {
  synth = new FakeSynth();
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

test('voix : moteur Chrome bloqué → relancé (cancel) et phrase redite avec le moteur par défaut', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  const recovered = [];
  const errors = [];
  v.onrecover = (code) => recovered.push(code);
  v.onerror = (code) => errors.push(code);
  synth.stuck = 1;
  v.say('Poteau, droite.', { priority: 2 });
  v.say('Virage à gauche.', { priority: 2 });
  await run(6000);
  assert.deepEqual(synth.spoken, ['Poteau, droite.', 'Virage à gauche.']);
  assert.deepEqual(recovered, ['no-start']);
  assert.deepEqual(errors, [], 'pas d’alerte « voix muette » quand le nouvel essai réussit');
  const speaks = synth.calls.filter((c) => c.text === 'Poteau, droite.');
  assert.deepEqual(speaks.map((c) => c.voice), ['Français France', null], 'nouvel essai sans voix imposée');
  assert.ok(synth.calls.some((c) => c.cancel));
  mock.timers.reset();
});

test('voix : moteur muet deux fois → échec signalé, la file continue', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  const errors = [];
  v.onerror = (code, text) => errors.push([code, text]);
  synth.stuck = 2;
  v.say('Un.', { priority: 2 });
  v.say('Deux.', { priority: 2 });
  await run(9000);
  assert.deepEqual(errors, [['no-start', 'Un.']]);
  assert.deepEqual(synth.spoken, ['Deux.']);
  assert.equal(v.failures, 1);
  mock.timers.reset();
});

test('voix : moteur en pause (arrière-plan) → resume avant de parler', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const v = await load();
  synth.paused = true;
  v.say('Bonjour.', { priority: 2 });
  await run(1000);
  assert.ok(synth.calls[0].resume);
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
