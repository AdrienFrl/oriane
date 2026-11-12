// ORIANE — utilitaires : géométrie, formats en français, stockage local.

export const EARTH_R = 6371008.8;
export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Distance en mètres entre deux points {lat, lon}. */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Cap (0 = nord, 90 = est) de a vers b, en degrés. */
export function bearing(a, b) {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Angle signé pour passer de `from` à `to` (-180..180, positif = à droite). */
export function angleDiff(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Décale un point de northM mètres vers le nord et eastM vers l'est. */
export function offset(p, northM, eastM) {
  return {
    lat: p.lat + toDeg(northM / EARTH_R),
    lon: p.lon + toDeg(eastM / (EARTH_R * Math.cos(toRad(p.lat)))),
  };
}

/** Ligne d'itinéraire : projection d'une position, point à une distance donnée. */
export class Polyline {
  constructor(pts) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + haversine(pts[i - 1], pts[i]));
    this.length = this.cum[this.cum.length - 1] || 0;
  }

  _seg(i, p) {
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const k = Math.cos(toRad(a.lat)) * EARTH_R;
    const bx = toRad(b.lon - a.lon) * k;
    const by = toRad(b.lat - a.lat) * EARTH_R;
    const px = toRad(p.lon - a.lon) * k;
    const py = toRad(p.lat - a.lat) * EARTH_R;
    const L2 = bx * bx + by * by;
    const t = L2 > 0 ? clamp((px * bx + py * by) / L2, 0, 1) : 0;
    return {
      dist: Math.hypot(px - t * bx, py - t * by),
      along: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]),
      seg: i,
    };
  }

  /** Projette p sur la ligne. Avec `hint`, ne cherche qu'autour de cette distance parcourue. */
  project(p, hint = null, back = 40, fwd = 150) {
    if (this.pts.length < 2) {
      return { dist: this.pts.length ? haversine(p, this.pts[0]) : Infinity, along: 0, seg: 0 };
    }
    let best = null;
    for (let i = 0; i < this.pts.length - 1; i++) {
      if (hint != null && (this.cum[i + 1] < hint - back || this.cum[i] > hint + fwd)) continue;
      const r = this._seg(i, p);
      if (!best || r.dist < best.dist) best = r;
    }
    return best || this.project(p);
  }

  pointAt(along) {
    along = clamp(along, 0, this.length);
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] <= along) lo = m;
      else hi = m;
    }
    const segLen = this.cum[hi] - this.cum[lo];
    const t = segLen > 0 ? (along - this.cum[lo]) / segLen : 0;
    const a = this.pts[lo];
    const b = this.pts[hi];
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  }

  /** Direction de l'itinéraire autour d'une distance parcourue. */
  bearingAt(along) {
    return bearing(this.pointAt(along - 2), this.pointAt(along + 8));
  }
}

// ---------- Formats parlés ----------

export function roundDist(m) {
  if (m < 12) return Math.max(5, Math.round(m / 5) * 5);
  if (m < 100) return Math.round(m / 10) * 10;
  if (m < 1000) return Math.round(m / 50) * 50;
  return Math.round(m / 100) * 100;
}

/** Distance de guidage arrondie : « 20 mètres », « 1,5 kilomètre ». */
export function fmtDist(m) {
  const r = roundDist(m);
  if (r >= 1000) {
    const km = r / 1000;
    const s = Number.isInteger(km) ? String(km) : km.toFixed(1).replace('.', ',');
    return `${s} kilomètre${km >= 2 ? 's' : ''}`;
  }
  return `${r} mètres`;
}

/** Distance d'objet au mètre près : « 1 mètre », « 6 mètres ». */
export function fmtMeters(m) {
  const r = Math.max(1, Math.round(m));
  return r === 1 ? '1 mètre' : `${r} mètres`;
}

export function fmtDuration(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} minute${min > 1 ? 's' : ''}`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return `${h} heure${h > 1 ? 's' : ''}${r ? ' ' + r : ''}`;
}

/** Direction relative en mots (angle positif = droite). */
export function relPhrase(rel) {
  const a = Math.abs(rel);
  if (a < 15) return 'devant vous';
  if (a < 45) return rel > 0 ? 'légèrement à droite' : 'légèrement à gauche';
  if (a < 135) return rel > 0 ? 'à droite' : 'à gauche';
  return 'derrière vous';
}

/** Direction façon horloge (12 h = devant, 3 h = droite). */
export function clockHour(rel) {
  const h = Math.round((((rel % 360) + 360) % 360) / 30) % 12;
  return h === 0 ? 12 : h;
}

/** Minuscules sans accents, pour comparer les commandes vocales. */
export function norm(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .trim();
}

// ---------- Stockage local (peut être indisponible) ----------

export const store = {
  get(k, def) {
    try {
      const v = localStorage.getItem('oriane.' + k);
      return v === null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('oriane.' + k, JSON.stringify(v));
    } catch {
      /* stockage indisponible : réglage gardé pour la session */
    }
  },
};
