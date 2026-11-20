// Tests v2.2 — lot 2.2-0 : capteurs, journal détaillé, compteur d'alertes, enregistrement et rejeu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TiltFilter, MotionState } from '../js/sensors.js';
import { IndoorDetector, scaleScene } from '../js/pipeline.js';
import { AlertManager } from '../js/alerts.js';
import { AlertCounter, formatEvent, eventsToCsv, summaryText, counterStatus } from '../js/instruments.js';
import { encodeLabels, decodeLabels, parseRecording, ReplaySession, Recorder, gzip } from '../js/rejeu.js';
import { F } from '../js/classes.js';
import { makeWalk, sceneLabels } from './fixtures.js';

const S = () => ({ alertRange: 3, corridorWidth: 1.2, urgentDist: 1.5, vehicleRange: 10, minGap: 2 });
const ob = (family, label, distance, lateral = 0) => ({
  family, label, distance, lateral, latMin: lateral - 0.1, latMax: lateral + 0.1, angle: Math.atan2(lateral, distance) * 180 / Math.PI,
});
/** Fait approcher un obstacle de d0 à d1 (0,1 m toutes les 150 ms) et rend tous les événements. */
function walkEvents(am, make, d0, d1, ctx = {}) {
  const events = [];
  let t = 0;
  for (let d = d0; d >= d1 - 1e-9; d -= 0.1) {
    t += 150;
    events.push(...am.update([].concat(make(d)), { t, curb: null, moving: true, ...ctx }).events);
  }
  return events;
}
const strip = (events) => JSON.stringify(events.filter((e) => e.emitted));

// ---------- Capteurs (comportement v2.1 inchangé) ----------

test('inclinaison : même lissage que la v2.1 (0,7 / 0,3 par événement), bornée à −20…80°', () => {
  const f = new TiltFilter();
  assert.equal(f.pitch(), null);
  f.onOrientation(75);
  assert.equal(f.pitch(), 15);
  f.onOrientation(65);
  assert.ok(Math.abs(f.pitch() - (90 - (75 * 0.7 + 65 * 0.3))) < 1e-9);
  f.onOrientation(null);
  assert.ok(Math.abs(f.pitch() - 18) < 1e-9);
  const g = new TiltFilter();
  g.onOrientation(-30);
  assert.equal(g.pitch(), 80);
});

test('marche : pas à l’accéléromètre (< 1,5 s), vitesse GPS, « en marche » sans capteur', () => {
  const m = new MotionState();
  assert.equal(m.isMoving(0), true, 'sans accéléromètre : considéré en marche');
  m.onMotion(1000, 0, 9.81, 0);
  assert.equal(m.isMoving(1000), false);
  m.onMotion(2000, 0, 11.5, 0);
  assert.equal(m.isMoving(3400), true);
  assert.equal(m.isMoving(3600), false);
  m.onGps(4000, 1.2);
  assert.equal(m.isMoving(6900), true);
  assert.equal(m.isMoving(7100), false);
});

test('intérieur / extérieur : bascule avec hystérésis, correction des distances', () => {
  const d = new IndoorDetector();
  const inside = new Uint8Array(300).fill(3); // floor
  let changes = 0;
  for (let i = 0; i < 30; i++) if (d.update(inside)) changes++;
  assert.equal(d.indoor, true);
  assert.equal(changes, 1);
  const s = scaleScene([ob(F.POTEAU, 'poteau', 2, 0.5)], { distance: 3 }, 1.5);
  assert.equal(s.obstacles[0].distance, 3);
  assert.equal(s.obstacles[0].lateral, 0.75);
  assert.equal(s.curb.distance, 4.5);
});

// ---------- Journal détaillé ----------

test('journal : entrée émise avec raison, vitesse de rapprochement et temps avant collision', () => {
  const am = new AlertManager(S());
  const ev = walkEvents(am, (d) => ob(F.POTEAU, 'poteau', d), 5, 1.2);
  const entry = ev.find((e) => e.type === 'entree');
  assert.ok(entry.emitted);
  assert.equal(entry.output, 'bip');
  assert.equal(entry.key, 'poteau');
  assert.match(entry.reason, /entrée dans la zone \(3 m\), se rapproche/);
  assert.ok(Math.abs(entry.speed - 0.1 / 0.15) < 0.01, `vitesse ${entry.speed}`);
  assert.ok(Math.abs(entry.ttc - entry.distance / entry.speed) < 1e-9);
  const danger = ev.find((e) => e.type === 'danger');
  assert.ok(danger.emitted && danger.danger);
  assert.match(danger.output, /Stop/);
  assert.equal(ev.filter((e) => e.type === 'bips').length, 1, 'début des bips continus noté une fois');
  assert.match(formatEvent(entry), /^🔔 Entrée · poteau · 3,0 m · devant · rapproche 0,7 m\/s · TTC 4,5 s · niveau son → bip \[entrée dans la zone \(3 m\), se rapproche : 1,00 m en 1,5 s\]$/);
});

test('journal : alerte retenue avec sa raison (immobile, silence, guidage, niveau)', () => {
  let ev = walkEvents(new AlertManager(S()), (d) => ob(F.PERSONNE, 'personne', d), 4, 1.8, { moving: false });
  assert.deepEqual(ev.map((e) => [e.type, e.emitted, e.blocked]), [['entree', false, 'immobile']]);
  ev = walkEvents(new AlertManager(S()), (d) => ob(F.PERSONNE, 'personne', d), 4, 1.8, { muted: true });
  assert.equal(ev[0].blocked, 'mode silence');
  ev = walkEvents(new AlertManager(S()), (d) => ob(F.PERSONNE, 'personne', d), 4, 2.1, { navActive: true });
  assert.deepEqual(ev.map((e) => [e.type, e.output]), [['entree', 'bip']]);
  ev = walkEvents(new AlertManager(S()), (d) => ob(F.MUR, 'mur', d), 4, 1.6);
  assert.match(ev[0].blocked, /niveau « danger »/);
  assert.match(formatEvent(ev[0]), /→ retenu : niveau « danger » : rien hors danger/);
});

test('journal : véhicule qui approche, raison chiffrée', () => {
  const am = new AlertManager(S());
  const ev = [];
  let t = 0;
  for (let d = 10; d >= 7; d -= 0.5) {
    t += 200;
    ev.push(...am.update([ob(F.VEHICULE, 'voiture', d, -1.5)], { t, curb: null, moving: true }).events);
  }
  const v = ev.find((e) => e.type === 'vehicule');
  assert.equal(v.key, 'vehicule_approche');
  assert.ok(v.emitted && v.danger);
  assert.match(v.reason, /^rapprochement 2 m\/s sur 1 s \(seuil 1,5 m\/s, vitesse de marche non retirée\)$/);
});

test('journal : bord de trottoir et image trop sombre', () => {
  const am = new AlertManager(S());
  const ev = [];
  let t = 0;
  for (let d = 3; d >= 1.2; d -= 0.2) {
    t += 200;
    ev.push(...am.update([], { t, curb: { distance: d }, moving: true }).events);
  }
  assert.deepEqual(ev.map((e) => [e.type, e.output]), [['trottoir', 'bip'], ['danger', 'voix « Stop » + vibration longue']]);
  const dark = [];
  for (t = 0; t <= 4000; t += 500) dark.push(...am.update([], { t: 100000 + t, curb: null, moving: true, lum: 0.05 }).events);
  assert.deepEqual(dark.map((e) => e.type), ['qualite']);
});

test('journal : export CSV (séparateur ;, virgule décimale, texte protégé)', () => {
  const am = new AlertManager(S());
  const ev = walkEvents(am, (d) => ob(F.POTEAU, 'poteau', d), 5, 1.2);
  const csv = eventsToCsv(ev, { t0: 0 }).trim().split('\n');
  assert.equal(csv[0], 'temps;type;emis;danger;objet;cle;niveau;distance_m;angle_deg;lateral_m;vitesse_rapprochement_m_s;ttc_s;en_marche;sortie;retenu;raison');
  assert.equal(csv.length, ev.length + 1);
  assert.match(csv[1], /^3,30;entree;oui;non;poteau;poteau;son;3,00;0,00;0,00;0,67;4,50;oui;bip;;entrée/);
  const q = eventsToCsv([{ t: 0, type: 'x', label: 'a;b "c"', emitted: true }]);
  assert.match(q, /"a;b ""c"""/);
});

// ---------- Compteur d'alertes (H1, bêta) ----------

test('compteur : minute glissante, alertes hors danger par minute de marche', () => {
  const c = new AlertCounter();
  const e = (danger) => ({ type: danger ? 'danger' : 'entree', key: 'poteau', emitted: true, danger });
  c.add(0, true, []);
  c.add(1000, true, [e(false), { type: 'entree', emitted: false }, { type: 'qualite', emitted: true }]);
  c.add(2000, true, [e(true)]);
  for (let t = 2500; t <= 30000; t += 500) c.add(t, true, []);
  assert.deepEqual(c.lastMinute(30000), { alerts: 2, danger: 1, nonDanger: 1 });
  assert.deepEqual(c.lastMinute(61500), { alerts: 1, danger: 1, nonDanger: 0 });
  assert.ok(Math.abs(c.perMovingMinute() - 2) < 1e-9, '1 alerte hors danger en 30 s de marche');
  c.add(40000, false, []); // trou de 10 s : compté 2 s au plus, et immobile
  assert.equal(c.summary().movingMin, 0.5);
  assert.match(summaryText(c.summary()), /^2 alerte\(s\) dont 1 danger\(s\) ; 1 hors danger, 2,0 par minute de marche \(cible ≤ 2\) ; 30 s de marche sur 32 s\.$/);
  assert.match(counterStatus(c, 61500), /alertes 1 min : 0 \+ 1 danger · moyenne 2,0\/min en marche \(bêta\)/);
});

// ---------- Enregistrement et rejeu (FON-40) ----------

test('cartes de classes : compression sans perte', () => {
  const L = sceneLabels(15, [{ cls: 'pole', x0: 26, x1: 30, d: 3 }, { cls: 'car', x0: 0, x1: 10, d: 6 }]);
  const enc = encodeLabels(L);
  assert.deepEqual(decodeLabels(enc, L.length), L);
  assert.ok(enc.length < L.length / 5, `compressé ${enc.length} caractères pour ${L.length} cases`);
  const R = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7919) % 150);
  assert.deepEqual(decodeLabels(encodeLabels(R), R.length), R);
  assert.throws(() => decodeLabels(enc, L.length + 1), /abîmée/);
});

test('enregistrement : fichier gzip relu à l’identique, images comprises', async () => {
  const { recorder } = await makeWalk({ seconds: 1.5, images: true, objects: [{ cls: 'pole', x0: 26, x1: 30, d0: 4 }] });
  recorder.gps(2000, { lat: 44.04, lon: 1.1, accuracy: 5, speed: 1.3, heading: 90 });
  const blob = await recorder.toBlob();
  const rec = await parseRecording(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(rec.format, 'oriane-rejeu');
  assert.equal(rec.frames.length, recorder.frameCount);
  assert.equal(rec.frames[0].jpeg, '/9j/2Q==');
  assert.equal(rec.sensors.gps.length, 1);
  assert.ok(rec.sensors.orientation.length > 80 && rec.sensors.motion.length > 80);
  assert.equal(rec.settings.alertRange, 3);
  await assert.rejects(parseRecording(await gzip('{"format":"autre"}')), /pas un enregistrement ORIANE/);
  await assert.rejects(parseRecording(new TextEncoder().encode('pas du json')), /pas un enregistrement ORIANE/);
});

test('enregistrement : aucune clé dans le fichier (clé OpenRouteService retirée)', async () => {
  const r = new Recorder({ now: 0, settings: { orsKey: 'secret-123', alertRange: 3, levels: { poteau: 'son' } } });
  const rec = await r.toObject();
  assert.equal(rec.settings.orsKey, undefined);
  assert.equal(rec.settings.alertRange, 3);
  assert.ok(!JSON.stringify(rec).includes('secret-123'));
});

test('enregistrement : durée maximale', () => {
  const r = new Recorder({ now: 0, maxMs: 1000 });
  r.orientation(500, { beta: 70 });
  assert.equal(r.full, false);
  r.orientation(1000, { beta: 70 });
  assert.equal(r.full, true);
});

test('rejeu : mêmes alertes que le direct, et à chaque passage', async () => {
  const { rec, live } = await makeWalk({
    seconds: 5, objects: [{ cls: 'pole', x0: 26, x1: 30, d0: 6 }, { cls: 'person', x0: 36, x1: 44, d0: 8, v: 0.5 }],
    pitch: (t) => 15 + 2 * Math.sin(2 * Math.PI * 2 * t),
  });
  assert.ok(live.some((e) => e.emitted), 'le direct a émis des alertes');
  const runs = ['enregistree', 'filtre', 'filtre'].map((pitch) => {
    const s = new ReplaySession(rec, { pitch });
    s.run();
    return s.events;
  });
  const shift = (evs) => strip(evs.map((e) => ({ ...e, t: Math.round(e.t) })));
  assert.equal(shift(runs[0]), shift(live.map((e) => ({ ...e, t: e.t - 1000 }))), 'inclinaison enregistrée = direct');
  assert.equal(shift(runs[1]), shift(runs[0]), 'filtre actuel = direct (lot 2.2-0 : filtre inchangé)');
  assert.equal(strip(runs[1]), strip(runs[2]), 'deux rejeux identiques');
});

test('rejeu : réglages remplacés et résumé', async () => {
  const { rec } = await makeWalk({ seconds: 5, objects: [{ cls: 'pole', x0: 26, x1: 30, d0: 6 }] });
  const base = new ReplaySession(rec).run();
  assert.equal(base.frames, rec.frames.length);
  assert.equal(base.counter.nonDanger, 2, 'bip d’entrée + bips continus');
  assert.equal(base.counter.danger, 1);
  const quiet = new ReplaySession(rec, { settings: { levels: { poteau: 'jamais' } } }).run();
  assert.equal(quiet.counter.alerts, 0);
  assert.equal(new ReplaySession(rec).settings.alertRange, 3);
});

// ---------- Défauts du test terrain, à corriger au lot 2.2-2 (rejeux synthétiques) ----------

test('FON-25 : marcher le long d’une voiture garée → aucune annonce « qui approche »', { todo: 'lot 2.2-2 (vitesse propre)' }, async () => {
  const { rec } = await makeWalk({ seconds: 6, objects: [{ cls: 'car', x0: 0, x1: 14, d0: 10 }], pitch: (t) => 15 + 2 * Math.sin(2 * Math.PI * 2 * t) });
  const s = new ReplaySession(rec).run();
  assert.equal(s.emitted.filter((e) => e.type === 'vehicule').length, 0);
});

test('FON-28 : suivre un piéton au même pas → aucune annonce', { todo: 'lot 2.2-2 (même sens, tendance 1,5 s)' }, async () => {
  const { rec } = await makeWalk({ seconds: 8, objects: [{ cls: 'person', x0: 24, x1: 32, d0: 2.8, v: -1.3 }], pitch: (t) => 15 + 5 * Math.sin(2 * Math.PI * 2 * t) });
  const s = new ReplaySession(rec).run();
  assert.equal(s.emitted.length, 0);
});
