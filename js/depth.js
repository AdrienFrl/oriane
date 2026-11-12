// ORIANE — profondeur par IA (expérimental) : Depth Anything V2 Small via Transformers.js.
//
// Le modèle donne une profondeur RELATIVE. On la met à l'échelle en supposant que le bas
// de l'image est le sol : connaissant la hauteur du téléphone et son inclinaison, on sait à
// quelle distance se trouve le sol pour chaque ligne de l'image. Tout ce qui est nettement
// plus proche que le sol attendu est un obstacle (poteau, mur, poubelle, marche…).

export class DepthSensor {
  constructor({ video, log, settings, getPitch, onObstacles, onStatus }) {
    Object.assign(this, { video, log, settings, getPitch, onObstacles, onStatus });
    this.running = false;
    this.scale = null;
    this.ms = 0;
    this.canvas = null;
  }

  async start() {
    this.running = true;
    if (!this.pipe) {
      this.onStatus?.('Chargement du modèle de profondeur (≈ 30 Mo, une seule fois)…');
      const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
      this.RawImage = T.RawImage;
      const id = 'onnx-community/depth-anything-v2-small';
      try {
        if (!('gpu' in navigator)) throw new Error('WebGPU absent');
        this.pipe = await T.pipeline('depth-estimation', id, { device: 'webgpu', dtype: 'fp16' });
        this.device = 'WebGPU';
      } catch (e) {
        this.log?.('Profondeur : WebGPU indisponible, passage en mode processeur (plus lent).');
        this.pipe = await T.pipeline('depth-estimation', id, { device: 'wasm', dtype: 'q8' });
        this.device = 'WASM';
      }
      this.log?.(`Modèle de profondeur chargé (${this.device}).`);
    }
    if (!this.running) return;
    this.onStatus?.('Profondeur active (expérimental)');
    this._loop();
  }

  stop() {
    this.running = false;
    this.onObstacles?.([]);
  }

  async _loop() {
    if (!this.running) return;
    const t0 = performance.now();
    try {
      const v = this.video;
      if (v.videoWidth) {
        this.canvas ??= document.createElement('canvas');
        const sw = 256;
        const sh = Math.round((sw * v.videoHeight) / v.videoWidth);
        this.canvas.width = sw;
        this.canvas.height = sh;
        this.canvas.getContext('2d').drawImage(v, 0, 0, sw, sh);
        const out = await this.pipe(this.RawImage.fromCanvas(this.canvas));
        let t = out.predicted_depth;
        if (t.type && t.type !== 'float32' && t.to) t = t.to('float32');
        if (this.running) this.onObstacles?.(this.analyze(t.data, t.dims[t.dims.length - 2], t.dims[t.dims.length - 1]));
      }
    } catch (e) {
      this.log?.('Profondeur : ' + e.message);
    }
    this.ms = performance.now() - t0;
    setTimeout(() => this._loop(), Math.max(50, 450 - this.ms));
  }

  /**
   * D : profondeur relative (plus grand = plus proche), H×W.
   * Renvoie des obstacles { id, angle, distance, kind: 'depth', label }.
   */
  analyze(D, H, W) {
    const s = this.settings;
    const f = Math.max(W, H) / 2 / Math.tan((s.fov * Math.PI) / 360);
    const pitch = this.getPitch?.() ?? 10; // degrés vers le bas
    const camH = s.camHeight;
    const groundDist = (y) => {
      const a = pitch + (Math.atan((y - H / 2) / f) * 180) / Math.PI;
      return a > 2 ? camH / Math.tan((a * Math.PI) / 180) : Infinity;
    };

    // 1. Échelle : bas-centre de l'image supposé être le sol.
    const scales = [];
    for (let y = Math.floor(H * 0.86); y < Math.floor(H * 0.98); y += 2) {
      const g = groundDist(y);
      if (!isFinite(g)) continue;
      for (let x = Math.floor(W * 0.35); x < W * 0.65; x += 3) {
        const v = D[y * W + x];
        if (v > 0) scales.push(g * v);
      }
    }
    if (scales.length > 10) {
      scales.sort((a, b) => a - b);
      const med = scales[scales.length >> 1];
      this.scale = this.scale ? this.scale * 0.8 + med * 0.2 : med;
    }
    if (!this.scale) return [];

    // 2. Obstacles par colonne : pixels nettement plus proches que le sol attendu.
    const bins = 7;
    const vals = Array.from({ length: bins }, () => []);
    const samples = new Array(bins).fill(0);
    for (let y = Math.floor(H * 0.1); y < Math.floor(H * 0.95); y += 2) {
      const g = groundDist(y);
      for (let x = 0; x < W; x += 2) {
        const v = D[y * W + x];
        if (!(v > 0)) continue;
        const d = this.scale / v;
        const b = Math.min(bins - 1, Math.floor((x / W) * bins));
        samples[b]++;
        if (d < s.beepRange && d < g * 0.7) vals[b].push(d);
      }
    }
    const res = [];
    for (let b = 0; b < bins; b++) {
      if (vals[b].length < 4 || vals[b].length < samples[b] * 0.03) continue;
      vals[b].sort((a, c) => a - c);
      const xc = ((b + 0.5) / bins) * W;
      res.push({ bin: b, distance: vals[b][Math.floor(vals[b].length * 0.1)], angle: (Math.atan((xc - W / 2) / f) * 180) / Math.PI });
    }

    // 3. Regroupe les colonnes voisines à distance proche (un mur = un seul obstacle).
    const clusters = [];
    for (const r of res) {
      const last = clusters[clusters.length - 1];
      if (last && r.bin === last.lastBin + 1 && Math.abs(r.distance - last.distance) < Math.max(0.6, last.distance * 0.25)) {
        last.lastBin = r.bin;
        if (r.distance < last.distance) {
          last.distance = r.distance;
          last.angle = r.angle;
        }
      } else clusters.push({ ...r, lastBin: r.bin });
    }
    return clusters.map((c) => ({ id: 'd' + c.bin, angle: c.angle, distance: c.distance * s.calib, kind: 'depth', label: 'obstacle' }));
  }
}
