// ORIANE v2 — géométrie au sol : carte de classes → obstacles avec distance, angle et écart latéral.
//
// Principe : on remonte chaque colonne de l'image depuis le bas. Tant que c'est du sol praticable,
// on continue ; le premier pixel qui n'est pas du sol est le pied de l'obstacle. Sa ligne dans
// l'image donne la distance, connaissant la hauteur et l'inclinaison du téléphone :
//   d = h / tan(θ + atan((y − cy) / f))
// Fonctions pures : utilisables dans le worker et testées sous Node.

import { F, CLASS_FAMILY, CLASS_TABLE, isWalkable } from './classes.js';

const RAD = Math.PI / 180;

/**
 * Caméra exprimée dans les coordonnées de la carte de classes.
 * La carte couvre la largeur complète de l'image et sa partie basse (à partir de cropTop).
 */
export function makeCamera({ frameW, frameH, labelW, cropTop, fovDeg, pitchDeg, camHeight }) {
  const s = labelW / frameW;
  const fullH = frameH * s;
  return {
    f: (Math.max(frameW, frameH) * s) / 2 / Math.tan((fovDeg * RAD) / 2),
    cx: labelW / 2,
    cy: fullH / 2,
    yOff: cropTop * fullH,
    pitch: pitchDeg,
    h: camHeight,
  };
}

/** Distance au sol (m) du bord de ligne y de la carte (y fractionnaire accepté). Infinity au-dessus de l'horizon. */
export function groundDistance(cam, y) {
  const a = cam.pitch + Math.atan((y + cam.yOff - cam.cy) / cam.f) / RAD;
  return a > 1 ? cam.h / Math.tan(a * RAD) : Infinity;
}

/** Écart latéral (m) d'un point du sol à distance d, vu à la colonne x. */
export function lateralAt(cam, x, d) {
  const th = cam.pitch * RAD;
  const z = d * Math.cos(th) + cam.h * Math.sin(th);
  return ((x - cam.cx) / cam.f) * z;
}

/** Projection d'un point du sol (devant d, latéral l) dans l'image complète, en pixels. */
export function projectGround({ frameW, frameH, fovDeg, pitchDeg, camHeight }, d, l) {
  const f = Math.max(frameW, frameH) / 2 / Math.tan((fovDeg * RAD) / 2);
  const th = pitchDeg * RAD;
  const z = d * Math.cos(th) + camHeight * Math.sin(th);
  const y = camHeight * Math.cos(th) - d * Math.sin(th);
  if (z <= 0.05) return null;
  return { u: frameW / 2 + (f * l) / z, v: frameH / 2 + (f * y) / z };
}

/**
 * labels : Uint8Array (lw × lh) d'index de classes ADE20K.
 * o : { frameW, frameH, cropTop, fovDeg, pitchDeg, camHeight, corridorHalf, maxDist }
 * Renvoie { obstacles: [...], curb: {distance, coverage} | null }.
 */
export function analyze(labels, lw, lh, o) {
  const cam = makeCamera({ ...o, labelW: lw });
  const binW = 2;
  const nb = Math.floor(lw / binW);
  const maxDist = o.maxDist ?? 12;
  const famAt = (b, y) => {
    let res = -1;
    for (let x = b * binW; x < (b + 1) * binW; x++) {
      const f = CLASS_FAMILY[labels[y * lw + x]];
      if (res === -1 || (isWalkable(res) && !isWalkable(f))) res = f;
    }
    return res;
  };

  const cols = [];
  const curbCols = [];
  for (let b = 0; b < nb; b++) {
    let contact = -1;
    let solRows = 0;
    let curbRow = -1;
    for (let y = lh - 1; y >= 0; y--) {
      const f = famAt(b, y);
      if (isWalkable(f)) {
        if (f === F.SOL) solRows++;
        else if (solRows >= 2 && curbRow < 0) curbRow = y + 1;
        continue;
      }
      if (f === F.IGNORE) break;
      if (y > 0 && isWalkable(famAt(b, y - 1))) continue; // pixel isolé : bruit
      contact = y;
      break;
    }
    const xc = (b + 0.5) * binW;
    if (curbRow >= 0) {
      const cd = groundDistance(cam, curbRow);
      if (isFinite(cd) && cd <= maxDist) curbCols.push({ b, d: cd, lat: lateralAt(cam, xc, cd) });
    }
    if (contact < 0) continue;
    const d = groundDistance(cam, contact + 1);
    if (!isFinite(d) || d > maxDist) continue;
    // Classe majoritaire juste au-dessus du point de contact
    const counts = new Map();
    for (let y = contact; y >= Math.max(0, contact - 6); y--) {
      for (let x = b * binW; x < (b + 1) * binW; x++) {
        const c = labels[y * lw + x];
        const f = CLASS_FAMILY[c];
        if (isWalkable(f) || f === F.IGNORE) continue;
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    let cls = -1;
    let best = 0;
    for (const [c, n] of counts) if (n > best) { best = n; cls = c; }
    if (cls < 0) continue;
    cols.push({ b, d, lat: lateralAt(cam, xc, d), cls, fam: CLASS_FAMILY[cls], visible: contact < lh - 1 });
  }

  // Regroupe les colonnes voisines de même famille et à distance proche.
  const obstacles = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.bins >= 2 || cur.family === F.POTEAU) {
      // Direction : le point de l'obstacle le plus proche de l'axe de marche (0 s'il le traverse)
      const lat = Math.min(Math.max(0, cur.latMin), cur.latMax);
      cur.lateral = cur.latMin <= 0 && cur.latMax >= 0 ? 0 : lat;
      obstacles.push({
        family: cur.family,
        cls: cur.cls,
        label: CLASS_TABLE[cur.cls].fr,
        distance: cur.distance,
        lateral: cur.lateral,
        latMin: cur.latMin,
        latMax: cur.latMax,
        angle: Math.atan2(cur.lateral, cur.distance) / RAD,
        bins: cur.bins,
        contactVisible: cur.visible,
      });
    }
    cur = null;
  };
  for (const c of cols) {
    if (cur && c.b === cur.lastB + 1 && c.fam === cur.family && Math.abs(c.d - cur.lastD) < Math.max(0.5, 0.25 * c.d)) {
      cur.lastB = c.b;
      cur.lastD = c.d;
      cur.bins++;
      cur.latMin = Math.min(cur.latMin, c.lat);
      cur.latMax = Math.max(cur.latMax, c.lat);
      if (c.d < cur.distance) {
        cur.distance = c.d;
        cur.lateral = c.lat;
        cur.cls = c.cls;
        cur.visible = c.visible;
      }
    } else {
      flush();
      cur = { family: c.fam, cls: c.cls, distance: c.d, lateral: c.lat, latMin: c.lat, latMax: c.lat, lastB: c.b, lastD: c.d, bins: 1, visible: c.visible };
    }
  }
  flush();

  // Bordure : limite trottoir → chaussée sur au moins 60 % de la largeur du couloir.
  let curb = null;
  const half = o.corridorHalf ?? 0.75;
  const inCorr = curbCols.filter((c) => Math.abs(c.lat) <= half);
  if (inCorr.length) {
    const ds = inCorr.map((c) => c.d).sort((a, b) => a - b);
    const dMed = ds[ds.length >> 1];
    let corridorBins = 0;
    for (let b = 0; b < nb; b++) if (Math.abs(lateralAt(cam, (b + 0.5) * binW, dMed)) <= half) corridorBins++;
    const coverage = corridorBins ? inCorr.length / corridorBins : 0;
    if (coverage >= 0.6) curb = { distance: dMed, coverage: Math.min(1, coverage) };
  }
  return { obstacles, curb };
}
