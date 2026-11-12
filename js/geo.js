// ORIANE — services cartographiques gratuits (OpenStreetMap).
//   Recherche d'adresse : Photon (Komoot), secours Nominatim.
//   Itinéraire piéton  : OpenRouteService (clé gratuite) ou, sans clé, OSRM « foot » de FOSSGIS.
//   Repères            : passages piétons et feux via l'API Overpass.

import { Polyline } from './util.js';

async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) {
      let detail = '';
      try {
        detail = (await r.text()).slice(0, 200);
      } catch {
        /* pas de détail */
      }
      const err = new Error(`HTTP ${r.status} ${detail}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('le service ne répond pas');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------------- Recherche d'adresse ----------------

/** Nettoie une phrase dite à voix haute (« emmène-moi au 18 rue de Metz à Toulouse »). */
export function cleanQuery(q) {
  return q
    .replace(
      /^\s*(?:je (?:veux|voudrais|souhaite) (?:aller|me rendre)|emm[eè]ne[- ]moi|am[eè]ne[- ]moi|conduis[- ]moi|guide[- ]moi|aller|direction|itin[ée]raire(?: pour| vers)?)\s+(?:(?:à la|à l'|au|aux|à|a|vers|jusqu'à|jusqu'au|chez)\s+)?/i,
      ''
    )
    .replace(/\s+à\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
}

function photonLabel(p) {
  const parts = [];
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  if (p.name && p.name !== p.street) parts.push(p.name);
  if (street) parts.push(street);
  const city = p.city || p.town || p.village || p.county;
  if (city && !parts.includes(city)) parts.push(city);
  return parts.join(', ') || p.name || 'Lieu sans nom';
}

export async function geocode(query, near) {
  const q = cleanQuery(query);
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', q);
  u.searchParams.set('lang', 'fr');
  u.searchParams.set('limit', '5');
  if (near) {
    u.searchParams.set('lat', near.lat.toFixed(5));
    u.searchParams.set('lon', near.lon.toFixed(5));
  }
  try {
    const r = await fetchJSON(u);
    const res = (r.features || []).map((f) => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: photonLabel(f.properties || {}),
    }));
    if (res.length) return res;
  } catch (e) {
    console.warn('Photon indisponible', e);
  }
  const n = new URL('https://nominatim.openstreetmap.org/search');
  n.searchParams.set('format', 'jsonv2');
  n.searchParams.set('q', q);
  n.searchParams.set('limit', '5');
  n.searchParams.set('accept-language', 'fr');
  const r = await fetchJSON(n);
  return r.map((x) => ({ lat: +x.lat, lon: +x.lon, label: x.display_name.split(',').slice(0, 3).join(',') }));
}

/** Adresse approximative d'une position (pour « où suis-je ? »). */
export async function reverse(p) {
  const u = new URL('https://photon.komoot.io/reverse');
  u.searchParams.set('lat', p.lat.toFixed(6));
  u.searchParams.set('lon', p.lon.toFixed(6));
  u.searchParams.set('lang', 'fr');
  const r = await fetchJSON(u);
  const f = r.features?.[0];
  return f ? photonLabel(f.properties || {}) : null;
}

// ---------------- Itinéraire piéton ----------------
// Format commun d'une étape : { kind: 'turn'|'roundabout'|'straight'|'depart'|'arrive'|'exit',
//                               mod, name, exit, along (m depuis le départ) }

const ORS_TYPES = {
  0: ['turn', 'left'],
  1: ['turn', 'right'],
  2: ['turn', 'sharp left'],
  3: ['turn', 'sharp right'],
  4: ['turn', 'slight left'],
  5: ['turn', 'slight right'],
  6: ['straight', 'straight'],
  7: ['roundabout', null],
  8: ['exit', null],
  9: ['turn', 'uturn'],
  10: ['arrive', null],
  11: ['depart', null],
  12: ['turn', 'keep left'],
  13: ['turn', 'keep right'],
};

const cleanName = (n) => (n && n !== '-' ? n : '');

export function parseORS(json) {
  const f = json.features?.[0];
  if (!f) throw new Error('aucun itinéraire');
  const pts = f.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const line = new Polyline(pts);
  const steps = [];
  for (const seg of f.properties.segments || []) {
    for (const s of seg.steps || []) {
      const [kind, mod] = ORS_TYPES[s.type] || ['straight', 'straight'];
      const idx = Math.min(s.way_points?.[0] ?? 0, pts.length - 1);
      steps.push({ kind, mod, name: cleanName(s.name), exit: s.exit_number, along: line.cum[idx] });
    }
  }
  return {
    pts,
    steps,
    distance: f.properties.summary?.distance ?? line.length,
    duration: f.properties.summary?.duration ?? line.length / 1.3,
    provider: 'OpenRouteService',
  };
}

export function parseOSRM(json) {
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(json.message || json.code || 'aucun itinéraire');
  const rt = json.routes[0];
  const pts = rt.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const line = new Polyline(pts);
  const steps = [];
  let last = null;
  for (const leg of rt.legs) {
    for (const s of leg.steps) {
      const m = s.maneuver;
      const loc = { lat: m.location[1], lon: m.location[0] };
      const along = line.project(loc, last, 5, 1e9).along;
      last = along;
      let kind;
      let mod = m.modifier || 'straight';
      if (m.type === 'depart' || m.type === 'arrive') kind = m.type;
      else if (m.type === 'roundabout' || m.type === 'rotary' || m.type === 'roundabout turn') kind = 'roundabout';
      else if (m.type === 'exit roundabout' || m.type === 'exit rotary') kind = 'exit';
      else if (m.type === 'fork' && /slight/.test(mod)) {
        kind = 'turn';
        mod = mod.includes('left') ? 'keep left' : 'keep right';
      } else if (mod === 'straight' || ((m.type === 'new name' || m.type === 'continue') && /slight/.test(mod))) {
        kind = 'straight';
      } else kind = 'turn';
      steps.push({ kind, mod, name: cleanName(s.name), exit: m.exit, along });
    }
  }
  return { pts, steps, distance: rt.distance, duration: rt.duration, provider: 'OSRM (FOSSGIS)' };
}

async function routeORS(from, to, key) {
  const json = await fetchJSON('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
    method: 'POST',
    headers: {
      Authorization: key,
      'Content-Type': 'application/json',
      Accept: 'application/json, application/geo+json',
    },
    body: JSON.stringify({
      coordinates: [
        [from.lon, from.lat],
        [to.lon, to.lat],
      ],
      language: 'fr',
      instructions: true,
      units: 'm',
    }),
  });
  return parseORS(json);
}

async function routeOSRM(from, to) {
  const u =
    `https://routing.openstreetmap.de/routed-foot/route/v1/foot/` +
    `${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`;
  return parseOSRM(await fetchJSON(u));
}

/** Calcule un itinéraire à pied ; OpenRouteService si une clé est fournie, sinon OSRM. */
export async function route(from, to, orsKey) {
  if (orsKey) {
    try {
      return await routeORS(from, to, orsKey);
    } catch (e) {
      console.warn('OpenRouteService en échec, bascule sur OSRM', e);
      if (e.status === 401 || e.status === 403) {
        const r = await routeOSRM(from, to);
        r.warning = 'Clé OpenRouteService refusée : itinéraire calculé avec OSRM.';
        return r;
      }
    }
  }
  return routeOSRM(from, to);
}

// ---------------- Repères : passages piétons et feux ----------------

export function classifyLandmark(tags = {}) {
  if (tags.crossing === 'traffic_signals' || (tags.highway === 'crossing' && tags['crossing:signals'] === 'yes'))
    return 'crossing_signals';
  if (tags.highway === 'traffic_signals') return 'signals';
  if (tags.highway === 'crossing') return 'crossing';
  return null;
}

export async function landmarks(pts) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of pts) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
  }
  const pad = 0.0003;
  s -= pad; n += pad; w -= pad; e += pad;
  if ((n - s) * (e - w) > 0.02) return []; // trajet trop long pour une seule requête
  const bb = `${s},${w},${n},${e}`;
  const q =
    `[out:json][timeout:20];(node["highway"="crossing"](${bb});` +
    `node["highway"="traffic_signals"](${bb});node["crossing"="traffic_signals"](${bb}););out body;`;
  const json = await fetchJSON(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    25000
  );
  return (json.elements || [])
    .map((el) => ({ lat: el.lat, lon: el.lon, kind: classifyLandmark(el.tags) }))
    .filter((l) => l.kind);
}
