// Tests de la logique pure (géométrie, parsing des itinéraires, guidage, distances, profondeur).
// Lancer : npm test   (ou : node --test tests/)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Polyline, offset, haversine, fmtDist, fmtMeters, clockHour, angleDiff } from '../js/util.js';
import { parseORS, parseOSRM, cleanQuery, classifyLandmark } from '../js/geo.js';
import { Navigator, actionText } from '../js/nav.js';
import { estimateDistance, focalPx, CLASSES, dirPhrase } from '../js/vision.js';
import { DepthSensor } from '../js/depth.js';

const A = { lat: 43.6, lon: 1.44 };
const B = offset(A, 200, 0); // 200 m au nord
const C = offset(B, 0, 150); // puis 150 m à l'est (virage à droite)

test('géométrie de base', () => {
  assert.ok(Math.abs(haversine(A, B) - 200) < 0.5);
  const line = new Polyline([A, B, C]);
  assert.ok(Math.abs(line.length - 350) < 1);
  const p = line.project(offset(A, 100, 5));
  assert.ok(Math.abs(p.along - 100) < 1 && Math.abs(p.dist - 5) < 0.5);
  assert.ok(Math.abs(angleDiff(line.bearingAt(50), 0)) < 1);
  assert.ok(Math.abs(angleDiff(line.bearingAt(300), 90)) < 1);
});

test('formats parlés', () => {
  assert.equal(fmtDist(23), '20 mètres');
  assert.equal(fmtDist(7), '5 mètres');
  assert.equal(fmtDist(1480), '1,5 kilomètre');
  assert.equal(fmtDist(2000), '2 kilomètres');
  assert.equal(fmtMeters(0.6), '1 mètre');
  assert.equal(clockHour(90), 3);
  assert.equal(clockHour(-90), 9);
  assert.equal(clockHour(0), 12);
  assert.equal(cleanQuery('Emmène-moi au 18 rue de Metz à Toulouse'), '18 rue de Metz Toulouse');
  assert.equal(cleanQuery('je veux aller à la gare Matabiau'), 'gare Matabiau');
});

test('lecture OpenRouteService', () => {
  const json = {
    features: [{
      geometry: { coordinates: [[A.lon, A.lat], [B.lon, B.lat], [C.lon, C.lat]] },
      properties: {
        summary: { distance: 350, duration: 252 },
        segments: [{ steps: [
          { type: 11, name: 'Rue A', way_points: [0, 1] },
          { type: 1, name: 'Rue de Metz', way_points: [1, 2] },
          { type: 10, name: '-', way_points: [2, 2] },
        ] }],
      },
    }],
  };
  const r = parseORS(json);
  assert.equal(r.steps[1].kind, 'turn');
  assert.equal(r.steps[1].mod, 'right');
  assert.ok(Math.abs(r.steps[1].along - 200) < 1);
  assert.equal(actionText(r.steps[1]), 'tournez à droite sur Rue de Metz');
});

test('lecture OSRM', () => {
  const json = {
    code: 'Ok',
    routes: [{
      distance: 350, duration: 250,
      geometry: { coordinates: [[A.lon, A.lat], [B.lon, B.lat], [C.lon, C.lat]] },
      legs: [{ steps: [
        { name: 'Rue A', maneuver: { type: 'depart', location: [A.lon, A.lat] } },
        { name: 'Rue de Metz', maneuver: { type: 'turn', modifier: 'right', location: [B.lon, B.lat] } },
        { name: 'Rue de Metz', maneuver: { type: 'new name', modifier: 'slight left', location: [C.lon, C.lat] } },
        { name: '', maneuver: { type: 'arrive', location: [C.lon, C.lat] } },
      ] }],
    }],
  };
  const r = parseOSRM(json);
  assert.deepEqual(r.steps.map((s) => s.kind), ['depart', 'turn', 'straight', 'arrive']);
  assert.ok(Math.abs(r.steps[1].along - 200) < 1);
});

test('repères OSM', () => {
  assert.equal(classifyLandmark({ highway: 'crossing', crossing: 'traffic_signals' }), 'crossing_signals');
  assert.equal(classifyLandmark({ highway: 'crossing', crossing: 'marked' }), 'crossing');
  assert.equal(classifyLandmark({ highway: 'traffic_signals' }), 'signals');
});

test('guidage complet le long d’un itinéraire simulé', () => {
  const said = [];
  let arrived = false;
  const nav = new Navigator({ say: (t) => said.push(t), onArrive: () => (arrived = true) });
  const rt = {
    pts: [A, B, C],
    duration: 270,
    steps: [
      { kind: 'depart', along: 0 },
      { kind: 'turn', mod: 'right', name: 'Rue de Metz', along: 200 },
      { kind: 'arrive', along: 350 },
    ],
  };
  nav.start(rt, C);
  // Un feu 15 m avant le virage, et un passage piéton isolé à 100 m.
  nav.setLandmarks([
    { ...offset(A, 185, 2), kind: 'signals' },
    { ...offset(A, 186, -2), kind: 'crossing' },
    { ...offset(A, 100, 3), kind: 'crossing' },
  ]);
  const line = new Polyline(rt.pts);
  for (let d = 0; d <= 352; d += 1.4) {
    const p = line.pointAt(d);
    nav.update({ ...p, accuracy: 5, heading: line.bearingAt(d), speed: 1.4 });
    if (arrived) break;
  }
  const all = said.join(' | ');
  assert.match(all, /Itinéraire trouvé : 350 mètres/);
  assert.match(all, /Partez tout droit\./);
  assert.match(all, /Passage piéton dans 20 mètres/);
  assert.match(all, /Dans [56]0 mètres, après le feu, tournez à droite sur Rue de Metz/);
  assert.match(all, /Dans 20 mètres, après le feu, tournez à droite/);
  assert.match(all, /Tournez à droite sur Rue de Metz maintenant/);
  assert.match(all, /Continuez sur 150 mètres/);
  assert.ok(arrived, 'arrivée détectée');
  assert.match(all, /Vous êtes arrivé/);
});

test('écart d’itinéraire → recalcul', () => {
  let rerouted = false;
  const nav = new Navigator({ say: () => {}, onReroute: () => (rerouted = true) });
  nav.start({ pts: [A, B, C], steps: [] }, C);
  for (let i = 0; i < 4; i++) nav.update({ ...offset(A, 50, 60), accuracy: 8, heading: null, speed: null });
  assert.ok(rerouted);
});

test('distance des objets', () => {
  const W = 720, H = 1280;
  const f = focalPx(W, H, 66);
  // Une personne de 1,70 m à 5 m occupe 1,7*f/5 pixels de haut.
  const h = (1.7 * f) / 5;
  const d = estimateDistance(CLASSES.person, [300, 400, 80, h], W, H, f);
  assert.ok(Math.abs(d - 5) < 0.01);
  assert.equal(dirPhrase(-30), 'à gauche');
  assert.equal(dirPhrase(3), 'devant');
});

test('profondeur : sol plat → aucun obstacle ; mur proche → obstacle', () => {
  const settings = { fov: 66, camHeight: 1.3, beepRange: 6, calib: 1 };
  const pitch = 20;
  const ds = new DepthSensor({ settings, getPitch: () => pitch });
  const W = 64, H = 112;
  const f = Math.max(W, H) / 2 / Math.tan((66 * Math.PI) / 360);
  const ground = (y) => {
    const a = pitch + (Math.atan((y - H / 2) / f) * 180) / Math.PI;
    return a > 2 ? 1.3 / Math.tan((a * Math.PI) / 180) : 50;
  };
  const K = 7; // échelle arbitraire du modèle
  const flat = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) flat[y * W + x] = K / Math.min(50, ground(y));
  assert.equal(ds.analyze(flat, H, W).length, 0);
  // Poteau à 2 m sur la droite (colonnes 50-58), au-dessus de son pied.
  const post = flat.slice();
  for (let y = 0; y < H; y++) {
    if (ground(y) < 2) continue;
    for (let x = 50; x < 58; x++) post[y * W + x] = K / 2;
  }
  const obs = ds.analyze(post, H, W);
  assert.equal(obs.length, 1);
  assert.ok(Math.abs(obs[0].distance - 2) < 0.3, `distance ${obs[0].distance}`);
  assert.ok(obs[0].angle > 10, 'obstacle à droite');
});
