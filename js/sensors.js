// ORIANE v2.2 — capteurs du téléphone en modules purs (partagés par le direct et le rejeu).
//
// Lot 2.2-0 : le comportement est celui de la v2.1, à l'identique, sorti de app.js pour que le
// rejeu d'une marche enregistrée passe exactement par le même code. Le lot 2.2-1 remplacera
// TiltFilter par une source d'orientation interchangeable (AttitudeSource) avec un vrai lissage.
// Les temps sont en millisecondes, sur une horloge quelconque mais unique (performance.now en direct).

/** Inclinaison du téléphone d'après `beta` de deviceorientation (v2.1 : moyenne 0,7 / 0,3 à chaque événement). */
export class TiltFilter {
  constructor() {
    this.beta = null;
  }

  onOrientation(beta) {
    if (beta == null || Number.isNaN(beta)) return;
    this.beta = this.beta == null ? beta : this.beta * 0.7 + beta * 0.3;
  }

  /** Inclinaison de la caméra vers le bas, en degrés (téléphone tenu verticalement), ou null. */
  pitch() {
    return this.beta == null ? null : Math.max(-20, Math.min(80, 90 - this.beta));
  }
}

/** Marche ou immobile : secousses de l'accéléromètre (pas) ou vitesse GPS (v2.1). */
export class MotionState {
  constructor() {
    this.supported = false;
    this.lastStep = -Infinity;
    this.gps = null; // { t, speed }
  }

  /** Accélération avec gravité (m/s²). */
  onMotion(t, ax, ay, az) {
    if (ax == null) return;
    this.supported = true;
    if (Math.abs(Math.hypot(ax, ay, az) - 9.81) > 1.2) this.lastStep = t;
  }

  onGps(t, speed) {
    this.gps = { t, speed };
  }

  isMoving(t) {
    const g = this.gps;
    if (g && g.speed != null && g.speed > 0.6 && t - g.t < 3000) return true;
    if (!this.supported) return true;
    return t - this.lastStep < 1500;
  }
}
