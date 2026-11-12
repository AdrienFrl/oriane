// ORIANE — sons spatialisés des obstacles (Web Audio, HRTF) et signaux sonores.
//
// Chaque obstacle { id, angle (degrés, + = droite), distance (m), kind } devient une source
// placée autour de l'auditeur. Plus il est proche, plus les bips sont rapides, forts et aigus.

export class SpatialAudio {
  constructor() {
    this.ctx = null;
    this.sources = new Map();
    this.range = 6; // portée des bips (m)
    this.hrtf = true;
    this.enabled = true;
    this.maxSources = 3;
  }

  async init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      const l = this.ctx.listener;
      if (l.forwardX) {
        l.forwardX.value = 0;
        l.forwardY.value = 0;
        l.forwardZ.value = -1;
        l.upX.value = 0;
        l.upY.value = 1;
        l.upZ.value = 0;
      } else {
        l.setOrientation(0, 0, -1, 0, 1, 0);
      }
      this.timer = setInterval(() => this._tick(), 25);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Baisse les bips pendant que la voix parle. */
  setDuck(on) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(on ? 0.3 : 0.9, this.ctx.currentTime, 0.05);
  }

  setHrtf(on) {
    this.hrtf = on;
    this.clear();
  }

  clear() {
    for (const s of this.sources.values()) s.panner.disconnect();
    this.sources.clear();
  }

  /** Remplace la liste des obstacles audibles (les plus proches d'abord). */
  update(obstacles) {
    if (!this.ctx) return;
    const now = performance.now();
    const keep = obstacles
      .filter((o) => o.distance <= this.range)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.maxSources);
    const ids = new Set(keep.map((o) => o.id));
    for (const [id, s] of this.sources) {
      if (!ids.has(id)) {
        s.panner.disconnect();
        this.sources.delete(id);
      }
    }
    for (const o of keep) {
      let s = this.sources.get(o.id);
      if (!s) {
        s = { panner: this._makePanner(), next: 0 };
        this.sources.set(o.id, s);
      }
      s.o = o;
      s.seen = now;
      this._place(s);
    }
  }

  _makePanner() {
    const p = this.ctx.createPanner();
    p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 0; // le volume est géré par nous selon la distance réelle
    p.connect(this.master);
    return p;
  }

  _place(s) {
    const a = (s.o.angle * Math.PI) / 180;
    const x = Math.sin(a) * 2;
    const z = -Math.cos(a) * 2;
    const y = (s.o.elevation || 0) * 0.6;
    const p = s.panner;
    if (p.positionX) {
      const t = this.ctx.currentTime;
      p.positionX.setTargetAtTime(x, t, 0.05);
      p.positionY.setTargetAtTime(y, t, 0.05);
      p.positionZ.setTargetAtTime(z, t, 0.05);
    } else {
      p.setPosition(x, y, z);
    }
  }

  /** Intervalle entre deux bips : ~1 s à la portée maximale, quasi continu sous 80 cm. */
  interval(d) {
    const near = 0.8;
    const t = Math.min(1, Math.max(0, (d - near) / Math.max(0.5, this.range - near)));
    return 0.07 + 0.93 * Math.pow(t, 1.3);
  }

  _tick() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const now = performance.now();
    for (const [id, s] of this.sources) {
      if (now - s.seen > 1200) {
        s.panner.disconnect();
        this.sources.delete(id);
        continue;
      }
      if (!this.enabled) continue;
      if (s.next < t) s.next = t + 0.02;
      while (s.next < t + 0.1) {
        this._beep(s, s.next);
        s.next += this.interval(s.o.distance);
      }
    }
  }

  _beep(s, when) {
    const d = s.o.distance;
    const closeness = 1 - Math.min(1, d / this.range);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const depth = s.o.kind === 'depth';
    osc.type = depth ? 'triangle' : 'sine';
    osc.frequency.value = (depth ? 520 : 760) * (1 + 0.6 * closeness);
    const vol = 0.25 + 0.75 * closeness;
    const dur = d < 1.2 ? 0.05 : 0.07;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    osc.connect(g).connect(s.panner);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  /** Signaux non spatialisés : écoute, virage, arrivée, recalcul, alerte. */
  chime(kind) {
    if (!this.ctx) return;
    const seq = {
      listen: [[880, 0.08], [1320, 0.1]],
      turn: [[660, 0.09], [0, 0.06], [660, 0.09]],
      arrive: [[523, 0.12], [659, 0.12], [784, 0.2]],
      reroute: [[784, 0.1], [523, 0.16]],
      warn: [[440, 0.1], [0, 0.05], [440, 0.1], [0, 0.05], [440, 0.1]],
      ok: [[988, 0.1]],
    }[kind];
    if (!seq) return;
    let t = this.ctx.currentTime + 0.02;
    for (const [f, d] of seq) {
      if (f) {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.35, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + d);
        o.connect(g).connect(this.ctx.destination);
        o.start(t);
        o.stop(t + d + 0.02);
      }
      t += d;
    }
  }

  /** Test : un obstacle virtuel approche par la droite, puis par la gauche. */
  testSweep(onDone) {
    const start = performance.now();
    const total = 9000;
    const iv = setInterval(() => {
      const e = performance.now() - start;
      if (e > total) {
        clearInterval(iv);
        this.update([]);
        onDone?.();
        return;
      }
      const half = e < total / 2;
      const k = (e % (total / 2)) / (total / 2);
      this.update([{ id: 'test', angle: half ? 45 : -45, distance: this.range - k * (this.range - 0.6), kind: 'object' }]);
    }, 100);
  }
}
