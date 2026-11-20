// ORIANE v2.2 — instruments de mesure (lot 2.2-0) : compteur d'alertes, journal détaillé, export CSV.
// Module pur : testé sous Node. Les événements viennent de AlertManager.update(...).events.

import { dirWords } from './alerts.js';

const num = (v, d = 1) => (v == null || !isFinite(v) ? '' : v.toFixed(d).replace('.', ','));

/** Une alerte « compte » si elle a été émise (bip, vibration, voix) et n'est pas un message technique. */
export const counts = (e) => e.emitted && e.type !== 'qualite';

/**
 * Compteur d'alertes (H1, bêta) : dernière minute glissante et moyenne par minute de marche.
 * Cible NFR-20 : ≤ 2 alertes non dangereuses par minute en marche, rue calme.
 */
export class AlertCounter {
  constructor({ windowMs = 60000 } = {}) {
    this.windowMs = windowMs;
    this.reset();
  }

  reset() {
    this.recent = [];
    this.total = { alerts: 0, nonDanger: 0, danger: 0 };
    this.byKey = {};
    this.movingMs = 0;
    this.elapsedMs = 0;
    this.lastT = null;
  }

  /** À chaque analyse : temps courant, marche ou non, événements de l'analyse. */
  add(t, moving, events = []) {
    if (this.lastT != null) {
      const dt = Math.min(2000, Math.max(0, t - this.lastT)); // trou de plus de 2 s : non compté
      this.elapsedMs += dt;
      if (moving) this.movingMs += dt;
    }
    this.lastT = t;
    for (const e of events) {
      if (!counts(e)) continue;
      this.total.alerts++;
      if (e.danger) this.total.danger++;
      else this.total.nonDanger++;
      const k = e.key || e.type;
      this.byKey[k] = (this.byKey[k] || 0) + 1;
      this.recent.push({ t, danger: e.danger });
    }
    this._prune(t);
  }

  _prune(t) {
    while (this.recent.length && t - this.recent[0].t > this.windowMs) this.recent.shift();
  }

  /** Alertes sur la dernière minute glissante. */
  lastMinute(t) {
    this._prune(t);
    const danger = this.recent.filter((x) => x.danger).length;
    return { alerts: this.recent.length, danger, nonDanger: this.recent.length - danger };
  }

  /** Alertes non dangereuses par minute de marche (null avant 10 s de marche). */
  perMovingMinute() {
    return this.movingMs >= 10000 ? this.total.nonDanger / (this.movingMs / 60000) : null;
  }

  summary() {
    return {
      ...this.total,
      byKey: { ...this.byKey },
      movingMin: this.movingMs / 60000,
      elapsedMin: this.elapsedMs / 60000,
      perMovingMinute: this.perMovingMinute(),
    };
  }
}

/** Texte court pour la barre d'état. */
export function counterStatus(counter, t) {
  const m = counter.lastMinute(t);
  const avg = counter.perMovingMinute();
  return `alertes 1 min : ${m.nonDanger} + ${m.danger} danger` + (avg != null ? ` · moyenne ${num(avg)}/min en marche` : '') + ' (bêta)';
}

/** Durée lisible : « 45 s », « 2 min 05 s ». */
export function fmtDuration(ms) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} s`;
}

/** Résumé en une phrase (fin de rejeu, journal). */
export function summaryText(s) {
  const avg = s.perMovingMinute != null ? `${num(s.perMovingMinute)} par minute de marche` : 'marche trop courte pour une moyenne';
  return `${s.alerts} alerte(s) dont ${s.danger} danger(s) ; ${s.nonDanger} hors danger, ${avg} (cible ≤ 2) ; ` +
    `${fmtDuration(s.movingMin * 60000)} de marche sur ${fmtDuration(s.elapsedMin * 60000)}.`;
}

const TYPE_LABEL = {
  entree: 'Entrée', danger: 'Danger', bips: 'Bips', vehicule: 'Véhicule', trottoir: 'Trottoir', qualite: 'Qualité',
};

/** Ligne de journal détaillé, en français. */
export function formatEvent(e) {
  const parts = [`${TYPE_LABEL[e.type] || e.type} · ${e.label}`];
  if (e.distance != null) parts.push(`${num(e.distance)} m`);
  if (e.id != null) parts.push(dirWords(e.angle));
  if (e.speed != null) parts.push(e.speed >= 0 ? `rapproche ${num(e.speed)} m/s` : `s'éloigne ${num(-e.speed)} m/s`);
  if (e.ttc != null) parts.push(`TTC ${num(e.ttc)} s`);
  if (e.level) parts.push(`niveau ${e.level}`);
  let s = (e.emitted ? '🔔 ' : '· ') + parts.join(' · ');
  s += e.emitted ? ` → ${e.output}` : ` → retenu : ${e.blocked}`;
  if (e.reason) s += ` [${e.reason}]`;
  return s;
}

const CSV_COLS = [
  ['temps', null], ['type', 'type'], ['emis', 'emitted'], ['danger', 'danger'], ['objet', 'label'], ['cle', 'key'],
  ['niveau', 'level'], ['distance_m', 'distance'], ['angle_deg', 'angle'], ['lateral_m', 'lateral'],
  ['vitesse_rapprochement_m_s', 'speed'], ['ttc_s', 'ttc'], ['en_marche', 'moving'], ['sortie', 'output'],
  ['retenu', 'blocked'], ['raison', 'reason'],
];

const cell = (v) => {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'number') return num(v, 2);
  const s = String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Événements → CSV (séparateur « ; », virgule décimale, pour un tableur en français).
 * time(e) donne la première colonne (par défaut : secondes depuis t0).
 */
export function eventsToCsv(events, { t0 = 0, time } = {}) {
  const head = CSV_COLS.map((c) => c[0]).join(';');
  const rows = events.map((e) => CSV_COLS.map(([, k]) => (k ? cell(e[k]) : time ? cell(time(e)) : num((e.t - t0) / 1000, 2))).join(';'));
  return [head, ...rows].join('\n') + '\n';
}
