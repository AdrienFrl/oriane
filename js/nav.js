// ORIANE — moteur de guidage vocal piéton.
// Reçoit les positions (GPS ou simulation), suit l'avancée sur l'itinéraire
// et annonce virages, repères (passages piétons, feux), écarts et arrivée.

import { Polyline, haversine, bearing, angleDiff, fmtDist, fmtMeters, fmtDuration, relPhrase, clockHour, cap } from './util.js';

const ORD = ['', 'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième'];
const LM_AT = { crossing: 'au passage piéton', crossing_signals: 'au feu', signals: 'au feu' };
const LM_AFTER = { crossing: 'après le passage piéton', crossing_signals: 'après le feu', signals: 'après le feu' };

export function actionText(s) {
  const on = s.name ? ` sur ${s.name}` : '';
  if (s.kind === 'roundabout') {
    return s.exit ? `au rond-point, prenez la ${ORD[s.exit] || s.exit + 'e'} sortie${on}` : `au rond-point, continuez${on}`;
  }
  if (s.kind === 'straight') return `continuez tout droit${on}`;
  const verb =
    {
      left: 'tournez à gauche',
      right: 'tournez à droite',
      'slight left': 'tournez légèrement à gauche',
      'slight right': 'tournez légèrement à droite',
      'sharp left': 'tournez franchement à gauche',
      'sharp right': 'tournez franchement à droite',
      uturn: 'faites demi-tour',
      'keep left': 'restez sur la gauche',
      'keep right': 'restez sur la droite',
    }[s.mod] || 'continuez';
  return verb + on;
}

export class Navigator {
  constructor({ say, chime, log, onUpdate, onReroute, onArrive } = {}) {
    this.say = say || (() => {});
    this.chime = chime || (() => {});
    this.log = log || (() => {});
    this.onUpdate = onUpdate;
    this.onReroute = onReroute;
    this.onArrive = onArrive;
    this.active = false;
  }

  start(rt, dest, { reroute = false } = {}) {
    this.line = new Polyline(rt.pts);
    this.dest = dest;
    this.along = 0;
    this.offCount = 0;
    this.offRoute = false;
    this.lastReroute = reroute ? Date.now() : 0;
    this.wrongSince = null;
    this.lastWrongWarn = 0;
    this.landmarks = [];
    this.steps = this._prepareSteps(rt.steps || []);
    this.stepIdx = 0;
    this.oriented = false;
    this.startTime = Date.now();
    this.active = true;
    if (reroute) this.say('Nouvel itinéraire calculé.', { priority: 2 });
    else
      this.say(
        `Itinéraire trouvé : ${fmtDist(this.line.length)}, environ ${fmtDuration(rt.duration ?? this.line.length / 1.3)} à pied.`,
        { priority: 2 }
      );
    this._emit();
  }

  stop() {
    this.active = false;
  }

  /** Garde les vrais changements de direction, triés et dédoublonnés. */
  _prepareSteps(steps) {
    const out = [];
    let last = -Infinity;
    for (const s of steps) {
      if (s.kind !== 'turn' && s.kind !== 'roundabout') continue;
      const along = s.along ?? 0;
      if (along < 3 || along - last < 4) continue;
      out.push({ ...s, along, ann: {}, lm: null });
      last = along;
    }
    return out;
  }

  /** Repères OSM : on garde ceux à moins de 12 m du trajet et on fusionne les voisins. */
  setLandmarks(list) {
    if (!this.active) return;
    const lms = [];
    for (const l of list) {
      const p = this.line.project(l);
      if (p.dist <= 12 && p.along > this.along - 5) lms.push({ ...l, along: p.along, ann: false, used: false });
    }
    lms.sort((a, b) => a.along - b.along);
    const merged = [];
    for (const l of lms) {
      const prev = merged[merged.length - 1];
      if (prev && l.along - prev.along < 10) {
        const kinds = new Set([prev.kind, l.kind]);
        if (kinds.has('crossing_signals') || (kinds.has('crossing') && kinds.has('signals'))) prev.kind = 'crossing_signals';
        continue;
      }
      merged.push(l);
    }
    this.landmarks = merged;
    for (const s of this.steps) s.lm = this._lmFor(s.along);
    this.log(`${merged.length} repère(s) sur le trajet (passages piétons, feux).`);
  }

  _lmFor(along) {
    let best = null;
    for (const l of this.landmarks) {
      if (l.along < along - 25 || l.along > along + 8) continue;
      if (!best || Math.abs(l.along - along) < Math.abs(best.along - along)) best = l;
    }
    if (best) best.used = true;
    return best;
  }

  _phrase(s) {
    const act = actionText(s);
    const lm = s.lm;
    if (!lm) return act;
    return `${Math.abs(s.along - lm.along) <= 8 ? LM_AT[lm.kind] : LM_AFTER[lm.kind]}, ${act}`;
  }

  /** pos : { lat, lon, accuracy, heading (degrés, ou null), speed (m/s, ou null) } */
  update(pos) {
    if (!this.active) return;
    const now = Date.now();
    this.lastPos = pos;
    let p = this.line.project(pos, this.along, 40, 150);
    if (p.dist > 25) {
      const g = this.line.project(pos);
      if (g.dist < p.dist - 5) p = g;
    }
    const tol = Math.max(20, Math.min(45, (pos.accuracy || 10) * 1.5));
    this.offRoute = p.dist > tol;
    this.offDist = p.dist;
    if (this.offRoute) {
      this.offCount++;
      if (this.offCount >= 3 && now - this.lastReroute > 15000) {
        this.lastReroute = now;
        this.offCount = 0;
        this.say("Vous vous écartez de l'itinéraire. Je recalcule.", { priority: 3, key: 'nav' });
        this.chime('reroute');
        this.onReroute?.(pos);
      }
      this._emit();
      return;
    }
    this.offCount = 0;
    this.along = p.along;
    const remaining = Math.max(0, this.line.length - this.along);
    if (remaining < 8 || haversine(pos, this.dest) < 8) {
      this._arrive(pos);
      return;
    }
    this._orientation(pos, remaining);
    while (this.stepIdx < this.steps.length && this.steps[this.stepIdx].along < this.along - 5) {
      this.stepIdx++;
      this._afterManeuver();
    }
    this._announce();
    this._landmarkAnnounce();
    this._wrongWay(pos, now);
    this._emit();
  }

  _orientation(pos, remaining) {
    if (this.oriented) return;
    const heading = pos.heading;
    if (heading == null) {
      if (Date.now() - this.startTime < 4000) return;
      this.oriented = true;
      this._firstInstruction(null, remaining);
      return;
    }
    this.oriented = true;
    this._firstInstruction(angleDiff(heading, this.line.bearingAt(this.along + 5)), remaining);
  }

  _firstInstruction(rel, remaining) {
    const parts = [];
    if (rel != null) {
      if (Math.abs(rel) < 20) parts.push('Partez tout droit.');
      else if (Math.abs(rel) >= 135) parts.push('Pour commencer, faites demi-tour.');
      else parts.push(`Pour commencer, tournez-vous ${rel > 0 ? 'vers la droite' : 'vers la gauche'}, à ${clockHour(rel)} heures.`);
    }
    const st = this.steps[this.stepIdx];
    if (st) {
      const d = st.along - this.along;
      if (d > 30) parts.push(`Continuez sur ${fmtDist(d)}, puis ${this._phrase(st)}.`);
    } else {
      parts.push(`Continuez sur ${fmtDist(remaining)} jusqu'à destination.`);
    }
    if (parts.length) this.say(parts.join(' '), { priority: 2, key: 'nav' });
  }

  _announce() {
    const s = this.steps[this.stepIdx];
    if (!s) return;
    const d = s.along - this.along;
    const prevAlong = this.stepIdx > 0 ? this.steps[this.stepIdx - 1].along : 0;
    const slight = /slight|keep/.test(s.mod || '');
    const ph = this._phrase(s);
    if (d <= 9) {
      if (!s.ann.now) {
        s.ann.now = s.ann.near = s.ann.far = true;
        this.say(`${cap(actionText(s))} maintenant.`, { priority: 3, key: 'nav' });
        this.chime('turn');
      }
      return;
    }
    if (d <= 25) {
      if (!s.ann.near) {
        s.ann.near = s.ann.far = true;
        this.say(`Dans ${fmtDist(d)}, ${ph}.`, { priority: 2, key: 'nav' });
      }
      return;
    }
    if (d <= 60 && !slight && s.along - prevAlong > 70 && !s.ann.far) {
      s.ann.far = true;
      this.say(`Dans ${fmtDist(d)}, ${ph}.`, { priority: 2, key: 'nav' });
    }
  }

  _afterManeuver() {
    const next = this.steps[this.stepIdx];
    const d = next ? next.along - this.along : this.line.length - this.along;
    if (d > 50) this.say(`Continuez sur ${fmtDist(d)}.`, { priority: 1, key: 'nav' });
  }

  _landmarkAnnounce() {
    for (const l of this.landmarks) {
      if (l.ann || l.used) continue;
      const d = l.along - this.along;
      if (d < -5) {
        l.ann = true;
        continue;
      }
      if (d > 22) break;
      if (d > 4) {
        l.ann = true;
        const msg =
          l.kind === 'crossing'
            ? `Passage piéton dans ${fmtDist(d)}.`
            : l.kind === 'crossing_signals'
              ? `Passage piéton avec feu dans ${fmtDist(d)}. Soyez prudent en traversant.`
              : `Feu tricolore dans ${fmtDist(d)}.`;
        this.say(msg, { priority: 1 });
        break;
      }
    }
  }

  _wrongWay(pos, now) {
    if (pos.heading == null || pos.speed == null || pos.speed < 0.5) {
      this.wrongSince = null;
      return;
    }
    const rel = angleDiff(pos.heading, this.line.bearingAt(this.along + 5));
    if (Math.abs(rel) > 120) {
      if (!this.wrongSince) this.wrongSince = now;
      else if (now - this.wrongSince > 6000 && now - this.lastWrongWarn > 20000) {
        this.lastWrongWarn = now;
        this.say('Vous semblez aller dans la mauvaise direction. Faites demi-tour.', { priority: 3 });
      }
    } else this.wrongSince = null;
  }

  _arrive(pos) {
    this.active = false;
    const dist = haversine(pos, this.dest);
    let msg = 'Vous êtes arrivé à destination.';
    if (pos.heading != null && dist > 3) {
      const rel = angleDiff(pos.heading, bearing(pos, this.dest));
      msg = `Vous êtes arrivé. La destination est ${relPhrase(rel)}, à environ ${fmtMeters(dist)}.`;
    }
    this.say(msg, { priority: 3, key: 'nav' });
    this.chime('arrive');
    this._emit(true);
    this.onArrive?.();
  }

  repeat() {
    if (!this.active) return this.say('Aucun guidage en cours.', { priority: 2 });
    const s = this.steps[this.stepIdx];
    const rem = this.line.length - this.along;
    if (s) this.say(`Dans ${fmtDist(s.along - this.along)}, ${this._phrase(s)}.`, { priority: 2, key: 'nav' });
    else this.say(`Continuez sur ${fmtDist(rem)} jusqu'à destination.`, { priority: 2, key: 'nav' });
  }

  remainingText() {
    if (!this.active) return 'Aucun guidage en cours.';
    const rem = this.line.length - this.along;
    return `Il reste ${fmtDist(rem)}, environ ${fmtDuration(rem / 1.3)}.`;
  }

  _emit(arrived = false) {
    if (!this.onUpdate) return;
    const s = this.steps?.[this.stepIdx];
    const remaining = this.line ? Math.max(0, this.line.length - this.along) : 0;
    let instr;
    if (arrived) instr = 'Arrivé à destination';
    else if (this.offRoute) instr = `Hors itinéraire (${Math.round(this.offDist)} m)`;
    else if (s) instr = `Dans ${fmtDist(s.along - this.along)} : ${cap(this._phrase(s))}`;
    else instr = 'Continuez jusqu’à destination';
    this.onUpdate({ instr, remaining, total: this.line?.length || 0, offRoute: this.offRoute, arrived });
  }
}
