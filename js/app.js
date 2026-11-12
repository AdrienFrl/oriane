// ORIANE — application : interface, commandes vocales et liaison des modules.

import { Voice, listen, hasRecognition } from './speech.js';
import { SpatialAudio } from './audio.js';
import { geocode, reverse, route, landmarks, cleanQuery } from './geo.js';
import { Navigator } from './nav.js';
import { SimWalker } from './sim.js';
import { Vision, dirPhrase } from './vision.js';
import { DepthSensor } from './depth.js';
import { store, haversine, fmtDist, norm, angleDiff } from './util.js';

const $ = (s) => document.querySelector(s);

const DEFAULTS = {
  orsKey: '',
  sim: false,
  simMult: 1,
  voiceRate: 1.05,
  objSpeech: 'important',
  announceRange: 8,
  beeps: true,
  beepRange: 6,
  hrtf: true,
  depth: false,
  camHeight: 1.3,
  fov: 66,
  calib: 1,
  modelBase: 'lite_mobilenet_v2',
  showVideo: true,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };

const state = {
  results: [],
  resIdx: 0,
  awaiting: null,
  lastPos: null,
  watchId: null,
  dest: null,
  rerouting: false,
  listening: false,
  listenTok: 0,
};

// ---------------- Journal et statut ----------------

function log(msg) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString('fr-FR')} — ${msg}`;
  const ol = $('#log');
  ol.prepend(li);
  while (ol.children.length > 150) ol.lastChild.remove();
  console.log('[ORIANE]', msg);
}
const setStatus = (t) => ($('#status').textContent = t);

// ---------------- Voix et sons ----------------

const voice = new Voice();
const audio = new SpatialAudio();
voice.onsay = (t) => log('🔊 ' + t);
voice.onstate = (speaking) => audio.setDuck(speaking);
const say = (t, o) => voice.say(t, o);

// ---------------- Orientation du téléphone (boussole, inclinaison) ----------------

let compass = null;
let beta = null;
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
  if (h != null) {
    h = (h + (screen.orientation?.angle || 0)) % 360;
    compass = compass == null ? h : (compass + angleDiff(compass, h) * 0.3 + 360) % 360;
  }
  if (e.beta != null) beta = e.beta;
}
window.addEventListener('deviceorientationabsolute', onOrient);
window.addEventListener('deviceorientation', onOrient);
/** Inclinaison vers le bas (degrés) en tenant le téléphone verticalement. */
const getPitch = () => (beta == null ? null : Math.max(-20, Math.min(70, 90 - beta)));

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
    lat: p.coords.latitude,
    lon: p.coords.longitude,
    accuracy: p.coords.accuracy,
    heading: p.coords.heading,
    speed: p.coords.speed,
    t: Date.now(),
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
  say('Je calcule l’itinéraire.', { priority: 2 });
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
  $('#navPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  setStatus('Prêt');
  releaseWakeLockIfIdle();
}

function renderNav(u) {
  $('#navInstr').textContent = u.instr;
  $('#navInstr').classList.toggle('warn', !!u.offRoute);
  $('#navMeta').textContent = u.arrived ? '' : `Reste ${fmtDist(u.remaining)} sur ${fmtDist(u.total)}`;
  $('#navProgress').value = u.total ? (u.total - u.remaining) / u.total : 0;
}

// ---------------- Recherche de destination ----------------

async function searchDestination(text) {
  const q = cleanQuery(text);
  if (!q) return;
  await audio.init();
  setStatus('Recherche…');
  say(`Je cherche ${q}.`, { priority: 2 });
  const here = await getPositionOnce().catch(() => null);
  let res;
  try {
    res = await geocode(q, here);
  } catch (e) {
    log('Recherche : ' + e.message);
    say('La recherche d’adresse ne répond pas. Réessayez dans un instant.', { priority: 3 });
    setStatus('Recherche indisponible');
    return;
  }
  for (const r of res) r.dist = here ? haversine(here, r) : null;
  state.results = res;
  state.resIdx = 0;
  renderResults();
  if (!res.length) {
    say('Je n’ai trouvé aucun résultat. Essayez avec le nom de la ville.', { priority: 2 });
    setStatus('Aucun résultat');
    return;
  }
  setStatus(`${res.length} résultat(s)`);
  proposeResult();
}

function renderResults() {
  const ol = $('#results');
  ol.innerHTML = '';
  state.results.forEach((r, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'result';
    b.innerHTML = `<span class="r-label"></span><span class="r-dist"></span>`;
    b.querySelector('.r-label').textContent = r.label;
    b.querySelector('.r-dist').textContent = r.dist != null ? `à ${fmtDist(r.dist)}` : '';
    b.setAttribute('aria-label', `Y aller : ${r.label}${r.dist != null ? ', à ' + fmtDist(r.dist) : ''}`);
    b.addEventListener('click', () => startNavigation(state.results[i]));
    li.appendChild(b);
    ol.appendChild(li);
  });
}

async function proposeResult() {
  const r = state.results[state.resIdx];
  if (!r) {
    state.awaiting = null;
    say('Il n’y a pas d’autre résultat. Redites la destination, en précisant la ville.', { priority: 2 });
    return;
  }
  state.awaiting = 'confirm';
  const intro = state.resIdx === 0 ? 'J’ai trouvé' : 'Résultat suivant';
  const dist = r.dist != null ? `, à ${fmtDist(r.dist)} à vol d’oiseau` : '';
  await say(`${intro} : ${r.label}${dist}. Dites oui pour partir, ou non pour le résultat suivant.`, { priority: 2 });
  if (state.awaiting === 'confirm' && hasRecognition) doListen(false);
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
  }
  if (tok !== state.listenTok) return; // l'utilisateur a agi autrement entre-temps
  if (!alts.length) {
    if (withChime) say('Je n’ai rien entendu.', { priority: 2 });
    return;
  }
  log('🎙 Entendu : ' + alts[0]);
  handleUtterance(alts[0]);
}

function handleUtterance(text) {
  const t = norm(text);
  const short = t.split(/\s+/).length <= 7;

  if (state.awaiting === 'confirm') {
    if (/^(oui|ouais|ok|okay|d'accord|vas[- ]y|go|on y va|parfait|c'est ca|confirme|allons[- ]y)\b/.test(t)) {
      return startNavigation(state.results[state.resIdx]);
    }
    if (/^(non|suivant|autre|pas celui)/.test(t)) {
      state.resIdx++;
      return proposeResult();
    }
    if (/^(annule|stop|laisse tomber)/.test(t)) {
      state.awaiting = null;
      return say('Recherche annulée.', { priority: 2 });
    }
    state.awaiting = null;
  }

  if (short) {
    if (/(repete|redis|repeter)/.test(t)) return nav.repeat();
    if (/(ou suis[- ]je|ou je suis|ou est[- ]ce que je suis|ma position)/.test(t)) return whereAmI();
    if (/(distance|combien|reste[- ]t[- ]il|il reste)/.test(t)) return say(nav.remainingText(), { priority: 2 });
    if (/(devant|qu'est[- ]ce qu'il y a|qu'y a[- ]t[- ]il|decris|autour)/.test(t)) return describe();
    if (/(active|lance|demarre|allume).*(camera|detection)/.test(t)) return startVision();
    if (/(coupe|desactive|arrete|eteins).*(camera|detection)/.test(t)) return stopVision();
    if (/(arrete|stop|termine|annule).*(guidage|navigation|itineraire)?$/.test(t) && nav.active) return stopGuidance();
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
  say(vision.describe(), { priority: 2, interrupt: true });
}

function help() {
  say(
    'Appuyez sur le bouton Parler, puis dites une adresse, par exemple : 18 rue de Metz à Toulouse. ' +
      'Pendant le guidage, vous pouvez dire : répète, où suis-je, distance restante, qu’y a-t-il devant moi, ' +
      'active la détection, ou arrête le guidage.',
    { priority: 2, interrupt: true }
  );
}

// ---------------- Vision et obstacles ----------------

let objObs = [];
let depthObs = [];

function pushObstacles() {
  const merged = [...objObs];
  for (const d of depthObs) {
    const dup = objObs.some(
      (o) => Math.abs(o.angle - d.angle) < 10 && Math.abs(o.distance - d.distance) < Math.max(1, d.distance * 0.35)
    );
    if (!dup) merged.push(d);
  }
  audio.update(settings.beeps ? merged : []);
  const ul = $('#obstacles');
  ul.innerHTML = '';
  merged
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6)
    .forEach((o) => {
      const li = document.createElement('li');
      li.textContent = `${o.label} · ${dirPhrase(o.angle)} · ${o.distance.toFixed(1).replace('.', ',')} m`;
      if (o.distance < 2) li.className = 'close';
      ul.appendChild(li);
    });
}

const vision = new Vision({
  video: $('#video'),
  canvas: $('#overlay'),
  say,
  log,
  settings,
  onObstacles: (o) => {
    objObs = o;
    pushObstacles();
  },
  onStatus: (t) => ($('#visionStatus').textContent = t),
});

const depth = new DepthSensor({
  video: $('#video'),
  log,
  settings,
  getPitch,
  onObstacles: (o) => {
    depthObs = o;
    pushObstacles();
  },
  onStatus: (t) => ($('#visionStatus').textContent = t),
});

async function startVision() {
  if (vision.running) return;
  await audio.init();
  $('#camWrap').hidden = !settings.showVideo;
  $('#btnCamera').disabled = true;
  try {
    await vision.start();
    $('#btnCamera').textContent = 'Couper la détection';
    $('#btnCamera').setAttribute('aria-pressed', 'true');
    say('Détection activée. Tenez le téléphone devant vous, caméra vers l’avant.', { priority: 2 });
    if (settings.depth) startDepth();
    requestWakeLock();
    requestOrientationPermission();
  } catch (e) {
    log('Caméra : ' + e.message);
    say(`Impossible d’activer la caméra : ${e.message}.`, { priority: 3 });
    $('#camWrap').hidden = true;
    $('#visionStatus').textContent = 'Caméra indisponible';
  } finally {
    $('#btnCamera').disabled = false;
  }
}

function startDepth() {
  depth.start().catch((e) => {
    log('Profondeur indisponible : ' + e.message);
    depth.stop();
  });
}

function stopVision() {
  if (!vision.running) return;
  depth.stop();
  vision.stop();
  objObs = [];
  depthObs = [];
  pushObstacles();
  $('#camWrap').hidden = true;
  $('#btnCamera').textContent = 'Activer la détection';
  $('#btnCamera').setAttribute('aria-pressed', 'false');
  say('Détection coupée.', { priority: 2 });
  releaseWakeLockIfIdle();
}

setInterval(() => {
  if (!vision.running) return;
  const parts = [`${vision.fps.toFixed(1)} images/s`];
  if (depth.running && depth.ms) parts.push(`profondeur ${Math.round(depth.ms)} ms`);
  const p = getPitch();
  if (p != null) parts.push(`inclinaison ${Math.round(p)}°`);
  $('#visionStatus').textContent = 'Détection active · ' + parts.join(' · ');
}, 1000);

// ---------------- Écran allumé, capteurs ----------------

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* refusé : l'écran pourra s'éteindre */
  }
}
function releaseWakeLockIfIdle() {
  if (!nav.active && !vision.running && wakeLock) wakeLock.release().catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (nav.active || vision.running)) requestWakeLock();
});

async function requestOrientationPermission() {
  // iOS uniquement ; sur Android la boussole est disponible sans demande.
  try {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
  } catch {
    /* ignoré */
  }
}

// ---------------- Réglages ----------------

function applySettings() {
  voice.rate = settings.voiceRate;
  audio.range = settings.beepRange;
  if (audio.hrtf !== settings.hrtf) audio.setHrtf(settings.hrtf);
  sim.mult = settings.simMult;
  $('#camWrap').hidden = !(vision.running && settings.showVideo);
  for (const el of document.querySelectorAll('[data-out]')) {
    const v = settings[el.dataset.out];
    el.textContent = typeof v === 'number' ? String(v).replace('.', ',') : v;
  }
}

function bindSettings() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const k = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = settings[k];
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      const prevDepth = settings.depth;
      const prevModel = settings.modelBase;
      if (el.type === 'checkbox') settings[k] = el.checked;
      else if (el.type === 'range' || el.type === 'number' || el.dataset.num !== undefined) settings[k] = Number(el.value);
      else settings[k] = el.value.trim();
      store.set('settings', settings);
      applySettings();
      if (k === 'depth' && vision.running && prevDepth !== settings.depth) settings.depth ? startDepth() : depth.stop();
      if (k === 'modelBase' && prevModel !== settings.modelBase && vision.running) {
        stopVision();
        startVision();
      }
      if (k === 'sim' && nav.active) startPositionFeed();
    });
  }
  applySettings();
}

// ---------------- Branchements ----------------

$('#btnTalk').addEventListener('click', () => doListen(true));
$('#destForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#destInput').value.trim();
  if (v) {
    state.awaiting = null;
    searchDestination(v);
  }
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
$('#btnCamera').addEventListener('click', () => (vision.running ? stopVision() : startVision()));
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
  audio.range = settings.beepRange;
  say('Test : un obstacle approche par la droite, puis par la gauche.', { priority: 2 });
  setTimeout(() => audio.testSweep(), 2500);
});
$('#btnTestVoice').addEventListener('click', async () => {
  await audio.init();
  say('Dans 20 mètres, après le feu, tournez à gauche sur la rue de Metz.', { priority: 2, interrupt: true });
});
$('#btnToggleKey').addEventListener('click', () => {
  const i = $('#orsKey');
  i.type = i.type === 'password' ? 'text' : 'password';
});

bindSettings();
setStatus('Prêt');
if (!hasRecognition) log('Reconnaissance vocale indisponible : utilisez Chrome sur Android pour la voix.');
if (!settings.orsKey) log('Pas de clé OpenRouteService : les itinéraires passeront par OSRM (FOSSGIS).');
log('ORIANE prêt.');
