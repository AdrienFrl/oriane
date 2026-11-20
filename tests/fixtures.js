// Marches synthétiques pour les tests : cartes de segmentation + capteurs, enregistrées comme sur le téléphone.
// Le pipeline « direct » tourne pendant la génération (comme dans app.js), pour comparer avec le rejeu.

import { makeCamera, groundDistance, analyze } from '../js/geometry.js';
import { ADE_LABELS } from '../js/classes.js';
import { AlertManager } from '../js/alerts.js';
import { TiltFilter, MotionState } from '../js/sensors.js';
import { IndoorDetector, processFrame } from '../js/pipeline.js';
import { AlertCounter } from '../js/instruments.js';
import { Recorder } from '../js/rejeu.js';

export const idx = (name) => ADE_LABELS.indexOf(name);
export const GEO = { frameW: 720, frameH: 1280, lw: 56, lh: 72, fov: 66, camHeight: 1.3, corridorHalf: 0.6 };
GEO.cropTop = 1 - (288 * GEO.frameW / 224) / GEO.frameH;

/** Ligne de la carte dont le bord bas est à la distance d, pour une inclinaison donnée. */
export function rowAt(d, pitch) {
  const cam = makeCamera({ frameW: GEO.frameW, frameH: GEO.frameH, labelW: GEO.lw, cropTop: GEO.cropTop, fovDeg: GEO.fov, pitchDeg: pitch, camHeight: GEO.camHeight });
  let best = 0;
  let err = Infinity;
  for (let y = 0; y <= GEO.lh; y++) {
    const e = Math.abs(groundDistance(cam, y) - d);
    if (e < err) { err = e; best = y; }
  }
  return best;
}

/**
 * Scène vue avec l'inclinaison réelle `pitch` : trottoir, ciel au-delà de 40 m, objets posés au sol.
 * objects : [{ cls: 'pole', x0, x1 (colonnes de la carte), d (distance du pied, m) }]
 */
export function sceneLabels(pitch, objects) {
  const { lw, lh } = GEO;
  const L = new Uint8Array(lw * lh).fill(idx('sidewalk'));
  const horizon = rowAt(40, pitch);
  for (let y = 0; y < horizon; y++) L.fill(idx('sky'), y * lw, (y + 1) * lw);
  for (const o of objects) {
    if (o.d <= 0.3) continue;
    const y1 = rowAt(o.d, pitch);
    for (let y = 0; y < y1; y++) for (let x = o.x0; x < o.x1; x++) L[y * lw + x] = idx(o.cls);
  }
  return L;
}

/**
 * Génère une marche enregistrée.
 * objects : [{ cls, x0, x1, d0, v (vitesse propre vers l'utilisateur, m/s, 0 = fixe) }]
 * speed : vitesse de marche (m/s) ; pitch(t) : inclinaison réelle (°) ; fps : analyses par seconde.
 * Renvoie { rec (objet enregistrement), live (événements du direct), counter }.
 */
export async function makeWalk({ seconds = 4, fps = 6, speed = 1.3, objects = [], pitch = () => 15, settings = {}, images = false } = {}) {
  const s = { alertRange: 3, corridorWidth: 1.2, urgentDist: 1.5, vehicleRange: 10, minGap: 2, calib: 1, ...settings };
  const recorder = new Recorder({ now: 1000, appVersion: 'test', settings: s, images, startedAt: '2026-11-20T10:00:00.000Z' });
  const env = { settings: s, alerts: new AlertManager(s), indoor: new IndoorDetector(), counter: new AlertCounter() };
  const tilt = new TiltFilter();
  const motion = new MotionState();
  const live = [];
  const pending = [];
  const end = 1000 + seconds * 1000;
  let nextFrame = 1000 + 1000 / fps;
  for (let t = 1000; t <= end; t += 16) {
    // Capteurs à 62,5 Hz (temps entiers, comparaison exacte direct / rejeu) : orientation, puis accéléromètre (un pas toutes les 0,5 s en marchant)
    const sec = (t - 1000) / 1000;
    const o = { alpha: 0, beta: 90 - pitch(sec), gamma: 0, absolute: false };
    recorder.orientation(t, o);
    tilt.onOrientation(o.beta);
    const step = speed > 0 && Math.abs((sec % 0.5) - 0.25) < 0.02;
    const m = { accelerationIncludingGravity: { x: 0, y: step ? 12 : 9.81, z: 0 }, acceleration: { x: 0, y: step ? 2.2 : 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 };
    recorder.motion(t, m);
    motion.onMotion(t, m.accelerationIncludingGravity.x, m.accelerationIncludingGravity.y, m.accelerationIncludingGravity.z);
    // Résultats du modèle qui arrivent maintenant (≈ 40 ms après la capture, capteurs reçus entre-temps)
    while (pending.length && pending[0].t + 40 <= t) {
      const msg = pending.shift();
      const ctx = { navActive: false, muted: false };
      const p = processFrame(env, msg, { t, moving: motion.isMoving(t), ...ctx });
      recorder.frame(msg, t, ctx);
      recorder.live(p.r.events);
      live.push(...p.r.events);
    }
    if (t >= nextFrame) {
      nextFrame += 1000 / fps;
      const capturePitch = tilt.pitch() ?? 12;
      const objs = objects.map((ob) => ({ ...ob, d: ob.d0 - (speed + (ob.v || 0)) * sec }));
      const labels = sceneLabels(pitch(sec), objs);
      const geo = { frameW: GEO.frameW, frameH: GEO.frameH, fov: GEO.fov, camHeight: GEO.camHeight, corridorHalf: GEO.corridorHalf, pitch: capturePitch };
      const res = analyze(labels, GEO.lw, GEO.lh, { frameW: geo.frameW, frameH: geo.frameH, cropTop: GEO.cropTop, fovDeg: geo.fov, pitchDeg: capturePitch, camHeight: geo.camHeight, corridorHalf: geo.corridorHalf, maxDist: 12 });
      pending.push({ t, lw: GEO.lw, lh: GEO.lh, labels, cropTop: GEO.cropTop, lum: 0.5, geo, ...res, jpeg: images ? new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }) : null });
    }
  }
  return { rec: await recorder.toObject(), live, counter: env.counter, recorder };
}
