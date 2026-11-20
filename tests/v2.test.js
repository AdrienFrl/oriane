// Tests v2 : géométrie au sol (carte de classes synthétique) et gestionnaire d'alertes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, makeCamera, groundDistance } from '../js/geometry.js';
import { AlertManager } from '../js/alerts.js';
import { F, ADE_LABELS, CLASS_TABLE } from '../js/classes.js';

const idx = (name) => ADE_LABELS.indexOf(name);
const W = 720, H = 1280, LW = 56, LH = 72;
const cropTop = 1 - (288 * W / 224) / H;
const OPTS = { frameW: W, frameH: H, cropTop, fovDeg: 66, pitchDeg: 15, camHeight: 1.3, corridorHalf: 0.75 };
const cam = makeCamera({ ...OPTS, labelW: LW });

/** Ligne de la carte dont le bord bas est à la distance d. */
function rowAt(d) {
  let best = 0, err = Infinity;
  for (let y = 0; y <= LH; y++) {
    const e = Math.abs(groundDistance(cam, y) - d);
    if (e < err) { err = e; best = y; }
  }
  return best;
}
function scene(fill = 'sidewalk') {
  const L = new Uint8Array(LW * LH).fill(idx(fill));
  const horizon = rowAt(40);
  for (let y = 0; y < horizon; y++) for (let x = 0; x < LW; x++) L[y * LW + x] = idx('sky');
  return L;
}
function paint(L, name, x0, x1, y0, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) L[y * LW + x] = idx(name);
}

test('classes : familles des obstacles demandés', () => {
  const fam = (n) => CLASS_TABLE[idx(n)].family;
  assert.equal(fam('door'), F.PORTE);
  assert.equal(fam('windowpane'), F.VITRE);
  assert.equal(fam('wall'), F.MUR);
  assert.equal(fam('ashcan'), F.POUBELLE);
  assert.equal(fam('pole'), F.POTEAU);
  assert.equal(fam('chair'), F.MOBILIER);
  assert.equal(fam('sidewalk'), F.SOL);
  assert.equal(fam('road'), F.CHAUSSEE);
  assert.equal(ADE_LABELS.length, 150);
});

test('sol dégagé : aucun obstacle', () => {
  const r = analyze(scene(), LW, LH, OPTS);
  assert.equal(r.obstacles.length, 0);
  assert.equal(r.curb, null);
});

test('poteau à 3 m devant', () => {
  const L = scene();
  paint(L, 'pole', 26, 30, 0, rowAt(3));
  const r = analyze(L, LW, LH, OPTS);
  assert.equal(r.obstacles.length, 1);
  const o = r.obstacles[0];
  assert.equal(o.family, F.POTEAU);
  assert.equal(o.label, 'poteau');
  assert.ok(Math.abs(o.distance - 3) < 0.35, `distance ${o.distance}`);
  assert.ok(Math.abs(o.lateral) < 0.3, `latéral ${o.lateral}`);
});

test('mur à 2 m et poubelle à droite à 1,5 m', () => {
  const L = scene();
  paint(L, 'wall', 0, LW, 0, rowAt(2));
  paint(L, 'ashcan', 44, 54, rowAt(2), rowAt(1.5));
  const r = analyze(L, LW, LH, OPTS);
  const wall = r.obstacles.find((o) => o.family === F.MUR);
  const bin = r.obstacles.find((o) => o.family === F.POUBELLE);
  assert.ok(wall && Math.abs(wall.distance - 2) < 0.25, JSON.stringify(wall));
  assert.ok(bin && Math.abs(bin.distance - 1.5) < 0.2 && bin.lateral > 0.2, JSON.stringify(bin));
});

test('bord de trottoir à 2,5 m', () => {
  const L = scene('road');
  paint(L, 'sidewalk', 0, LW, rowAt(2.5), LH);
  const r = analyze(L, LW, LH, OPTS);
  assert.ok(r.curb, 'bordure détectée');
  assert.ok(Math.abs(r.curb.distance - 2.5) < 0.3, `bordure ${r.curb.distance}`);
});

import { parseRequest, findPlaces } from '../js/places.js';
import { extractWake } from '../js/wake.js';

test('lieux : compréhension des demandes parlées', () => {
  let r = parseRequest('aller à Inter à Castelsarrasin');
  assert.equal(r.name, 'Intermarché');
  assert.equal(r.city, 'Castelsarrasin');
  r = parseRequest('la pharmacie la plus proche');
  assert.equal(r.category?.label, 'pharmacie');
  assert.ok(r.nearest);
  r = parseRequest('Emmène-moi au 18 rue de Metz à Toulouse');
  assert.equal(r.name, '18 rue de Metz');
  assert.equal(r.city, 'Toulouse');
  r = parseRequest('je veux aller à la gare Matabiau');
  assert.equal(r.name, 'gare Matabiau');
  assert.equal(r.category, null);
  r = parseRequest('va à la boulangerie');
  assert.equal(r.category?.label, 'boulangerie');
  r = parseRequest('cherche un McDo');
  assert.equal(r.name, "McDonald's");
});

test('lieux : catégorie autour de soi, puis enseigne proche si la recherche texte est trop loin', async () => {
  const near = { lat: 44.0, lon: 1.35 };
  const calls = [];
  const deps = {
    categoryNearby: async (c) => (calls.push('cat'), [{ lat: 44.001, lon: 1.35, label: 'Pharmacie du centre', dist: 111 }]),
    photonSearch: async () => (calls.push('photon'), [{ lat: 48.8, lon: 2.3, label: 'Intermarché, Paris', dist: 550000 }]),
    nameNearby: async () => (calls.push('name'), [{ lat: 44.01, lon: 1.36, label: 'Intermarché, Montauban', dist: 1300 }]),
    nominatimSearch: async () => (calls.push('nomi'), []),
  };
  let { results } = await findPlaces('la pharmacie la plus proche', near, deps);
  assert.equal(results[0].label, 'Pharmacie du centre');
  ({ results } = await findPlaces('aller à Inter', near, deps));
  assert.equal(results[0].label, 'Intermarché, Montauban');
  assert.deepEqual(calls, ['cat', 'photon', 'name']);
});

test('mot d’activation « Dis Oriane »', () => {
  assert.equal(extractWake('Dis Oriane'), '');
  assert.equal(extractWake('dis oriane active la détection'), 'active la détection');
  assert.equal(extractWake('Dit Ariane, emmène-moi à la gare'), 'emmène-moi à la gare');
  assert.equal(extractWake('bonjour tout le monde'), null);
});

test('mur qui barre toute la largeur : annoncé devant', () => {
  const L = scene();
  paint(L, 'wall', 0, LW, 0, rowAt(3));
  const r = analyze(L, LW, LH, OPTS);
  assert.equal(r.obstacles.length, 1);
  assert.equal(r.obstacles[0].lateral, 0);
  assert.equal(r.obstacles[0].angle, 0);
});

// ---------- Alertes v2.1 (réponses au questionnaire) ----------
import { VIB } from '../js/alerts.js';

const ob = (family, label, distance, lateral = 0) => ({
  family, label, distance, lateral, latMin: lateral - 0.1, latMax: lateral + 0.1, angle: Math.atan2(lateral, distance) * 180 / Math.PI,
});
const S = () => ({ alertRange: 3, corridorWidth: 1.2, urgentDist: 1.5, vehicleRange: 10, minGap: 2 });
/** Fait approcher un obstacle de d0 à d1 (pas de 0,1 m toutes les 150 ms). */
function walk(am, make, d0, d1, ctx = {}) {
  const res = { speech: [], pings: 0, beeps: 0, vib: [] };
  let t = ctx.t0 || 0;
  for (let d = d0; d >= d1 - 1e-9; d -= 0.1) {
    t += 150;
    const r = am.update([].concat(make(d)), { t, curb: null, moving: true, ...ctx });
    res.speech.push(...r.speech.map((x) => x.text));
    res.pings += r.pings.length;
    res.beeps += r.beeps.length;
    if (r.vibrate) res.vib.push(r.vibrate);
  }
  return res;
}

test('poteau (niveau son) : un bip à l’entrée, rien au-delà de 3 m, « Stop » sous 1,5 m', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => ob(F.POTEAU, 'poteau', d), 5, 1.2);
  assert.equal(r.pings, 1);
  assert.deepEqual(r.speech, ['Stop, poteau, devant.']);
  assert.ok(r.beeps > 0, 'bips continus sous 2 m');
});

test('personne (niveau voix) : phrase courte une seule fois', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => ob(F.PERSONNE, 'personne', d), 4, 1.8);
  assert.deepEqual(r.speech, ['Personne, 3 mètres, devant.']);
});

test('pendant un guidage, niveau voix = bip seul', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => ob(F.PERSONNE, 'personne', d), 4, 1.8, { navActive: true });
  assert.deepEqual(r.speech, []);
  assert.equal(r.pings, 1);
});

test('vitre (niveau 1) : voix prioritaire et vibration longue dès l’entrée', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => ob(F.VITRE, 'porte ou paroi vitrée', d), 4, 2.5);
  assert.deepEqual(r.speech, ['Porte ou paroi vitrée, 3 mètres, devant.']);
  assert.ok(r.vib.some((v) => v === VIB.danger));
});

test('mobilier et eau (niveau vibre) : vibration courte, voix seulement en danger', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => ob(F.MOBILIER, 'chaise', d), 4, 1.2);
  assert.deepEqual(r.speech, ['Stop, chaise, devant.']);
  assert.ok(r.vib.some((v) => v === VIB.info));
});

test('mur (niveau danger) : silence jusqu’à 1,5 m', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => ob(F.MUR, 'mur', d), 4, 1.6);
  assert.equal(r.speech.length + r.pings + r.vib.length, 0);
});

test('intérieur : mur sur le côté ignoré, mur droit devant signalé à 2 m', () => {
  let am = new AlertManager(S());
  let r = walk(am, (d) => ({ ...ob(F.MUR, 'mur', d, 0.5), latMin: 0.4, latMax: 0.6 }), 3, 1.0, { indoor: true });
  assert.equal(r.speech.length, 0, r.speech.join(' | '));
  am = new AlertManager(S());
  r = walk(am, (d) => ({ ...ob(F.MUR, 'mur', d), latMin: -1, latMax: 1 }), 3, 1.85, { indoor: true });
  assert.deepEqual(r.speech, ['Stop, mur, devant.']);
});

test('immobile : silence sauf danger', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => ob(F.PERSONNE, 'personne', d), 4, 1.3, { moving: false });
  assert.deepEqual(r.speech, ['Stop, personne, devant.']);
  assert.equal(r.pings + r.beeps, 0);
});

test('obstacle qui ne se rapproche pas : pas d’annonce', () => {
  const am = new AlertManager(S());
  const said = [];
  for (let t = 150; t < 3000; t += 150) said.push(...am.update([ob(F.PERSONNE, 'personne', 2.5)], { t, curb: null, moving: true }).speech);
  assert.equal(said.length, 0);
});

test('mode silence : seuls les dangers et le niveau 1 passent', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => [ob(F.PERSONNE, 'personne', d, -0.3), ob(F.ESCALIER, 'escalier', d + 0.3, 0.3)], 4, 1.2, { muted: true });
  assert.ok(r.speech.includes('Escalier, 3 mètres, devant.'), r.speech.join(' | '));
  assert.ok(!r.speech.some((x) => x.startsWith('Personne,')), r.speech.join(' | '));
  assert.ok(r.speech.some((x) => x.startsWith('Stop, personne')), r.speech.join(' | '));
});

test('plusieurs obstacles : regroupés, le plus important énoncé', () => {
  const am = new AlertManager(S());
  const r = walk(am, (d) => [ob(F.POUBELLE, 'poubelle', d, 0.3), ob(F.PERSONNE, 'personne', d + 0.05, -0.3)], 4, 2.2);
  assert.deepEqual(r.speech, ['Plusieurs obstacles. Personne, 3 mètres, devant.']);
});

test('véhicule qui approche à 9 m (niveau 1)', () => {
  const am = new AlertManager(S());
  const said = [];
  let t = 0;
  for (let d = 10; d >= 7; d -= 0.5) {
    t += 200;
    said.push(...am.update([ob(F.VEHICULE, 'voiture', d, -1.5)], { t, curb: null, moving: true }).speech.map((x) => x.text));
  }
  assert.ok(said.some((x) => x.startsWith('Attention, voiture qui approche')), said.join(' | '));
});

test('bord de trottoir (niveau son) : un bip, puis « Stop » sous 1,5 m', () => {
  const am = new AlertManager(S());
  const said = [];
  let pings = 0;
  let t = 0;
  for (let d = 3; d >= 1.2; d -= 0.2) {
    t += 200;
    const r = am.update([], { t, curb: { distance: d }, moving: true });
    said.push(...r.speech.map((x) => x.text));
    pings += r.pings.length;
  }
  assert.equal(pings, 1);
  assert.deepEqual(said, ['Stop, bord de trottoir.']);
});
