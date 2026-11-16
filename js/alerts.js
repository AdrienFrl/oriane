// ORIANE v2 — gestionnaire d'alertes de proximité (règles du cahier des charges, § 4.2).
//
//  • Couloir de marche : largeur réglable (1,5 m par défaut), distance d'alerte réglable (4 m par défaut).
//  • Entrée en zone : un bip spatialisé + une phrase (« Poteau devant, 3 mètres »), une seule fois.
//  • Mobilier : bip + vibration, la voix seulement en zone d'urgence.
//  • Urgence (< 1,5 m dans le couloir) : « Stop, mur devant », priorité maximale.
//  • Véhicule qui approche : annoncé jusqu'à 10 m.
//  • Hystérésis : on entre à la distance d'alerte, on ne sort qu'au-delà de +0,6 m.
// Module pur (aucun accès au navigateur) : testé sous Node.

import { F } from './classes.js';
import { fmtMeters, cap } from './util.js';

const URGENT = 1.5;
const HYST = 0.6;

export function dirWords(angle) {
  if (angle < -20) return 'à gauche';
  if (angle < -8) return 'légèrement à gauche';
  if (angle <= 8) return 'devant';
  if (angle <= 20) return 'légèrement à droite';
  return 'à droite';
}

export class AlertManager {
  constructor(settings) {
    this.s = settings; // { alertRange, corridorWidth, vehicleRange }
    this.tracks = [];
    this.nextId = 1;
    this.lastEntrySpeech = -Infinity;
    this.recentPhrases = new Map();
    this.curbState = { done: false, lostAt: null };
    this.darkSince = null;
    this.lastDarkWarn = -Infinity;
  }

  reset() {
    this.tracks = [];
    this.curbState = { done: false, lostAt: null };
  }

  /**
   * obstacles : [{ family, label, distance, lateral, latMin, latMax, angle }]
   * ctx : { t (ms), curb: {distance} | null, lum (0–1) }
   * Renvoie { beeps: [...], speech: [{text, priority, key}], vibrate: motif | null, tracks }
   */
  update(obstacles, ctx) {
    const t = ctx.t;
    const range = this.s.alertRange ?? 4;
    const half = (this.s.corridorWidth ?? 1.5) / 2;
    const vehicleRange = this.s.vehicleRange ?? 10;
    const out = { beeps: [], speech: [], vibrate: null };

    // 1. Association aux pistes existantes
    for (const tr of this.tracks) tr.matched = false;
    for (const o of obstacles) {
      let best = null;
      let bestScore = Infinity;
      for (const tr of this.tracks) {
        if (tr.matched || tr.family !== o.family) continue;
        const da = Math.abs(tr.angle - o.angle);
        const dd = Math.abs(tr.distance - o.distance);
        if (da > 12 || dd > Math.max(1, 0.4 * o.distance)) continue;
        const score = da / 12 + dd / Math.max(1, o.distance);
        if (score < bestScore) { bestScore = score; best = tr; }
      }
      if (best) {
        const a = o.distance < URGENT ? 0.8 : 0.5;
        best.distance = best.distance * (1 - a) + o.distance * a;
        best.angle = best.angle * 0.5 + o.angle * 0.5;
        best.lateral = o.lateral;
        best.latMin = o.latMin;
        best.latMax = o.latMax;
        best.label = o.label;
        best.hits++;
        best.misses = 0;
        best.matched = true;
        best.hist.push({ t, d: best.distance });
        while (best.hist.length && t - best.hist[0].t > 2000) best.hist.shift();
      } else {
        this.tracks.push({
          id: this.nextId++, family: o.family, label: o.label, distance: o.distance, angle: o.angle,
          lateral: o.lateral, latMin: o.latMin, latMax: o.latMax, hits: 1, misses: 0, matched: true,
          hist: [{ t, d: o.distance }], inZone: false, entryDone: false, urgentDone: false, approachDone: false, leftAt: null,
        });
      }
    }
    this.tracks = this.tracks.filter((tr) => tr.matched || ++tr.misses <= 3);

    // 2. Règles par piste
    for (const tr of this.tracks) {
      if (tr.misses > 0) continue;
      const confirmed = tr.hits >= 2 || tr.distance < URGENT;
      if (!confirmed) continue;
      const inCorridor = tr.latMin <= half && tr.latMax >= -half;
      const limit = tr.inZone ? range + HYST : range;
      const nowIn = inCorridor && tr.distance <= limit;
      const dir = dirWords(tr.angle);

      if (nowIn && !tr.inZone) {
        if (tr.leftAt != null && t - tr.leftAt > 5000) { tr.entryDone = false; tr.urgentDone = false; }
        tr.inZone = true;
      } else if (!nowIn && tr.inZone) {
        tr.inZone = false;
        tr.leftAt = t;
      }
      if (tr.distance > URGENT + 1) tr.urgentDone = false;

      if (tr.inZone) {
        out.beeps.push({ id: 't' + tr.id, angle: tr.angle, distance: tr.distance, kind: 'object', label: tr.label });
        if (!tr.entryDone) {
          tr.entryDone = true;
          if (tr.family === F.MOBILIER) {
            out.vibrate = out.vibrate || [200];
          } else if (tr.distance >= URGENT && t - this.lastEntrySpeech > 1500 && !this._recent(`${tr.label}|${dir}`, t, 5000)) {
            this.lastEntrySpeech = t;
            out.speech.push({ text: `${cap(tr.label)} ${dir}, ${fmtMeters(tr.distance)}.`, priority: 2, key: 'obs' });
          }
        }
        if (tr.distance < URGENT && !tr.urgentDone) {
          tr.urgentDone = true;
          out.vibrate = [120, 60, 120];
          out.speech.push({ text: `Stop, ${tr.label} ${dir}.`, priority: 3, key: 'urgent' });
        }
      } else if (tr.distance < 2 && Math.min(Math.abs(tr.latMin), Math.abs(tr.latMax)) < half + 1) {
        // Frôlement : obstacle proche sur le côté, hors du couloir
        out.beeps.push({ id: 't' + tr.id, angle: tr.angle, distance: tr.distance, kind: 'side', label: tr.label });
      }

      // Véhicule qui approche (décision Q1), même au-delà de la distance d'alerte
      if (tr.family === F.VEHICULE && !tr.approachDone && tr.hits >= 4 && tr.distance <= vehicleRange && tr.hist.length > 1) {
        const h0 = tr.hist[0];
        const dt = (t - h0.t) / 1000;
        const speed = dt > 0.8 ? (h0.d - tr.distance) / dt : 0;
        if (speed > 1.5) {
          tr.approachDone = true;
          out.speech.push({ text: `Attention, ${tr.label} qui approche ${dir}.`, priority: 3, key: 'vehicle' });
        }
      }
    }

    // 3. Bord de trottoir
    const curb = ctx.curb;
    const cs = this.curbState;
    if (curb && curb.distance <= range) {
      cs.lostAt = null;
      if (!cs.done) {
        cs.done = true;
        out.speech.push({ text: `Bord de trottoir, ${fmtMeters(curb.distance)}.`, priority: 2, key: 'curb' });
      }
    } else if (cs.done) {
      if (cs.lostAt == null) cs.lostAt = t;
      else if (t - cs.lostAt > 3000) cs.done = false;
    }

    // 4. Image trop sombre
    if (ctx.lum != null) {
      if (ctx.lum < 0.15) {
        if (this.darkSince == null) this.darkSince = t;
        else if (t - this.darkSince > 3000 && t - this.lastDarkWarn > 30000) {
          this.lastDarkWarn = t;
          out.speech.push({ text: 'Détection limitée : image trop sombre.', priority: 2, key: 'quality' });
        }
      } else this.darkSince = null;
    }

    out.tracks = this.tracks;
    return out;
  }

  _recent(key, t, ms) {
    const last = this.recentPhrases.get(key);
    if (last != null && t - last < ms) return true;
    this.recentPhrases.set(key, t);
    return false;
  }

  /** Phrase pour « qu'y a-t-il devant moi ? » */
  describe() {
    const vis = this.tracks.filter((tr) => tr.misses === 0 && tr.distance <= 8).sort((a, b) => a.distance - b.distance).slice(0, 5);
    if (!vis.length) return 'Je ne détecte rien de particulier devant vous.';
    return 'Devant vous : ' + vis.map((tr) => `${tr.label} ${dirWords(tr.angle)} à ${fmtMeters(tr.distance)}`).join(', ') + '.';
  }
}
