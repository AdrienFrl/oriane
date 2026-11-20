// ORIANE v2.2 — traitement d'une analyse de scène, commun au direct et au rejeu.
// Résultat du modèle (obstacles, bordure, carte de classes) → correction des distances,
// intérieur / extérieur, gestionnaire d'alertes, compteur. Module pur : testé sous Node.

// Intérieur / extérieur, d'après la scène (plafond et sol intérieur contre ciel, route, trottoir)
const INDOOR = new Set([3, 5, 28]); // floor, ceiling, rug
const OUTDOOR = new Set([2, 4, 6, 9, 11, 13]); // sky, tree, road, grass, sidewalk, earth

export class IndoorDetector {
  constructor() {
    this.indoor = false;
    this.score = 0;
  }

  /** Met à jour l'état d'après une carte de classes. Renvoie true si l'état a changé. */
  update(labels) {
    let inn = 0;
    let out = 0;
    for (let i = 0; i < labels.length; i += 3) {
      if (INDOOR.has(labels[i])) inn++;
      else if (OUTDOOR.has(labels[i])) out++;
    }
    if (inn + out < 20) return false;
    this.score = this.score * 0.9 + (inn > out ? 0.1 : 0);
    const was = this.indoor;
    this.indoor = this.indoor ? this.score > 0.35 : this.score > 0.65;
    return was !== this.indoor;
  }
}

/** Applique la correction des distances (réglage « calib ») aux obstacles et à la bordure. */
export function scaleScene(obstacles, curb, k = 1) {
  return {
    obstacles: obstacles.map((o) => ({ ...o, distance: o.distance * k, lateral: o.lateral * k, latMin: o.latMin * k, latMax: o.latMax * k })),
    curb: curb ? { distance: curb.distance * k } : null,
  };
}

/**
 * env : { settings, alerts (AlertManager), indoor (IndoorDetector), counter? (AlertCounter) }
 * msg : { obstacles, curb, labels, lum }
 * ctx : { t, moving, navActive, muted }
 * Renvoie { r (sortie du gestionnaire d'alertes), obstacles, curb, indoorChanged }.
 */
export function processFrame(env, msg, ctx) {
  const { obstacles, curb } = scaleScene(msg.obstacles, msg.curb, env.settings.calib ?? 1);
  const indoorChanged = msg.labels ? env.indoor.update(msg.labels) : false;
  const r = env.alerts.update(obstacles, { ...ctx, curb, lum: msg.lum, indoor: env.indoor.indoor });
  env.counter?.add(ctx.t, ctx.moving !== false, r.events);
  return { r, obstacles, curb, indoorChanged };
}
