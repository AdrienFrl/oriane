// ORIANE v2.2 — enregistrement et rejeu d'une marche (H3, FON-40).
//
// Enregistrement : pour chaque analyse, l'image envoyée au modèle (224 px, JPEG, facultative), la carte
// de segmentation (compressée), l'inclinaison utilisée et les paramètres de la caméra ; en continu, les
// capteurs bruts (orientation, accéléromètre et gyroscope, GPS). Fichier JSON compressé (gzip),
// créé sur le téléphone et téléchargé localement : rien n'est envoyé à un serveur.
//
// Rejeu : les cartes de segmentation repassent par la géométrie, les capteurs et le gestionnaire
// d'alertes actuels (même code qu'en direct, voir pipeline.js), sans le modèle. Le rejeu est donc
// rapide, possible sur ordinateur sans WebGPU, et donne les mêmes alertes à chaque passage.
// Module pur (sauf Blob / CompressionStream, présents dans les navigateurs et dans Node ≥ 18).

import { analyze } from './geometry.js';
import { AlertManager } from './alerts.js';
import { TiltFilter, MotionState } from './sensors.js';
import { IndoorDetector, processFrame } from './pipeline.js';
import { AlertCounter } from './instruments.js';

export const REC_FORMAT = 'oriane-rejeu';
export const REC_VERSION = 1;

// ---------------- Encodages ----------------

export function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/** Carte de classes → base64 d'une suite de couples (classe, longueur ≤ 255). ≈ 10 fois plus petit. */
export function encodeLabels(labels) {
  const out = [];
  let i = 0;
  while (i < labels.length) {
    const v = labels[i];
    let n = 1;
    while (n < 255 && i + n < labels.length && labels[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return toBase64(Uint8Array.from(out));
}

export function decodeLabels(str, size) {
  const rle = fromBase64(str);
  const labels = new Uint8Array(size);
  let p = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    labels.fill(rle[i], p, p + rle[i + 1]);
    p += rle[i + 1];
  }
  if (p !== size) throw new Error(`carte de classes abîmée (${p} cases au lieu de ${size})`);
  return labels;
}

// Valeurs des capteurs gardées en pleine précision : le rejeu doit retrouver exactement les mêmes seuils.
const val = (v) => (v == null || Number.isNaN(v) ? null : v);

async function streamThrough(data, stream) {
  const res = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export const gzip = (text) => streamThrough(new TextEncoder().encode(text), new CompressionStream('gzip'));

/** Lit un fichier d'enregistrement (gzip ou JSON brut) et vérifie son format. */
export async function parseRecording(data) {
  let u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = await streamThrough(u8, new DecompressionStream('gzip'));
  let rec;
  try {
    rec = JSON.parse(new TextDecoder().decode(u8));
  } catch {
    throw new Error('ce fichier n’est pas un enregistrement ORIANE');
  }
  if (rec.format !== REC_FORMAT) throw new Error('ce fichier n’est pas un enregistrement ORIANE');
  if (rec.version > REC_VERSION) throw new Error(`enregistrement en version ${rec.version}, trop récente pour cette appli`);
  return rec;
}

// ---------------- Enregistrement ----------------

/** Réglages copiés dans l'enregistrement, sans aucune clé (le fichier peut être partagé). */
export function safeSettings(settings) {
  const copy = JSON.parse(JSON.stringify(settings));
  for (const k of Object.keys(copy)) if (/key|token|secret|password/i.test(k)) delete copy[k];
  return copy;
}

export class Recorder {
  /**
   * now : temps de départ (même horloge que les temps passés ensuite, performance.now en direct).
   * images : garder l'image 224 px de chaque analyse. maxMs : durée maximale.
   */
  constructor({ now, appVersion = '', settings = {}, images = true, maxMs = 10 * 60000, startedAt = new Date().toISOString(), device = '' }) {
    this.t0 = now;
    this.images = images;
    this.maxMs = maxMs;
    this.lastT = now;
    this.rec = {
      format: REC_FORMAT, version: REC_VERSION, appVersion, startedAt, device,
      settings: safeSettings(settings),
      sensors: { orientation: [], motion: [], gps: [] },
      frames: [],
      live: [],
    };
    this._jpegs = [];
  }

  _rel(t) {
    if (t > this.lastT) this.lastT = t;
    return Math.round((t - this.t0) * 1000) / 1000; // microseconde : pas de perte avec performance.now
  }

  get durationMs() {
    return this.lastT - this.t0;
  }

  get full() {
    return this.durationMs >= this.maxMs;
  }

  get frameCount() {
    return this.rec.frames.length;
  }

  /** deviceorientation(absolute) : [t, alpha, beta, gamma, absolu, compas iOS]. */
  orientation(t, e) {
    this.rec.sensors.orientation.push([this._rel(t), val(e.alpha), val(e.beta), val(e.gamma), e.absolute ? 1 : 0, val(e.webkitCompassHeading)]);
  }

  /** devicemotion : [t, ax, ay, az (avec gravité), x, y, z (sans gravité), rotation α, β, γ (°/s), intervalle ms]. */
  motion(t, e) {
    const g = e.accelerationIncludingGravity || {};
    const a = e.acceleration || {};
    const r = e.rotationRate || {};
    this.rec.sensors.motion.push([this._rel(t), val(g.x), val(g.y), val(g.z), val(a.x), val(a.y), val(a.z), val(r.alpha), val(r.beta), val(r.gamma), e.interval ?? null]);
  }

  /** Position : [t, lat, lon, précision m, vitesse m/s, cap °, simulée]. */
  gps(t, p) {
    this.rec.sensors.gps.push([this._rel(t), p.lat, p.lon, val(p.accuracy), val(p.speed), val(p.heading), p.simulated ? 1 : 0]);
  }

  /**
   * Résultat du worker : msg = { t (capture), lw, lh, labels, cropTop, lum, geo: { frameW, frameH, fov, camHeight, corridorHalf, pitch }, jpeg? }
   * tr : temps de réception ; ctx : { navActive, muted } au moment du traitement.
   */
  frame(msg, tr, ctx = {}) {
    const g = msg.geo || {};
    this.rec.frames.push({
      tc: this._rel(msg.t), tr: this._rel(tr), lw: msg.lw, lh: msg.lh, cropTop: val(msg.cropTop),
      frameW: g.frameW, frameH: g.frameH, fov: g.fov, camHeight: g.camHeight, corridorHalf: g.corridorHalf, pitch: val(g.pitch),
      lum: val(msg.lum), nav: !!ctx.navActive, muted: !!ctx.muted,
      labels: encodeLabels(msg.labels),
    });
    this._jpegs.push(this.images && msg.jpeg ? msg.jpeg : null);
  }

  /** Alertes émises en direct, pour comparer avec le rejeu. */
  live(events) {
    for (const e of events) {
      if (e.emitted) this.rec.live.push({ t: this._rel(e.t), type: e.type, key: e.key, label: e.label, distance: val(e.distance), output: e.output });
    }
  }

  /** Objet final, images converties en base64. */
  async toObject() {
    const frames = await Promise.all(this.rec.frames.map(async (f, i) => {
      const j = this._jpegs[i];
      return j ? { ...f, jpeg: toBase64(new Uint8Array(await j.arrayBuffer())) } : f;
    }));
    return { ...this.rec, durationMs: Math.round(this.durationMs), frames };
  }

  /** Fichier compressé, prêt à télécharger. */
  async toBlob() {
    const data = await gzip(JSON.stringify(await this.toObject()));
    return new Blob([data], { type: 'application/gzip' });
  }
}

// ---------------- Rejeu ----------------

export class ReplaySession {
  /**
   * rec : enregistrement lu par parseRecording.
   * settings : réglages qui remplacent ceux de l'enregistrement (par exemple pour comparer des seuils).
   * defaults : réglages par défaut de l'appli actuelle (pour les réglages apparus après l'enregistrement).
   * pitch : 'filtre' (inclinaison recalculée par le filtre actuel à partir des capteurs, par défaut)
   *         ou 'enregistree' (inclinaison utilisée en direct).
   */
  constructor(rec, { settings = {}, defaults = {}, pitch = 'filtre' } = {}) {
    this.rec = rec;
    this.pitchSource = pitch;
    this.settings = { ...defaults, ...rec.settings, ...settings };
    this.alerts = new AlertManager(this.settings);
    this.indoor = new IndoorDetector();
    this.counter = new AlertCounter();
    this.tilt = new TiltFilter();
    this.motion = new MotionState();
    this.events = [];
    const tl = [];
    for (const r of rec.sensors?.orientation || []) tl.push({ t: r[0], k: 0, r });
    for (const r of rec.sensors?.motion || []) tl.push({ t: r[0], k: 1, r });
    for (const r of rec.sensors?.gps || []) tl.push({ t: r[0], k: 2, r });
    tl.sort((a, b) => a.t - b.t); // tri stable : l'ordre d'arrivée est gardé à temps égal
    this.timeline = tl;
    this.frames = (rec.frames || []).slice().sort((a, b) => a.tr - b.tr);
    this.fi = 0;
    this.si = 0;
  }

  get done() {
    return this.fi >= this.frames.length;
  }

  /** Temps (ms depuis le début) de la prochaine analyse. */
  get nextTime() {
    return this.done ? null : this.frames[this.fi].tr;
  }

  _sensorsUntil(t) {
    const tl = this.timeline;
    while (this.si < tl.length && tl[this.si].t <= t) {
      const { k, r } = tl[this.si++];
      if (k === 0) this.tilt.onOrientation(r[2]);
      else if (k === 1) this.motion.onMotion(r[0], r[1], r[2], r[3]);
      else this.motion.onGps(r[0], r[4]);
    }
  }

  /** Rejoue l'analyse suivante. */
  step() {
    const index = this.fi++;
    const f = this.frames[index];
    this._sensorsUntil(f.tc);
    const pitch = this.pitchSource === 'enregistree' && f.pitch != null ? f.pitch : this.tilt.pitch() ?? 12;
    this._sensorsUntil(f.tr);
    const labels = decodeLabels(f.labels, f.lw * f.lh);
    const res = analyze(labels, f.lw, f.lh, {
      frameW: f.frameW, frameH: f.frameH, cropTop: f.cropTop, fovDeg: f.fov, pitchDeg: pitch,
      camHeight: f.camHeight, corridorHalf: f.corridorHalf, maxDist: 12,
    });
    const moving = this.motion.isMoving(f.tr);
    const p = processFrame(this, { obstacles: res.obstacles, curb: res.curb, labels, lum: f.lum }, {
      t: f.tr, moving, navActive: f.nav, muted: f.muted,
    });
    this.events.push(...p.r.events);
    return { index, frame: f, labels, pitch, moving, ...p };
  }

  /** Rejoue tout d'un coup et renvoie le résumé. */
  run() {
    while (!this.done) this.step();
    return this.summary();
  }

  summary() {
    return {
      durationMs: this.rec.durationMs ?? (this.frames.length ? this.frames[this.frames.length - 1].tr : 0),
      frames: this.frames.length,
      counter: this.counter.summary(),
      emitted: this.events.filter((e) => e.emitted),
      liveEmitted: (this.rec.live || []).length,
    };
  }
}
