// ORIANE v2.1 — gestionnaire d'alertes avec priorisation (questionnaire du 20/11/2026).
// v2.2-0 : chaque décision est décrite dans `events` (journal détaillé : raison, vitesse, TTC,
// ce qui a été émis ou pourquoi l'alerte a été retenue). Les décisions elles-mêmes sont inchangées.
//
// Niveaux par type d'obstacle :
//   urgent : niveau 1, voix + vibration longue dès l'entrée dans la zone, coupe tout le reste
//   voix   : niveau 2, un bip + une phrase courte (bip seul pendant un guidage)
//   son    : niveau 2, un bip seul ; la phrase seulement en danger
//   vibre  : niveau 3, une vibration courte ; la phrase seulement en danger
//   danger : niveau 3, rien, sauf en danger (sous la distance de danger)
//   jamais : niveau 4, seulement sur demande (« qu'y a-t-il devant moi »)
// Garde-fous : un seul bip à l'apparition, bips continus seulement sous 2 m et pour le plus proche,
// silence quand on est immobile (sauf danger), alerte seulement si l'obstacle se rapproche,
// 2 s minimum entre deux annonces non urgentes, « plusieurs obstacles » regroupés,
// pas de répétition sauf si l'obstacle devient dangereux, commande « silence » (sauf dangers).
// Module pur : testé sous Node.

import { F } from './classes.js';
import { fmtMeters, cap } from './util.js';

const HYST = 0.6;
const CONTINUOUS_BELOW = 2;

export const LEVEL_RANK = { urgent: 5, voix: 4, son: 3, vibre: 2, danger: 1, jamais: 0 };

export const LEVEL_LABELS = {
  urgent: 'Niveau 1 : toujours en danger (voix + vibration)',
  voix: 'Niveau 2 : bip + phrase courte',
  son: 'Niveau 2 : bip seul',
  vibre: 'Niveau 3 : vibration seule',
  danger: 'Niveau 3 : rien, sauf en danger',
  jamais: 'Niveau 4 : seulement sur demande',
};

export const LEVEL_KEYS = {
  vehicule_approche: 'Véhicule qui approche',
  trottoir: 'Bord de trottoir',
  escalier: 'Escalier, marche',
  eau: 'Eau',
  vitre: 'Vitre, porte vitrée',
  poteau: 'Poteau, lampadaire, panneau',
  poubelle: 'Poubelle',
  inconnu: 'Obstacle non reconnu',
  porte: 'Porte',
  mobilier: 'Mobilier',
  mur: 'Mur, façade, barrière',
  personne: 'Personne',
  vehicule_arret: 'Véhicule à l’arrêt',
  vegetation: 'Arbre, végétation',
};

/** Réponses d'Adrien au questionnaire (profil « aveugle »). */
export const PRESETS = {
  aveugle: {
    vehicule_approche: 'urgent', trottoir: 'son', escalier: 'urgent', eau: 'vibre', vitre: 'urgent',
    poteau: 'son', poubelle: 'son', inconnu: 'son', porte: 'vibre', mobilier: 'vibre', mur: 'danger',
    personne: 'voix', vehicule_arret: 'danger', vegetation: 'danger',
  },
  malvoyant: {
    vehicule_approche: 'urgent', trottoir: 'son', escalier: 'urgent', eau: 'vibre', vitre: 'voix',
    poteau: 'son', poubelle: 'vibre', inconnu: 'vibre', porte: 'danger', mobilier: 'danger', mur: 'danger',
    personne: 'danger', vehicule_arret: 'danger', vegetation: 'danger',
  },
};

const FAMILY_KEY = {
  [F.MUR]: 'mur', [F.PORTE]: 'porte', [F.VITRE]: 'vitre', [F.POTEAU]: 'poteau', [F.POUBELLE]: 'poubelle',
  [F.MOBILIER]: 'mobilier', [F.ESCALIER]: 'escalier', [F.PERSONNE]: 'personne', [F.VEHICULE]: 'vehicule_arret',
  [F.ARBRE]: 'vegetation', [F.EAU]: 'eau', [F.OBSTACLE]: 'inconnu',
};

/** Motifs de vibration : long = danger, court = information. */
export const VIB = { danger: [400, 120, 400], info: [80], confirm: [40, 40, 40] };

export function dirShort(angle) {
  if (angle < -10) return 'gauche';
  if (angle > 10) return 'droite';
  return 'devant';
}

export function dirWords(angle) {
  if (angle < -20) return 'à gauche';
  if (angle < -8) return 'légèrement à gauche';
  if (angle <= 8) return 'devant';
  if (angle <= 20) return 'légèrement à droite';
  return 'à droite';
}

const fmtNum = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
const short = (label, d, angle) => `${cap(label)}, ${fmtMeters(d)}, ${dirShort(angle)}.`;

export class AlertManager {
  constructor(settings) {
    this.s = settings;
    this.tracks = [];
    this.nextId = 1;
    this.lastEntrySpeech = -Infinity;
    this.curbState = { done: false, danger: false, lostAt: null };
    this.darkSince = null;
    this.lastDarkWarn = -Infinity;
    this.beepId = null;
  }

  reset() {
    this.tracks = [];
    this.curbState = { done: false, danger: false, lostAt: null };
    this.beepId = null;
  }

  levelOf(key) {
    return { ...PRESETS.aveugle, ...(this.s.levels || {}) }[key] || 'son';
  }

  /** L'obstacle se rapproche : baisse d'au moins 15 cm sur au moins 0,4 s. */
  _approaching(tr) {
    const h = tr.hist;
    if (h.length < 2) return false;
    const a = h[0];
    const b = h[h.length - 1];
    return b.t - a.t >= 400 && a.d - b.d >= 0.15;
  }

  /** Pour le journal : baisse de distance mesurée par _approaching, en clair. */
  _approachText(tr) {
    const h = tr.hist;
    const a = h[0];
    const b = h[h.length - 1];
    return `se rapproche : ${(a.d - b.d).toFixed(2).replace('.', ',')} m en ${((b.t - a.t) / 1000).toFixed(1).replace('.', ',')} s`;
  }

  /**
   * Pour le journal : vitesse de rapprochement (m/s, positive = se rapproche) par régression
   * sur l'historique de la piste (≤ 1,5 s), et temps avant collision. N'influence aucune décision.
   */
  _kin(tr) {
    const h = tr.hist;
    if (h.length < 2) return { speed: null, ttc: null };
    let mt = 0;
    let md = 0;
    for (const p of h) { mt += p.t; md += p.d; }
    mt /= h.length;
    md /= h.length;
    let num = 0;
    let den = 0;
    for (const p of h) { num += (p.t - mt) * (p.d - md); den += (p.t - mt) ** 2; }
    if (den <= 0) return { speed: null, ttc: null };
    const speed = (-num / den) * 1000;
    return { speed, ttc: speed > 0.05 ? tr.distance / speed : null };
  }

  /**
   * obstacles : [{ family, label, distance, lateral, latMin, latMax, angle }]
   * ctx : { t, curb, lum, moving, indoor, navActive, muted }
   * Renvoie { beeps (bips continus), pings (bips uniques), speech, vibrate, tracks, events }
   * events : [{ t, type, id, key, label, level, distance, angle, lateral, speed, ttc, moving,
   *            reason, output, emitted, blocked, danger }] — une ligne par décision (journal détaillé).
   */
  update(obstacles, ctx) {
    const t = ctx.t;
    const s = this.s;
    const range = s.alertRange ?? 3;
    const half = (s.corridorWidth ?? 1.2) / 2;
    const urgentDist = s.urgentDist ?? 1.5;
    const vehicleRange = s.vehicleRange ?? 10;
    const gapMs = (s.minGap ?? 2) * 1000;
    const moving = ctx.moving !== false;
    const muted = !!ctx.muted;
    const indoor = !!ctx.indoor;
    const nav = !!ctx.navActive;
    const out = { beeps: [], pings: [], speech: [], vibrate: null };
    const vibrate = (p) => {
      if (!out.vibrate || p === VIB.danger) out.vibrate = p;
    };
    const events = [];
    const ev = (type, tr, o) => {
      events.push({
        t, type, id: tr ? tr.id : null,
        key: o.key ?? (tr ? FAMILY_KEY[tr.family] : null),
        label: tr ? tr.label : o.label,
        level: o.level ?? tr?.level ?? null,
        distance: tr ? tr.distance : o.distance ?? null,
        angle: tr ? tr.angle : 0,
        lateral: tr ? tr.lateral : 0,
        ...(tr ? this._kin(tr) : { speed: null, ttc: null }),
        moving,
        reason: o.reason || '', output: o.output || '', emitted: !!o.emitted, blocked: o.blocked || '', danger: !!o.danger,
      });
    };

    // 1. Suivi des obstacles d'une analyse à l'autre
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
        const a = o.distance < urgentDist ? 0.8 : 0.5;
        best.distance = best.distance * (1 - a) + o.distance * a;
        best.angle = best.angle * 0.5 + o.angle * 0.5;
        Object.assign(best, { lateral: o.lateral, latMin: o.latMin, latMax: o.latMax, label: o.label, matched: true, misses: 0 });
        best.hits++;
        best.hist.push({ t, d: best.distance });
        while (best.hist.length > 2 && t - best.hist[0].t > 1500) best.hist.shift();
      } else {
        this.tracks.push({
          id: this.nextId++, family: o.family, label: o.label, distance: o.distance, angle: o.angle,
          lateral: o.lateral, latMin: o.latMin, latMax: o.latMax, hits: 1, misses: 0, matched: true,
          hist: [{ t, d: o.distance }], inZone: false, entryDone: false, urgentDone: false, approachDone: false,
        });
      }
    }
    this.tracks = this.tracks.filter((tr) => tr.matched || ++tr.misses <= 3);

    // 2. Règles par obstacle
    const entries = [];
    let nearest = null;
    for (const tr of this.tracks) {
      if (tr.misses > 0) continue;
      if (!(tr.hits >= 2 || tr.distance < urgentDist)) continue;
      const level = this.levelOf(FAMILY_KEY[tr.family]);
      tr.level = level;
      const crossesAxis = tr.latMin <= 0 && tr.latMax >= 0;
      let inCorridor = tr.latMin <= half && tr.latMax >= -half;
      let dangerDist = urgentDist;
      if (tr.family === F.MUR && indoor) {
        // En intérieur : murs seulement droit devant, à moins de 2 m
        if (!crossesAxis) inCorridor = false;
        dangerDist = Math.max(urgentDist, 2);
      }
      const nowIn = inCorridor && tr.distance <= (tr.inZone ? range + HYST : range);
      tr.inZone = nowIn;
      if (tr.distance > dangerDist + 1) tr.urgentDone = false;
      if (!tr.inZone || level === 'jamais') continue;

      const inDanger = tr.distance < dangerDist;
      // Entrée dans la zone : seulement si l'obstacle se rapproche (ou est déjà dangereux)
      if (!tr.entryDone && (this._approaching(tr) || inDanger)) {
        tr.entryDone = true;
        const allowed = level === 'urgent' || (moving && !muted);
        if (allowed && !inDanger && LEVEL_RANK[level] >= 2) {
          tr.entryAt = t;
          entries.push({ tr, level, reason: `entrée dans la zone (${fmtNum(range)} m), ${this._approachText(tr)}` });
        } else if (!inDanger) {
          ev('entree', tr, {
            reason: `entrée dans la zone (${fmtNum(range)} m), ${this._approachText(tr)}`,
            blocked: LEVEL_RANK[level] < 2 ? `niveau « ${level} » : rien hors danger` : muted ? 'mode silence' : 'immobile',
          });
        }
      }
      // Danger : toujours signalé, même immobile ou en mode silence
      if (inDanger && !tr.urgentDone) {
        tr.urgentDone = true;
        out.speech.push({ text: `Stop, ${tr.label}, ${dirShort(tr.angle)}.`, priority: 3, key: 'urgent' });
        vibrate(VIB.danger);
        ev('danger', tr, {
          reason: `à ${fmtNum(tr.distance)} m, sous la distance de danger (${fmtNum(dangerDist)} m)`,
          output: 'voix « Stop » + vibration longue', emitted: true, danger: true,
        });
      }
      // Bips continus : en marche, sous 2 m, pour un seul obstacle (le plus proche)
      if (moving && tr.distance < CONTINUOUS_BELOW && (LEVEL_RANK[level] >= 3 || inDanger)) {
        if (!nearest || tr.distance < nearest.distance) nearest = tr;
      }
    }
    if (nearest) out.beeps.push({ id: 't' + nearest.id, angle: nearest.angle, distance: nearest.distance, kind: 'object', label: nearest.label });
    if (nearest && nearest.id !== this.beepId) {
      ev('bips', nearest, { reason: `obstacle le plus proche, sous ${CONTINUOUS_BELOW} m`, output: 'bips continus', emitted: true });
    }
    this.beepId = nearest ? nearest.id : null;

    // 3. Annonces d'entrée : la plus importante d'abord, « plusieurs obstacles » si besoin
    if (entries.length) {
      entries.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.tr.distance - b.tr.distance);
      const top = entries[0];
      const sound = entries.find((e) => LEVEL_RANK[e.level] >= 3);
      if (sound) out.pings.push({ angle: sound.tr.angle, distance: sound.tr.distance });
      const anyUrgent = entries.some((e) => e.level === 'urgent');
      if (anyUrgent) vibrate(VIB.danger);
      else if (entries.some((e) => e.level === 'vibre')) vibrate(VIB.info);
      const speak = entries.find((e) => e.level === 'urgent' || (e.level === 'voix' && !nav));
      let spoken = null;
      let groupSaid = false;
      if (speak && (speak.level === 'urgent' || t - this.lastEntrySpeech >= gapMs)) {
        spoken = speak;
        this.lastEntrySpeech = t;
        const phrase = short(speak.tr.label, speak.tr.distance, speak.tr.angle);
        // Obstacles apparus ensemble (moins d'une seconde d'écart) : regroupés
        const together = this.tracks.filter((x) => x.inZone && x.entryAt != null && t - x.entryAt <= 1000 && LEVEL_RANK[x.level] >= 2).length;
        out.speech.push({
          text: together > 1 ? `Plusieurs obstacles. ${phrase}` : phrase,
          priority: speak.level === 'urgent' ? 3 : 1,
          key: 'obs',
        });
      } else if (entries.length > 1 && top.level !== 'vibre' && !nav && t - this.lastEntrySpeech >= gapMs && entries.some((e) => e.level === 'son')) {
        this.lastEntrySpeech = t;
        out.speech.push({ text: 'Plusieurs obstacles devant.', priority: 1, key: 'obs' });
        groupSaid = true;
      }
      // Journal : ce que chaque obstacle entré a déclenché
      for (const e of entries) {
        const outs = [];
        if (e === sound) outs.push('bip');
        if (e === spoken) outs.push(out.speech[out.speech.length - 1].text.startsWith('Plusieurs') ? 'voix (regroupée)' : 'voix');
        if (groupSaid && e === top) outs.push('voix « Plusieurs obstacles devant »');
        if (e.level === 'urgent') outs.push('vibration longue');
        else if (e.level === 'vibre' && !anyUrgent) outs.push('vibration courte');
        let blocked = '';
        if (e === speak && !spoken) blocked = `voix retenue : moins de ${fmtNum(gapMs / 1000)} s depuis la dernière annonce`;
        else if (!outs.length) blocked = e.level === 'voix' && nav ? 'guidage en cours' : 'regroupé avec un obstacle plus important';
        ev('entree', e.tr, { level: e.level, reason: e.reason, output: outs.join(' + '), emitted: outs.length > 0, blocked, danger: e.level === 'urgent' });
      }
    }

    // 4. Véhicule qui approche (jusqu'à 10 m)
    const vLevel = this.levelOf('vehicule_approche');
    for (const tr of this.tracks) {
      if (tr.family !== F.VEHICULE || tr.misses > 0 || tr.approachDone || vLevel === 'jamais') continue;
      if (tr.hits < 4 || tr.distance > vehicleRange || tr.hist.length < 2) continue;
      const h0 = tr.hist[0];
      const dt = (t - h0.t) / 1000;
      const speed = dt > 0.8 ? (h0.d - tr.distance) / dt : 0;
      if (speed <= 1.5) continue;
      tr.approachDone = true;
      let output = '';
      if (vLevel === 'urgent' || vLevel === 'voix') {
        out.speech.push({ text: `Attention, ${tr.label} qui approche, ${dirShort(tr.angle)}.`, priority: 3, key: 'vehicle' });
        vibrate(VIB.danger);
        output = 'voix « Attention » + vibration longue';
      } else if (vLevel === 'son') {
        out.pings.push({ angle: tr.angle, distance: tr.distance });
        output = 'bip';
      } else if (vLevel === 'vibre') {
        vibrate(VIB.info);
        output = 'vibration courte';
      }
      ev('vehicule', tr, {
        key: 'vehicule_approche', level: vLevel,
        reason: `rapprochement ${fmtNum(speed)} m/s sur ${fmtNum(dt)} s (seuil 1,5 m/s, vitesse de marche non retirée)`,
        output, emitted: !!output, blocked: output ? '' : `niveau « ${vLevel} »`, danger: vLevel === 'urgent',
      });
    }

    // 5. Bord de trottoir
    const curb = ctx.curb;
    const cs = this.curbState;
    const cLevel = this.levelOf('trottoir');
    if (curb && curb.distance <= range && cLevel !== 'jamais') {
      cs.lostAt = null;
      if (!cs.done) {
        cs.done = true;
        const allowed = cLevel === 'urgent' || (moving && !muted);
        const curbEv = { key: 'trottoir', label: 'bord de trottoir', level: cLevel, distance: curb.distance, reason: `bordure à ${fmtNum(curb.distance)} m` };
        let output = '';
        if (allowed && curb.distance >= urgentDist) {
          if (cLevel === 'urgent') {
            out.speech.push({ text: `Bord de trottoir, ${fmtMeters(curb.distance)}.`, priority: 3, key: 'curb' });
            vibrate(VIB.danger);
            output = 'voix + vibration longue';
          } else if (cLevel === 'voix' && !nav) {
            out.speech.push({ text: `Bord de trottoir, ${fmtMeters(curb.distance)}.`, priority: 1, key: 'curb' });
            out.pings.push({ angle: 0, distance: curb.distance });
            output = 'bip + voix';
          } else if (cLevel === 'voix' || cLevel === 'son') {
            out.pings.push({ angle: 0, distance: curb.distance });
            output = 'bip';
          } else if (cLevel === 'vibre') {
            vibrate(VIB.info);
            output = 'vibration courte';
          }
        }
        if (curb.distance >= urgentDist) {
          ev('trottoir', null, {
            ...curbEv, output, emitted: !!output, danger: cLevel === 'urgent',
            blocked: output ? '' : !allowed ? (muted ? 'mode silence' : 'immobile') : `niveau « ${cLevel} »`,
          });
        }
      }
      if (curb.distance < urgentDist && !cs.danger) {
        cs.danger = true;
        out.speech.push({ text: 'Stop, bord de trottoir.', priority: 3, key: 'curb' });
        vibrate(VIB.danger);
        ev('danger', null, {
          key: 'trottoir', label: 'bord de trottoir', level: cLevel, distance: curb.distance,
          reason: `bordure à ${fmtNum(curb.distance)} m, sous la distance de danger (${fmtNum(urgentDist)} m)`,
          output: 'voix « Stop » + vibration longue', emitted: true, danger: true,
        });
      }
    } else if (cs.done || cs.danger) {
      if (cs.lostAt == null) cs.lostAt = t;
      else if (t - cs.lostAt > 3000) Object.assign(cs, { done: false, danger: false });
    }

    // 6. Image trop sombre
    if (ctx.lum != null) {
      if (ctx.lum < 0.15) {
        if (this.darkSince == null) this.darkSince = t;
        else if (t - this.darkSince > 3000 && t - this.lastDarkWarn > 30000) {
          this.lastDarkWarn = t;
          out.speech.push({ text: 'Détection limitée : image trop sombre.', priority: 1, key: 'quality' });
          ev('qualite', null, { key: 'qualite', label: 'image sombre', reason: 'image trop sombre depuis 3 s', output: 'voix', emitted: true });
        }
      } else this.darkSince = null;
    }

    out.tracks = this.tracks;
    out.events = events;
    return out;
  }

  /** Phrase pour « qu'y a-t-il devant moi ? » : tout ce qui est vu, quel que soit le niveau. */
  describe() {
    const vis = this.tracks.filter((tr) => tr.misses === 0 && tr.distance <= 8).sort((a, b) => a.distance - b.distance).slice(0, 5);
    if (!vis.length) return 'Je ne détecte rien de particulier devant vous.';
    return 'Devant vous : ' + vis.map((tr) => `${tr.label} ${dirWords(tr.angle)} à ${fmtMeters(tr.distance)}`).join(', ') + '.';
  }
}
