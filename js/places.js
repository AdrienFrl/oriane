// ORIANE v2 — recherche de lieux en langage naturel : magasins, enseignes, catégories ou adresses.
//   « aller à Inter à Castelsarrasin », « la pharmacie la plus proche », « gare Matabiau », « 18 rue de Metz à Toulouse »
// Sources gratuites : Overpass (lieux autour de soi), Photon puis Nominatim (OpenStreetMap).

import { fetchJSON, photonLabel } from './geo.js';
import { haversine, norm } from './util.js';

// Noms courts ou déformés à l'oral → nom de l'enseigne
const ALIASES = [
  [/\binter\b(?!\s*sport)/, 'Intermarché'],
  [/\bintermarche\b/, 'Intermarché'],
  [/\bcarrouf\b/, 'Carrefour'],
  [/\b(?:mac ?do|mc ?do|mcdonalds?|mac donald'?s?)\b/, "McDonald's"],
  [/\bdecat(?:h|hlon)?\b/, 'Decathlon'],
  [/\bleclerc\b/, 'E.Leclerc'],
  [/\bsuper u\b/, 'Super U'],
  [/\bhyper u\b/, 'Hyper U'],
  [/\bbk\b|\bburger king\b/, 'Burger King'],
  [/\bla poste\b/, 'La Poste'],
];

// Catégories demandées sans nom propre (« la pharmacie la plus proche »)
const CATEGORIES = [
  [/^pharmacies?$/, ['["amenity"="pharmacy"]'], 'pharmacie'],
  [/^boulangeries?$/, ['["shop"="bakery"]'], 'boulangerie'],
  [/^(?:supermarches?|superettes?|epiceries?|magasins? d'alimentation)$/, ['["shop"="supermarket"]', '["shop"="convenience"]'], 'supermarché'],
  [/^gares?(?: sncf)?$/, ['["railway"="station"]'], 'gare'],
  [/^(?:arrets? de bus|arrets? du bus|bus)$/, ['["highway"="bus_stop"]'], 'arrêt de bus'],
  [/^(?:stations? de )?metro$/, ['["station"="subway"]'], 'station de métro'],
  [/^(?:arrets? de )?tram(?:way)?$/, ['["railway"="tram_stop"]'], 'arrêt de tram'],
  [/^banques?$/, ['["amenity"="bank"]'], 'banque'],
  [/^(?:distributeurs?(?: de billets)?|dab|retrait d'argent)$/, ['["amenity"="atm"]'], 'distributeur'],
  [/^(?:hopital|hopitaux|urgences)$/, ['["amenity"="hospital"]'], 'hôpital'],
  [/^(?:medecins?|cabinet medical)$/, ['["amenity"="doctors"]'], 'médecin'],
  [/^(?:poste|bureau de poste)$/, ['["amenity"="post_office"]'], 'bureau de poste'],
  [/^mairies?$/, ['["amenity"="townhall"]'], 'mairie'],
  [/^ecoles?$/, ['["amenity"="school"]'], 'école'],
  [/^restaurants?$/, ['["amenity"="restaurant"]'], 'restaurant'],
  [/^(?:cafes?|bars?)$/, ['["amenity"="cafe"]', '["amenity"="bar"]'], 'café'],
  [/^parkings?$/, ['["amenity"="parking"]'], 'parking'],
  [/^(?:toilettes|wc)$/, ['["amenity"="toilets"]'], 'toilettes'],
  [/^(?:tabac|bureau de tabac)$/, ['["shop"="tobacco"]'], 'tabac'],
  [/^cinemas?$/, ['["amenity"="cinema"]'], 'cinéma'],
  [/^(?:bibliotheques?|mediatheques?)$/, ['["amenity"="library"]'], 'bibliothèque'],
  [/^(?:parcs?|jardins? public)$/, ['["leisure"="park"]'], 'parc'],
  [/^(?:station essence|station-service|station service)$/, ['["amenity"="fuel"]'], 'station-service'],
];

const LEAD = /^\s*(?:(?:je (?:veux|voudrais|souhaite|dois) (?:aller|me rendre)|emm[eè]ne[- ]moi|am[eè]ne[- ]moi|conduis[- ]moi|guide[- ]moi|on va|allons|aller|va|vas|direction|itin[ée]raire(?: pour| vers)?|cherche(?:r)?|trouve(?:r)?|trouve[- ]moi)\s+)+(?:(?:à la|à l'|au|aux|à|a|vers|jusqu'à|jusqu'au|chez|le|la|les|l'|un|une|des|du)\s+)?/i;
const NEAREST = /\s+(?:la|le|les)?\s*plus\s+proches?$|\s+(?:à|a)\s+c[oô]t[eé]$|\s+pr[eè]s\s+d'ici$|\s+autour\s+de\s+moi$/i;

/** Analyse la phrase : { name, city, category, nearest } */
export function parseRequest(text) {
  let q = text.trim().replace(/[.!?]+$/, '');
  q = q.replace(LEAD, '');
  let nearest = false;
  if (NEAREST.test(q)) {
    nearest = true;
    q = q.replace(NEAREST, '');
  }
  q = q.replace(/^(?:la|le|les|l'|un|une|des|du)\s+/i, '').trim();
  let name = q;
  let city = null;
  const m = q.match(/^(.+)\s+(?:à|au|aux|sur|vers|pr[eè]s de)\s+([A-Za-zÀ-ÿ' -]+)$/i);
  if (m && !/\d/.test(m[2])) {
    name = m[1].trim();
    city = m[2].trim();
  }
  let n = norm(name);
  for (const [re, rep] of ALIASES) {
    if (re.test(n)) {
      name = n.replace(re, rep).replace(/\s+/g, ' ').trim();
      n = norm(name);
    }
  }
  const cat = CATEGORIES.find(([re]) => re.test(n));
  return { name, city, nearest, category: cat ? { tags: cat[1], label: cat[2] } : null };
}

function tagLabel(tags = {}) {
  const parts = [];
  if (tags.name) parts.push(tags.name);
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  if (street) parts.push(street);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  return parts.join(', ');
}

async function overpass(body, near) {
  const json = await fetchJSON(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: 'data=' + encodeURIComponent(body), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    20000
  );
  return (json.elements || [])
    .map((e) => {
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      if (lat == null) return null;
      return { lat, lon, label: tagLabel(e.tags), source: 'overpass', dist: near ? haversine(near, { lat, lon }) : null };
    })
    .filter((r) => r && r.label);
}

/** Lieux d'une catégorie autour de soi, du plus proche au plus loin. */
export async function categoryNearby(category, near, radius = 3000) {
  const parts = category.tags.map((t) => `nwr${t}(around:${radius},${near.lat},${near.lon});`).join('');
  const res = await overpass(`[out:json][timeout:15];(${parts});out center tags 40;`, near);
  return res.map((r) => (r.label === '' ? r : r)).sort((a, b) => a.dist - b.dist);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');

/** Enseigne ou nom de lieu autour de soi (« Intermarché »). */
export async function nameNearby(name, near, radius = 15000) {
  const re = escapeRe(name);
  const body =
    `[out:json][timeout:20];(nwr["name"~"${re}",i](around:${radius},${near.lat},${near.lon});` +
    `nwr["brand"~"${re}",i](around:${radius},${near.lat},${near.lon}););out center tags 40;`;
  return (await overpass(body, near)).sort((a, b) => a.dist - b.dist);
}

export async function photonSearch(q, near) {
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', q);
  u.searchParams.set('lang', 'fr');
  u.searchParams.set('limit', '10');
  if (near) {
    u.searchParams.set('lat', near.lat.toFixed(5));
    u.searchParams.set('lon', near.lon.toFixed(5));
    u.searchParams.set('zoom', '12');
  }
  const r = await fetchJSON(u);
  return (r.features || []).map((f) => {
    const lat = f.geometry.coordinates[1];
    const lon = f.geometry.coordinates[0];
    return { lat, lon, label: photonLabel(f.properties || {}), source: 'photon', dist: near ? haversine(near, { lat, lon }) : null };
  });
}

async function nominatimSearch(q, near) {
  const n = new URL('https://nominatim.openstreetmap.org/search');
  n.searchParams.set('format', 'jsonv2');
  n.searchParams.set('q', q);
  n.searchParams.set('limit', '5');
  n.searchParams.set('accept-language', 'fr');
  const r = await fetchJSON(n);
  return r.map((x) => ({
    lat: +x.lat, lon: +x.lon, label: x.display_name.split(',').slice(0, 3).join(','), source: 'nominatim',
    dist: near ? haversine(near, { lat: +x.lat, lon: +x.lon }) : null,
  }));
}

function dedupe(list) {
  const out = [];
  for (const r of list) {
    if (out.some((o) => haversine(o, r) < 40 && norm(o.label).slice(0, 12) === norm(r.label).slice(0, 12))) continue;
    out.push(r);
  }
  return out;
}

/**
 * Trouve les lieux correspondant à une phrase. Renvoie { req, results } (au plus 9 résultats, triés).
 * near : position actuelle (facultative) ; deps : fonctions remplaçables pour les tests.
 */
export async function findPlaces(text, near, deps = {}) {
  const S = { categoryNearby, nameNearby, photonSearch, nominatimSearch, ...deps };
  const req = parseRequest(text);
  const q = [req.name, req.city].filter(Boolean).join(' ');
  let results = [];
  const tryIt = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      console.warn('Recherche de lieu :', e);
      return [];
    }
  };

  if (req.category && near && !req.city) {
    results = await tryIt(() => S.categoryNearby(req.category, near, 3000));
    if (!results.length) results = await tryIt(() => S.categoryNearby(req.category, near, 10000));
  }
  if (!results.length && q) {
    results = await tryIt(() => S.photonSearch(q, near));
    if (near && !req.city) {
      results.sort((a, b) => a.dist - b.dist);
      const nearest = results[0]?.dist ?? Infinity;
      if (nearest > 20000 && !/\d/.test(req.name)) {
        const local = await tryIt(() => S.nameNearby(req.name, near));
        if (local.length) results = local;
      }
    }
  }
  if (!results.length && q) results = await tryIt(() => S.nominatimSearch(q, near));
  return { req, results: dedupe(results).slice(0, 9) };
}
