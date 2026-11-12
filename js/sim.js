// ORIANE — simulation de marche le long de l'itinéraire, pour tester le guidage sans sortir.

import { offset } from './util.js';

export class SimWalker {
  constructor({ onPos, speed = 1.4, mult = 1, noise = 3 } = {}) {
    this.onPos = onPos;
    this.speed = speed; // m/s
    this.mult = mult; // accélération (×1, ×3, ×10)
    this.noise = noise; // bruit GPS simulé (m)
    this.timer = null;
  }

  get running() {
    return !!this.timer;
  }

  run(line, startAlong = 0) {
    this.stop();
    this.line = line;
    this.along = startAlong;
    this.nx = 0;
    this.ny = 0;
    this.timer = setInterval(() => this._step(), 1000);
    this._emit();
  }

  _step() {
    this.along = Math.min(this.line.length, this.along + this.speed * this.mult);
    // Bruit GPS « doux » : marche aléatoire amortie
    this.nx = this.nx * 0.7 + (Math.random() - 0.5) * this.noise;
    this.ny = this.ny * 0.7 + (Math.random() - 0.5) * this.noise;
    this._emit();
    if (this.along >= this.line.length) this.stop();
  }

  _emit() {
    const p = offset(this.line.pointAt(this.along), this.ny || 0, this.nx || 0);
    this.onPos?.({
      lat: p.lat,
      lon: p.lon,
      accuracy: 4 + this.noise,
      heading: this.line.bearingAt(this.along),
      speed: this.speed,
      simulated: true,
    });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
