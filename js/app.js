// ORIANE v2 — application : interface, commandes vocales, détection d'obstacles et guidage.
// La détection d'obstacles est indépendante du guidage : elle marche avec ou sans destination.
// v2.2-0 : capteurs et traitement des analyses en modules purs (sensors.js, pipeline.js), partagés avec
// le rejeu ; journal détaillé des alertes, compteur par minute (bêta), enregistrement et rejeu d'une marche.

import { Voice, listen, hasRecognition } from './speech.js?v=2201'; // ?v : force la nouvelle voix malgré le cache
import { SpatialAudio } from './audio.js';
import { reverse, route, landmarks } from './geo.js';
import { findPlaces } from './places.js';
import { Navigator } from './nav.js';
import { SimWalker } from './sim.js';
import { Vision } from './vision.js';
import { Perception } from './perception.js';
import { AlertManager, dirWords, PRESETS, LEVEL_KEYS, LEVEL_LABELS, VIB } from './alerts.js';
import { WakeWord } from './wake.js';
import { store, fmtDist, norm, angleDiff } from './util.js';
import { TiltFilter, MotionState } from './sensors.js';
import { IndoorDetector, processFrame } from './pipeline.js';
import { AlertCounter, formatEvent, eventsToCsv, counterStatus, summaryText, fmtDuration } from './instruments.js';
import { Recorder, parseRecording, ReplaySession, fromBase64 } from './rejeu.js';
import { FAMILY_COLORS, CLASS_FAMILY } from './classes.js';

const $ = (s) => document.querySelector(s);
const VERSION = '2.2-0.1';

const DEFAULTS = {
  orsKey: '',
  sim: false,
  simMult: 1,
  voiceRate: 1.05,
  voiceURI: '',
  wakeWord: false,
  alertRange: 3,
  corridorWidth: 1.2,
  urgentDist: 1.5,
  minGap: 2,
  vehicleRange: 10,
  profile: 'aveugle',
  levels: { ...PRESETS.aveugle },
  beeps: true,
  vibrations: true,
  hrtf: true,
  showVideo: true,
  showMask: true,
  camRes: 720,
  maxFps: 6,
  engine: 'auto',
  camHeight: 1.3,
  fov: 66,
  calib: 1,
  // outils de test (v2.2-0)
  alertCounter: true, // H1 : compteur d'alertes par minute (bêta, actif par défaut)
  logDetail: false, // journal : noter aussi les alertes retenues
  recording: false, // H3 : enregistrement et rejeu de marches (activable)
  recImages: true, // garder l'image 224 px de chaque analyse dans l'enregistrement
  // secours COCO-SSD (v1)
  objSpeech: 'important',
  modelBase: 'lite_mobilenet_v2',
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
// v2.1 : réglages issus du questionnaire de priorisation (remplacent ceux de la v2)
if ((settings.settingsVersion || 0) < 21) {
  Object.assign(settings, { alertRange: 3, corridorWidth: 1.2, urgentDist: 1.5, minGap: 2, vehicleRange: 10, profile: 'aveugle', levels: { ...PRESETS.aveugle }, settingsVersion: 21 });
  store.set('settings', settings);
}
// v2.2-0.1 : retour à la voix Google de Chrome par défaut (une voix choisie à la main a pu rendre l'appli muette)
if ((settings.settingsVersion || 0) < 22) {
  Object.assign(settings, { voiceURI: '', settingsVersion: 22 });
  store.set('settings', settings);
}
settings.levels = { ...PRESETS.aveugle, ...(settings.levels || {}) };
settings.announceRange = settings.alertRange; // utilisé par le détecteur de secours

const state = {
  results: [],
  page: 0,
  awaiting: null,
  lastPos: null,
  watchId: null,
  dest: null,
  rerouting: false,
  listening: false,
  listenTok: 0,
};

// ---------------- Journal ----------------

const logLines = [];
function log(msg) {
  const time = new Date().toLocaleTimeString('fr-FR');
  logLines.push(`${new Date().toISOString()};${msg.replace(/;/g, ',')}`);
  if (logLines.length > 2000) logLines.shift();
  const li = document.createElement('li');
  li.textContent = `${time} — ${msg}`;
  const ol = $('#log');
  ol.prepend(li);
  while (ol.children.length > 150) ol.lastChild.remove();
  console.log('[ORIANE]', msg);
}
const setStatus = (t) => ($('#status').textContent = t);

// Journal détaillé des alertes (lot 2.2-0) : toutes les décisions, exportables en CSV
const alertEvents = [];
const wallTime = (t) => new Date(performance.timeOrigin + t).toISOString();
function logEvents(events, prefix = '') {
  for (const e of events) {
    if (!e.emitted && !settings.logDetail) continue;
    log(prefix + formatEvent(e));
  }
}
function downloadText(text, name, type = 'text/csv;charset=utf-8') {
  downloadBlob(new Blob([text], { type }), name);
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(':', 'h').replace('T', '-');

// ---------------- Voix, sons, vibrations ----------------

const voice = new Voice();
const audio = new SpatialAudio();
voice.onsay = (t) => log('🔊 ' + t);
voice.setPreferred(settings.voiceURI);
let voiceWarned = false;
voice.onrecover = (code, text) => {
  log(`🔁 Voix « ${voice.voice?.name} » en erreur (${code}) : phrase redite avec la voix de Chrome : « ${text.slice(0, 60)} »`);
};
voice.onerror = (code, text) => {
  log(`⚠️ Voix muette (${code}) pour : « ${text.slice(0, 60)} » [${voice.engineState()}, voix ${voice.voice?.name || 'de Chrome'}, mains libres ${wake.active ? 'oui' : 'non'}]`);
  const box = $('#voiceWarn');
  box.hidden = false;
  if (!voiceWarned) {
    voiceWarned = true;
    vibrate([300, 150, 300, 150, 300]);
  }
};
function fillVoices() {
  const sel = $('#voiceSel');
  const keep = settings.voiceURI;
  sel.innerHTML = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  add('', 'Automatique : voix Google de Chrome (recommandé)');
  add('system', 'Voix française par défaut de Chrome, sans choisir');
  for (const v of voice.frenchVoices) add(v.voiceURI, `${v.name} — ${v.lang}${v.localService ? '' : ' (en ligne)'}`);
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  renderVoiceDiag();
}
function renderVoiceDiag() {
  const d = voice.diagnose();
  $('#voiceDiag').textContent = !d.supported
    ? 'Synthèse vocale absente de ce navigateur.'
    : (d.total
      ? `${d.total} voix listées par Chrome, dont ${d.french.length} en français. Voix utilisée : ${d.chosen}.`
      : 'Chrome ne liste aucune voix : c’est courant sur Android, ORIANE parle avec la voix française par défaut de Chrome.') +
      (d.failures ? ` Échecs : ${d.failures}.` : '') + (d.recoveries ? ` Moteur relancé : ${d.recoveries} fois.` : '');
}
voice.onvoices = fillVoices;
const say = (t, o) => voice.say(t, o);
// Chrome sur Android n'autorise la voix qu'après un geste : on la déverrouille au premier appui.
document.addEventListener('pointerdown', () => voice.unlock(), { once: true, capture: true });
function vibrate(pattern) {
  if (settings.vibrations && navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* non pris en charge */
    }
  }
}

// ---------------- Mot d'activation « Dis Oriane » ----------------

const wake = new WakeWord({
  log,
  onWake: (rest) => {
    audio.chime('listen');
    vibrate(VIB.confirm);
    if (rest && rest.length > 1) handleUtterance(rest);
    else doListen(false);
  },
  onError: (why) => {
    log('Mains libres : ' + why);
    $('#wakeHint').textContent = 'Micro refusé : autorisez le micro dans Chrome pour utiliser « Dis Oriane ».';
  },
});
voice.onstate = (speaking) => {
  audio.setDuck(speaking);
  if (speaking) wake.block('tts');
  else wake.unblock('tts');
};
// Mains libres : la voix attend que le micro soit libéré (400 ms au plus).
voice.beforeSpeak = () => wake.release(400);
// Retour sur la page : Chrome peut avoir mis la voix en pause en arrière-plan.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && voice.supported && speechSynthesis.paused) speechSynthesis.resume();
});

// ---------------- Orientation du téléphone ----------------

let compass = null;
const tilt = new TiltFilter();
const motion = new MotionState();
let recorder = null; // enregistrement d'une marche en cours
function onOrient(e) {
  recorder?.orientation(performance.now(), e);
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
  if (h != null) {
    h = (h + (screen.orientation?.angle || 0)) % 360;
    compass = compass == null ? h : (compass + angleDiff(compass, h) * 0.3 + 360) % 360;
  }
  tilt.onOrientation(e.beta); // lissage v2.1, inchangé (remplacé au lot 2.2-1)
}
window.addEventListener('deviceorientationabsolute', onOrient);
window.addEventListener('deviceorientation', onOrient);
// Marche ou immobile : secousses de l'accéléromètre (pas) ou vitesse GPS
window.addEventListener('devicemotion', (e) => {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const t = performance.now();
  recorder?.motion(t, e);
  motion.onMotion(t, a.x, a.y, a.z);
});
const isMoving = () => motion.isMoving(performance.now());
/** Inclinaison de la caméra vers le bas, en degrés (téléphone tenu verticalement). */
const getPitch = () => tilt.pitch();
/** Toute position reçue (GPS ou simulée) : vitesse pour « en marche », et enregistrement. */
function feedPosition(pos) {
  const t = performance.now();
  motion.onGps(t, pos.speed);
  recorder?.gps(t, pos);
}

// ---------------- Guidage ----------------

const nav = new Navigator({
  say,
  chime: (k) => audio.chime(k),
  log,
  onUpdate: renderNav,
  onReroute: reroute,
  onArrive: () => {
    stopPositionFeed();
    setStatus('Arrivé');
  },
});
const sim = new SimWalker({ onPos: onPosition, mult: settings.simMult });

function fromCoords(p) {
  return {
    lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy,
    heading: p.coords.heading, speed: p.coords.speed, t: Date.now(),
  };
}
function geoErr(e) {
  return { 1: 'autorisation refusée', 2: 'position introuvable', 3: 'délai dépassé' }[e.code] || e.message;
}
function getPositionOnce() {
  return new Promise((res, rej) => {
    if (state.lastPos && Date.now() - state.lastPos.t < 15000) return res(state.lastPos);
    if (!navigator.geolocation) return rej(new Error('géolocalisation indisponible'));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        state.lastPos = fromCoords(p);
        feedPosition(state.lastPos);
        res(state.lastPos);
      },
      (e) => rej(new Error(geoErr(e))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  });
}
function onPosition(pos) {
  pos.t = Date.now();
  if (!pos.simulated) {
    const gpsOk = pos.heading != null && !Number.isNaN(pos.heading) && (pos.speed ?? 0) > 0.7;
    pos.heading = gpsOk ? pos.heading : compass;
  }
  state.lastPos = pos;
  feedPosition(pos);
  $('#navGps').textContent = pos.simulated
    ? 'Position simulée'
    : `GPS ± ${Math.round(pos.accuracy)} m${compass != null ? ' · boussole active' : ''}`;
  nav.update(pos);
}
function startPositionFeed() {
  stopPositionFeed();
  if (settings.sim) {
    sim.mult = settings.simMult;
    sim.run(nav.line);
    log(`Simulation de marche active (×${settings.simMult}).`);
  } else if (navigator.geolocation) {
    state.watchId = navigator.geolocation.watchPosition(
      (p) => onPosition(fromCoords(p)),
      (e) => log('GPS : ' + geoErr(e)),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }
}
function stopPositionFeed() {
  sim.stop();
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

async function startNavigation(dest) {
  state.awaiting = null;
  state.listenTok++;
  if (nav.active) stopGuidance(false);
  await audio.init();
  setStatus('Calcul de l’itinéraire…');
  say(`C’est parti pour ${dest.label.split(',')[0]}. Je calcule l’itinéraire.`, { priority: 2 });
  let here;
  try {
    here = await getPositionOnce();
  } catch (e) {
    say(`Je n’arrive pas à obtenir votre position : ${e.message}.`, { priority: 3 });
    setStatus('Position indisponible');
    return;
  }
  let rt;
  try {
    rt = await route(here, dest, settings.orsKey);
  } catch (e) {
    log('Itinéraire : ' + e.message);
    say('Impossible de calculer l’itinéraire pour le moment.', { priority: 3 });
    setStatus('Itinéraire indisponible');
    return;
  }
  if (rt.warning) log(rt.warning);
  state.dest = dest;
  $('#navDest').textContent = dest.label;
  $('#navPanel').hidden = false;
  nav.start(rt, dest);
  log(`Itinéraire ${rt.provider} : ${Math.round(nav.line.length)} m, ${nav.steps.length} changement(s) de direction.`);
  loadLandmarks(rt.pts);
  startPositionFeed();
  requestWakeLock();
  setStatus('Guidage en cours');
}
function loadLandmarks(pts) {
  landmarks(pts)
    .then((l) => nav.setLandmarks(l))
    .catch((e) => log('Repères OpenStreetMap indisponibles : ' + e.message));
}
async function reroute(pos) {
  if (state.rerouting || !state.dest) return;
  state.rerouting = true;
  try {
    const rt = await route(pos, state.dest, settings.orsKey);
    nav.start(rt, state.dest, { reroute: true });
    loadLandmarks(rt.pts);
    if (settings.sim) sim.run(nav.line);
  } catch (e) {
    log('Recalcul impossible : ' + e.message);
  } finally {
    state.rerouting = false;
  }
}
function stopGuidance(speak = true) {
  nav.stop();
  stopPositionFeed();
  $('#navPanel').hidden = true;
  state.dest = null;
  if (speak) say('Guidage arrêté.', { priority: 2 });
  setStatus(det.running ? 'Détection active' : 'Prêt');
  releaseWakeLockIfIdle();
}
function renderNav(u) {
  $('#navInstr').textContent = u.instr;
  $('#navInstr').classList.toggle('warn', !!u.offRoute);
  $('#navMeta').textContent = u.arrived ? '' : `Reste ${fmtDist(u.remaining)} sur ${fmtDist(u.total)}`;
  $('#navProgress').value = u.total ? (u.total - u.remaining) / u.total : 0;
}

// ---------------- Recherche de destination ----------------

const NUM = ['Un', 'Deux', 'Trois'];
const resultText = (r) => `${r.label}${r.dist != null ? ', à ' + fmtDist(r.dist) : ''}`;

async function searchDestination(text) {
  await audio.init();
  state.awaiting = null;
  setStatus('Recherche…');
  say('Je cherche.', { priority: 2 });
  const here = await getPositionOnce().catch(() => null);
  let found;
  try {
    found = await findPlaces(text, here);
  } catch (e) {
    log('Recherche : ' + e.message);
    say('La recherche ne répond pas. Réessayez dans un instant.', { priority: 3 });
    setStatus('Recherche indisponible');
    return;
  }
  const { req, results } = found;
  log(`Recherche : « ${req.name} »${req.city ? ' à ' + req.city : ''}${req.category ? ' (catégorie ' + req.category.label + ')' : ''} → ${results.length} résultat(s).`);
  state.results = results;
  state.page = 0;
  renderResults();
  if (!results.length) {
    say(`Je n’ai rien trouvé pour ${req.name}. Essayez en précisant la ville.`, { priority: 2 });
    setStatus('Aucun résultat');
    return;
  }
  setStatus(`${results.length} résultat(s)`);
  proposePage();
}

function renderResults() {
  const ol = $('#results');
  ol.innerHTML = '';
  state.results.forEach((r, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'result';
    b.innerHTML = '<span class="r-num"></span><span class="r-label"></span><span class="r-dist"></span>';
    b.querySelector('.r-num').textContent = i + 1;
    b.querySelector('.r-label').textContent = r.label;
    b.querySelector('.r-dist').textContent = r.dist != null ? fmtDist(r.dist) : '';
    b.setAttribute('aria-label', `Y aller : ${resultText(r)}`);
    b.addEventListener('click', () => startNavigation(state.results[i]));
    li.appendChild(b);
    ol.appendChild(li);
  });
}

async function proposePage() {
  const start = state.page;
  const items = state.results.slice(start, start + 3);
  if (!items.length) {
    state.awaiting = null;
    say('Il n’y a pas d’autre proposition. Redites la destination en précisant la ville.', { priority: 2 });
    return;
  }
  state.awaiting = 'choose';
  let text;
  if (state.results.length === 1) {
    text = `J’ai trouvé : ${resultText(items[0])}. Dites oui pour partir.`;
  } else {
    const head = start === 0 ? `J’ai trouvé ${state.results.length} lieux.` : 'Autres propositions.';
    const more = state.results.length > start + 3 ? ', ou suivant' : '';
    text = `${head} ${items.map((r, i) => `${NUM[i]} : ${resultText(r)}.`).join(' ')} Dites oui pour le premier, le numéro de votre choix${more}.`;
  }
  await say(text, { priority: 2 });
  if (state.awaiting === 'choose' && hasRecognition) doListen(false);
}

// ---------------- Commandes vocales ----------------

async function doListen(withChime = true) {
  if (state.listening) return;
  if (!hasRecognition) {
    say('La reconnaissance vocale n’est pas disponible dans ce navigateur. Utilisez Chrome sur Android.', { priority: 3 });
    $('#destInput').focus();
    return;
  }
  await audio.init();
  voice.stop();
  wake.block('listen');
  const tok = ++state.listenTok;
  state.listening = true;
  $('#btnTalk').classList.add('listening');
  $('#btnTalk').textContent = 'J’écoute…';
  if (withChime) audio.chime('listen');
  await new Promise((r) => setTimeout(r, withChime ? 250 : 100));
  let alts = [];
  try {
    alts = await listen();
  } catch (e) {
    log('Micro : ' + e.message);
    if (e.message === 'not-allowed' && withChime) say('L’accès au micro est refusé. Autorisez-le dans les réglages du navigateur.', { priority: 3 });
  } finally {
    state.listening = false;
    $('#btnTalk').classList.remove('listening');
    $('#btnTalk').textContent = 'Parler';
    wake.unblock('listen');
  }
  if (tok !== state.listenTok) return;
  if (!alts.length) {
    if (withChime) say('Je n’ai rien entendu.', { priority: 2 });
    return;
  }
  log('🎙 Entendu : ' + alts[0]);
  vibrate(VIB.confirm);
  handleUtterance(alts[0]);
}

const YES = /^(oui|ouais|ok|okay|d'accord|vas[- ]y|go|on y va|parfait|c'est parti|c'est ca|allons[- ]y|le premier|la premiere|premier|premiere|un|1)\b/;

function handleUtterance(text) {
  const t = norm(text).replace(/[.!?]+$/, '');
  const words = t.split(/\s+/).length;

  if (state.awaiting === 'choose') {
    const pick = (i) => {
      const r = state.results[state.page + i];
      if (r) startNavigation(r);
      else say('Ce numéro n’existe pas.', { priority: 2 });
    };
    if (YES.test(t)) return pick(0);
    if (/^(?:le |la )?(?:deux|2|deuxieme|second|seconde)\b/.test(t)) return pick(1);
    if (/^(?:le |la )?(?:trois|3|troisieme)\b/.test(t)) return pick(2);
    if (/^(non|suivant|suivants|autres?|d'autres|pas (?:ca|celui))/.test(t)) {
      state.page += 3;
      return proposePage();
    }
    if (/^(annule|stop|laisse tomber|rien)/.test(t)) {
      state.awaiting = null;
      return say('Recherche annulée.', { priority: 2 });
    }
    state.awaiting = null;
  }

  if (words <= 8) {
    if (/^(silence|tais[- ]toi|chut|mode silencieux|moins de bruit)\b/.test(t)) return setMuted(true);
    if (/^(reprends|reprend|reprise|reprendre|fin du silence|parle a nouveau)\b/.test(t)) return setMuted(false);
    if (/(repete|redis|repeter)/.test(t)) return nav.repeat();
    if (/(ou suis[- ]je|ou je suis|ou est[- ]ce que je suis|ma position)/.test(t)) return whereAmI();
    if (/(combien|reste[- ]t[- ]il|il reste|distance restante)/.test(t)) return say(nav.remainingText(), { priority: 2 });
    if (/(devant moi|qu'est[- ]ce qu'il y a|qu'y a[- ]t[- ]il|decris|autour de moi)/.test(t)) return describe();
    if (/(lance|demarre|commence|active).*enregistrement/.test(t)) return startRecording();
    if (/(arrete|stop|termine|coupe).*enregistrement/.test(t)) return stopRecording();
    if (/(coupe|desactive|arrete|eteins|stop).*(detection|obstacle|camera)/.test(t)) return stopDetection();
    if (/(active|lance|demarre|allume|commence|mets?).*(detection|obstacle|camera)/.test(t) || /^(?:la )?detection(?: d'obstacles?)?$/.test(t)) return startDetection();
    if (/(arrete|stop|termine|annule).*(guidage|navigation|itineraire)/.test(t) || (t === 'stop' && nav.active)) return stopGuidance();
    if (/^(aide|aide[- ]moi|que puis[- ]je dire|commandes)/.test(t)) return help();
  }
  $('#destInput').value = text;
  searchDestination(text);
}

async function whereAmI() {
  try {
    const p = await getPositionOnce();
    const label = await reverse(p);
    say(label ? `Vous êtes près de ${label}.` : 'Je ne trouve pas d’adresse proche.', { priority: 2 });
  } catch (e) {
    say(`Position indisponible : ${e.message}.`, { priority: 2 });
  }
}

function describe() {
  let text = 'La détection n’est pas active. Dites : active la détection.';
  if (det.running) text = det.mode === 'scene' ? alerts.describe() : vision.describe();
  say(text, { priority: 2, interrupt: true });
}

function help() {
  say(
    'Dites « Dis Oriane », ou appuyez sur Parler, puis une destination : un magasin, un lieu ou une adresse, ' +
      'par exemple Intermarché à Montauban, ou la pharmacie la plus proche. ' +
      'Vous pouvez aussi dire : active la détection, qu’y a-t-il devant moi, silence, reprends, répète, où suis-je, ' +
      'distance restante, arrête la détection, ou arrête le guidage.',
    { priority: 2, interrupt: true }
  );
}

// ---------------- Détection d'obstacles (indépendante du guidage) ----------------

const det = { running: false, mode: null, stream: null, tiltSince: null, lastTiltWarn: -Infinity, indoor: false, muted: false };
const alerts = new AlertManager(settings);
const counter = new AlertCounter();
/** Environnement du traitement des analyses, le même qu'au rejeu (pipeline.js). */
const env = { settings, alerts, indoor: new IndoorDetector(), counter };

const perception = new Perception({
  video: $('#video'),
  maskCanvas: $('#mask'),
  overlay: $('#overlay'),
  settings,
  getPitch,
  log,
  onStatus: (t) => ($('#visionStatus').textContent = t),
  onResult: onPerception,
});

const vision = new Vision({
  video: $('#video'),
  canvas: $('#overlay'),
  say,
  log,
  settings,
  onObstacles: (o) => {
    audio.update(settings.beeps ? o : []);
    renderObstacles(o.map((x) => ({ label: x.label, angle: x.angle, distance: x.distance, inZone: x.distance <= settings.alertRange })));
  },
  onStatus: (t) => ($('#visionStatus').textContent = t),
});

function onPerception(msg) {
  if (replay.session) return; // pas de détection réelle pendant un rejeu
  const t = performance.now();
  const ctx = { t, moving: isMoving(), navActive: nav.active, muted: det.muted };
  const p = processFrame(env, msg, ctx);
  det.indoor = env.indoor.indoor;
  if (p.indoorChanged) log(det.indoor ? 'Mode intérieur (murs signalés seulement droit devant).' : 'Mode extérieur.');
  for (const e of p.r.events) alertEvents.push({ ...e, wall: wallTime(e.t) });
  if (alertEvents.length > 5000) alertEvents.splice(0, alertEvents.length - 5000);
  logEvents(p.r.events);
  if (recorder) {
    recorder.frame(msg, t, ctx);
    recorder.live(p.r.events);
    if (recorder.full) stopRecording('durée maximale atteinte');
  }
  emitOutputs(p.r);
  if (settings.showVideo) perception.drawOverlay(p.r.tracks, p.curb);
  checkTilt();
}

/** Sons, voix et vibrations d'une analyse (direct ou rejeu en temps réel). */
function emitOutputs(r) {
  audio.update(settings.beeps ? r.beeps : []);
  if (settings.beeps) for (const p of r.pings) audio.ping(p);
  for (const s of r.speech) say(s.text, { priority: s.priority, key: s.key });
  if (r.vibrate) vibrate(r.vibrate);
  renderObstacles(r.tracks.filter((tr) => tr.misses === 0));
}

function setMuted(on) {
  det.muted = on;
  vibrate(VIB.confirm);
  $('#muteState').hidden = !on;
  say(on ? 'Silence. Je préviens seulement des dangers. Pour reprendre, dites : Dis Oriane, reprends.' : 'Alertes reprises.', { priority: 2, interrupt: true });
}

function checkTilt() {
  const p = getPitch();
  const now = Date.now();
  if (p == null || (p > -10 && p < 65)) {
    det.tiltSince = null;
    return;
  }
  if (det.tiltSince == null) det.tiltSince = now;
  else if (now - det.tiltSince > 3000 && now - det.lastTiltWarn > 20000) {
    det.lastTiltWarn = now;
    say(p >= 65 ? 'Redressez le téléphone : la caméra regarde le sol.' : 'Inclinez légèrement le téléphone vers le sol devant vous.', { priority: 2, key: 'quality' });
  }
}

function renderObstacles(list) {
  const ul = $('#obstacles');
  ul.innerHTML = '';
  list
    .slice()
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6)
    .forEach((o) => {
      const li = document.createElement('li');
      li.textContent = `${o.label} · ${dirWords(o.angle)} · ${o.distance.toFixed(1).replace('.', ',')} m${o.inZone ? ' · alerte' : ''}`;
      if (o.distance < 1.5) li.className = 'close';
      else if (o.inZone) li.className = 'zone';
      ul.appendChild(li);
    });
}

async function openCamera() {
  if (det.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('caméra non disponible dans ce navigateur');
  const res = Number(settings.camRes) || 720;
  const w = res === 480 ? 854 : 1280;
  det.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: w, max: w },
      height: { ideal: res, max: res },
      frameRate: { ideal: 24, max: 30 },
    },
    audio: false,
  });
  const v = $('#video');
  v.srcObject = det.stream;
  await v.play();
  const tr = det.stream.getVideoTracks()[0];
  const st = tr?.getSettings?.() || {};
  log(`Caméra : ${st.width || v.videoWidth} × ${st.height || v.videoHeight}, ${st.frameRate ? Math.round(st.frameRate) + ' images/s' : ''}`);
}
function closeCamera() {
  det.stream?.getTracks().forEach((t) => t.stop());
  det.stream = null;
  $('#video').srcObject = null;
}

async function startDetection() {
  if (det.running) return say('La détection est déjà active.', { priority: 2 });
  await audio.init();
  $('#btnCamera').disabled = true;
  $('#camWrap').hidden = !settings.showVideo;
  try {
    await openCamera();
  } catch (e) {
    log('Caméra : ' + e.message);
    say(`Impossible d’activer la caméra : ${e.message}.`, { priority: 3 });
    $('#camWrap').hidden = true;
    $('#btnCamera').disabled = false;
    return;
  }
  det.running = true;
  alerts.reset();
  counter.reset();
  say('Chargement de la détection.', { priority: 2 });
  det.mode = settings.engine === 'coco' ? 'coco' : 'scene';
  if (det.mode === 'scene') {
    try {
      await perception.start();
    } catch (e) {
      log('Modèle de scène indisponible : ' + e.message);
      say('Le modèle de scène n’a pas pu se charger. J’utilise le détecteur simplifié.', { priority: 2 });
      det.mode = 'coco';
    }
  }
  if (!det.running) return; // arrêtée pendant le chargement
  if (det.mode === 'coco') {
    try {
      await vision.start();
    } catch (e) {
      log('Détecteur simplifié : ' + e.message);
      say('La détection n’a pas pu démarrer.', { priority: 3 });
      stopDetection(false);
      return;
    }
  }
  $('#btnCamera').disabled = false;
  $('#btnCamera').textContent = 'Couper la détection';
  $('#btnCamera').setAttribute('aria-pressed', 'true');
  say(`Détection activée. Je préviens des obstacles à moins de ${String(settings.alertRange).replace('.', ',')} mètres devant vous.`, { priority: 2 });
  setStatus(nav.active ? 'Guidage et détection' : 'Détection active');
  requestWakeLock();
  requestOrientationPermission();
}

function stopDetection(speak = true) {
  if (!det.running && !det.stream) return;
  det.running = false;
  if (recorder) stopRecording('détection coupée');
  perception.stop();
  if (vision.running) vision.stop();
  closeCamera();
  audio.update([]);
  renderObstacles([]);
  $('#camWrap').hidden = true;
  $('#btnCamera').disabled = false;
  $('#btnCamera').textContent = 'Activer la détection';
  $('#btnCamera').setAttribute('aria-pressed', 'false');
  $('#visionStatus').textContent = 'Caméra inactive';
  if (speak) say('Détection coupée.', { priority: 2 });
  setStatus(nav.active ? 'Guidage en cours' : 'Prêt');
  releaseWakeLockIfIdle();
}

setInterval(() => {
  if (replay.session) {
    $('#visionStatus').textContent = `Rejeu · ${replay.session.fi} / ${replay.session.frames.length} analyses` +
      (settings.alertCounter ? ' · ' + counterStatus(replay.session.counter, replay.session.counter.lastT ?? 0) : '');
    return;
  }
  if (!det.running) return;
  const parts = [];
  if (det.mode === 'scene') {
    const s = perception.stats;
    parts.push(perception.device === 'webgpu' ? 'Scène · WebGPU' : perception.device === 'wasm' ? 'Scène · processeur' : 'Scène · chargement');
    if (s.fps) parts.push(`${s.fps.toFixed(1)} analyses/s`, `modèle ${Math.round(s.inferMs)} ms`, `image → alerte ${Math.round(s.latencyMs)} ms`);
  } else {
    parts.push('Détecteur simplifié', `${vision.fps.toFixed(1)} images/s`);
  }
  const p = getPitch();
  if (p != null) parts.push(`inclinaison ${Math.round(p)}°`);
  parts.push(isMoving() ? 'en marche' : 'immobile (silence sauf danger)');
  if (det.mode === 'scene') parts.push(det.indoor ? 'intérieur' : 'extérieur');
  if (det.muted) parts.push('SILENCE');
  if (settings.alertCounter) parts.push(counterStatus(counter, performance.now()));
  if (recorder) parts.push(`● ENREGISTREMENT ${fmtDuration(recorder.durationMs)}`);
  $('#visionStatus').textContent = parts.join(' · ');
  if (recorder) $('#recState').textContent = `Enregistrement en cours : ${fmtDuration(recorder.durationMs)}, ${recorder.frameCount} analyses.`;
}, 1000);

// ---------------- Enregistrement d'une marche (H3, FON-40) ----------------
// Images 224 px, cartes de segmentation et capteurs, dans un fichier téléchargé sur le téléphone.
// Rien n'est envoyé à un serveur.

async function startRecording() {
  if (!settings.recording) return say('Activez d’abord l’enregistrement dans Outils de test.', { priority: 2 });
  if (recorder) return say('L’enregistrement est déjà en cours.', { priority: 2 });
  if (replay.session) stopReplay();
  if (!det.running) await startDetection();
  if (!det.running || det.mode !== 'scene') {
    say('L’enregistrement demande la détection de scène complète.', { priority: 2 });
    return;
  }
  recorder = new Recorder({
    now: performance.now(), appVersion: VERSION, settings, images: settings.recImages, device: navigator.userAgent,
  });
  perception.record = settings.recImages;
  vibrate(VIB.confirm);
  $('#btnRec').textContent = 'Arrêter et enregistrer le fichier';
  $('#btnRec').setAttribute('aria-pressed', 'true');
  log('● Enregistrement démarré.');
  say('Enregistrement démarré.', { priority: 2 });
}

async function stopRecording(why = '') {
  const rec = recorder;
  if (!rec) return;
  recorder = null;
  perception.record = false;
  $('#btnRec').textContent = 'Enregistrer une marche';
  $('#btnRec').setAttribute('aria-pressed', 'false');
  const blob = await rec.toBlob();
  const name = `oriane-rejeu-${stamp()}.json.gz`;
  downloadBlob(blob, name);
  const text = `Enregistrement terminé${why ? ' (' + why + ')' : ''} : ${fmtDuration(rec.durationMs)}, ${rec.frameCount} analyses, ${blob.size < 1e6 ? Math.ceil(blob.size / 1e3) + ' Ko' : (blob.size / 1e6).toFixed(1).replace('.', ',') + ' Mo'}. Fichier ${name}.`;
  $('#recState').textContent = text;
  log('■ ' + text);
  vibrate(VIB.confirm);
  say(`Enregistrement terminé, ${fmtDuration(rec.durationMs)}. Fichier téléchargé.`, { priority: 2 });
}

// ---------------- Rejeu d'une marche ----------------

const replay = { rec: null, session: null, timer: null, events: [], name: '' };

async function loadReplayFile(file) {
  try {
    replay.rec = await parseRecording(await file.arrayBuffer());
    replay.name = file.name;
    const r = replay.rec;
    const info = `${file.name} : ORIANE ${r.appVersion || '?'}, ${fmtDuration(r.durationMs || 0)}, ${r.frames.length} analyses, ` +
      `${r.frames.some((f) => f.jpeg) ? 'avec' : 'sans'} images, ${(r.live || []).length} alertes en direct.`;
    $('#replayInfo').textContent = info;
    log('Rejeu chargé : ' + info);
    $('#btnReplayRun').disabled = false;
    $('#btnReplayPlay').disabled = false;
  } catch (e) {
    replay.rec = null;
    $('#replayInfo').textContent = 'Lecture impossible : ' + e.message;
    log('Rejeu : ' + e.message);
  }
}

/** Analyse instantanée : toutes les alertes du rejeu et le résumé, sans son. */
function runReplay() {
  if (!replay.rec) return;
  stopReplay();
  const session = new ReplaySession(replay.rec, { defaults: DEFAULTS });
  const sum = session.run();
  replay.events = session.events;
  log(`▶ Rejeu de ${replay.name} (analyse instantanée) :`);
  logEvents(session.events, '▶ ');
  const text = 'Rejeu : ' + summaryText(sum.counter) + ` Direct : ${sum.liveEmitted} alerte(s).`;
  log('▶ ' + text);
  $('#replayInfo').textContent = text;
  $('#btnReplayCsv').disabled = false;
  return sum;
}

/** Rejeu en temps réel : images, sons, voix et vibrations, comme pendant la marche. */
async function playReplay() {
  if (!replay.rec) return;
  stopReplay();
  if (det.running) stopDetection(false);
  await audio.init();
  const session = new ReplaySession(replay.rec, { defaults: DEFAULTS });
  replay.session = session;
  replay.events = session.events;
  $('#replayView').hidden = false;
  $('#btnReplayStop').disabled = false;
  log(`▶ Rejeu en temps réel de ${replay.name}.`);
  const tick = async () => {
    if (replay.session !== session) return;
    if (session.done) {
      const text = 'Rejeu terminé : ' + summaryText(session.counter.summary());
      log('▶ ' + text);
      $('#replayInfo').textContent = text;
      stopReplay();
      return;
    }
    const p = session.step();
    logEvents(p.r.events, '▶ ');
    emitOutputs(p.r);
    drawReplayFrame(p).catch(() => {});
    const next = session.nextTime;
    replay.timer = setTimeout(tick, next == null ? 0 : Math.max(0, next - p.frame.tr));
  };
  tick();
}

function stopReplay() {
  if (!replay.session) return;
  clearTimeout(replay.timer);
  replay.session = null;
  audio.update([]);
  renderObstacles([]);
  $('#btnReplayStop').disabled = true;
  $('#btnReplayCsv').disabled = !replay.events.length;
}

/** Image enregistrée + zones reconnues, dans le cadre de rejeu. */
async function drawReplayFrame({ frame, labels }) {
  const c = $('#replayView');
  const { lw, lh } = frame;
  const W = lw * 4;
  const H = lh * 4;
  if (c.width !== W) c.width = W;
  if (c.height !== H) c.height = H;
  const ctx = c.getContext('2d');
  let photo = false;
  if (frame.jpeg) {
    try {
      const bmp = await createImageBitmap(new Blob([fromBase64(frame.jpeg)], { type: 'image/jpeg' }));
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();
      photo = true;
    } catch {
      /* image illisible : zones reconnues seules */
    }
  }
  if (!photo) {
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, W, H);
  }
  if (!settings.showMask && photo) return;
  const img = new ImageData(lw, lh);
  for (let i = 0; i < labels.length; i++) {
    const col = FAMILY_COLORS[CLASS_FAMILY[labels[i]]];
    img.data.set([col[0], col[1], col[2], photo ? col[3] : 255], 4 * i);
  }
  const tmp = new OffscreenCanvas(lw, lh);
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, W, H);
}

// ---------------- Écran allumé, capteurs ----------------

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* refusé */
  }
}
function releaseWakeLockIfIdle() {
  if (!nav.active && !det.running && !settings.wakeWord && wakeLock) wakeLock.release().catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (nav.active || det.running || settings.wakeWord)) requestWakeLock();
});
async function requestOrientationPermission() {
  try {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
  } catch {
    /* ignoré */
  }
}

// ---------------- Réglages ----------------

function applySettings() {
  voice.rate = settings.voiceRate;
  audio.range = settings.alertRange;
  settings.announceRange = settings.alertRange;
  if (audio.hrtf !== settings.hrtf) audio.setHrtf(settings.hrtf);
  sim.mult = settings.simMult;
  $('#camWrap').hidden = !(det.running && settings.showVideo);
  $('#mask').hidden = !settings.showMask;
  $('#recBox').hidden = !settings.recording;
  if (!settings.showMask) {
    const c = $('#mask');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
  for (const el of document.querySelectorAll('[data-out]')) {
    const v = settings[el.dataset.out];
    el.textContent = typeof v === 'number' ? String(v).replace('.', ',') : v;
  }
}

function setWake(on) {
  if (on) {
    if (!WakeWord.supported) {
      $('#wakeHint').textContent = 'Écoute mains libres indisponible dans ce navigateur (utilisez Chrome).';
      return;
    }
    wake.start();
    requestWakeLock();
    $('#wakeHint').textContent = 'À l’écoute : dites « Dis Oriane ». L’écran doit rester allumé.';
    log('Mains libres activé : « Dis Oriane ».');
  } else {
    wake.stop();
    $('#wakeHint').textContent = 'Activez pour lancer ORIANE à la voix, sans toucher l’écran.';
    releaseWakeLockIfIdle();
  }
}

function renderLevels() {
  const box = $('#levelsBox');
  box.innerHTML = '';
  for (const [key, name] of Object.entries(LEVEL_KEYS)) {
    const row = document.createElement('div');
    row.className = 'lvlrow';
    const lab = document.createElement('label');
    lab.htmlFor = 'lvl-' + key;
    lab.textContent = name;
    const sel = document.createElement('select');
    sel.id = 'lvl-' + key;
    for (const [v, l] of Object.entries(LEVEL_LABELS)) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      sel.appendChild(o);
    }
    sel.value = settings.levels[key];
    sel.addEventListener('change', () => {
      settings.levels = { ...settings.levels, [key]: sel.value };
      store.set('settings', settings);
    });
    row.append(lab, sel);
    box.appendChild(row);
  }
}
$('#profileSel').addEventListener('change', (e) => {
  settings.profile = e.target.value;
  settings.levels = { ...PRESETS[settings.profile] };
  store.set('settings', settings);
  renderLevels();
  say(settings.profile === 'aveugle' ? 'Profil aveugle appliqué.' : 'Profil malvoyant appliqué.', { priority: 2 });
});

function bindSettings() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const k = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = settings[k];
    el.addEventListener(el.type === 'range' ? 'input' : 'change', async () => {
      const prev = settings[k];
      if (el.type === 'checkbox') settings[k] = el.checked;
      else if (el.type === 'range' || el.type === 'number' || el.dataset.num !== undefined) settings[k] = Number(el.value);
      else settings[k] = el.value.trim();
      store.set('settings', settings);
      applySettings();
      if (k === 'wakeWord') {
        await audio.init();
        setWake(settings.wakeWord);
      }
      if ((k === 'engine' || k === 'camRes') && det.running && prev !== settings[k]) {
        stopDetection(false);
        if (k === 'engine') perception.dispose();
        startDetection();
      }
      if (k === 'sim' && nav.active) startPositionFeed();
      if (k === 'recording' && !settings.recording) {
        if (recorder) stopRecording('désactivé');
        stopReplay();
      }
    });
  }
  applySettings();
}

// ---------------- Branchements ----------------

$('#btnTalk').addEventListener('click', () => doListen(true));
$('#destForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#destInput').value.trim();
  if (v) handleUtterance(v);
});
$('#btnRepeat').addEventListener('click', async () => {
  await audio.init();
  nav.repeat();
});
$('#btnStop').addEventListener('click', () => stopGuidance());
$('#btnWhere').addEventListener('click', async () => {
  await audio.init();
  whereAmI();
});
$('#btnCamera').addEventListener('click', () => (det.running ? stopDetection() : startDetection()));
$('#btnDescribe').addEventListener('click', async () => {
  await audio.init();
  describe();
});
$('#btnHelp').addEventListener('click', async () => {
  await audio.init();
  help();
});
$('#btnTestSound').addEventListener('click', async () => {
  await audio.init();
  audio.range = settings.alertRange;
  say('Test : un obstacle approche par la droite, puis par la gauche.', { priority: 2 });
  setTimeout(() => audio.testSweep(), 2500);
});
$('#btnTestVoice').addEventListener('click', async () => {
  await audio.init();
  vibrate([200]);
  say('Test de la voix. Poteau devant, 3 mètres.', { priority: 2, interrupt: true });
  const d = voice.diagnose();
  log(`Diagnostic voix : ${d.total} voix, françaises : ${d.french.join(' ; ') || 'aucune'} ; utilisée : ${d.chosen} ; ` +
    `moteur : ${d.engine} ; réussites ${d.successes}, relances ${d.recoveries}, échecs ${d.failures} ; mains libres ${wake.active ? 'oui' : 'non'}.`);
  setTimeout(renderVoiceDiag, 4500);
});
$('#voiceSel').addEventListener('change', (e) => {
  settings.voiceURI = e.target.value;
  store.set('settings', settings);
  voice.setPreferred(settings.voiceURI);
  $('#voiceWarn').hidden = true;
  voice.failures = 0;
  renderVoiceDiag();
  say('Voix changée. Poteau devant, 3 mètres.', { priority: 2, interrupt: true });
});
$('#btnVoiceHelp').addEventListener('click', () => {
  $('#voiceWarn').hidden = true;
  const r = document.querySelector('details.settings');
  if (r) r.open = true;
  $('#voiceSel').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#btnToggleKey').addEventListener('click', () => {
  const i = $('#orsKey');
  i.type = i.type === 'password' ? 'text' : 'password';
});
$('#btnExportLog').addEventListener('click', () => {
  downloadText('horodatage;message\n' + logLines.join('\n'), `oriane-journal-${stamp()}.csv`);
});
$('#btnExportAlerts').addEventListener('click', () => {
  downloadText(eventsToCsv(alertEvents, { time: (e) => e.wall }), `oriane-alertes-${stamp()}.csv`);
});
$('#btnRec').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));
$('#replayFile').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) loadReplayFile(f);
});
$('#btnReplayRun').addEventListener('click', runReplay);
$('#btnReplayPlay').addEventListener('click', playReplay);
$('#btnReplayStop').addEventListener('click', stopReplay);
$('#btnReplayCsv').addEventListener('click', () => {
  downloadText(eventsToCsv(replay.events), `oriane-alertes-rejeu-${stamp()}.csv`);
});

$('#profileSel').value = settings.profile;
renderLevels();
bindSettings();
fillVoices();
setStatus('Prêt');
log(`ORIANE ${VERSION} prêt.`);
if (!hasRecognition) log('Reconnaissance vocale indisponible : utilisez Chrome sur Android pour la voix.');
if (settings.wakeWord) {
  // Chrome peut exiger un premier geste : le mode mains libres repartira au premier appui sinon.
  setWake(true);
  document.addEventListener('pointerdown', () => audio.init(), { once: true });
}

// Accès pour les tests automatisés
window.__oriane = {
  handleUtterance, state, settings, alerts, nav, det, env, counter, alertEvents, replay,
  loadReplayFile, runReplay, playReplay, stopReplay, get recorder() { return recorder; },
};
