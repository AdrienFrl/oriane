// ORIANE — caméra, détection d'objets (COCO-SSD / TensorFlow.js) et distance approximative.
//
// Distance : on connaît la taille réelle moyenne de chaque type d'objet ;
// distance ≈ taille réelle × focale (pixels) / taille dans l'image (pixels).

import { fmtMeters, cap } from './util.js';

export const CLASSES = {
  person: { h: 1.7, w: 0.5, label: 'personne', important: true },
  bicycle: { h: 1.05, w: 0.6, label: 'vélo', important: true, vehicle: true },
  car: { h: 1.5, w: 1.8, label: 'voiture', important: true, vehicle: true },
  motorcycle: { h: 1.2, w: 0.8, label: 'moto', important: true, vehicle: true },
  bus: { h: 3.0, w: 2.5, label: 'bus', important: true, vehicle: true },
  truck: { h: 3.0, w: 2.5, label: 'camion', important: true, vehicle: true },
  'traffic light': { h: 0.9, w: 0.35, label: 'feu', important: true, light: true },
  'stop sign': { h: 0.75, w: 0.75, label: 'panneau stop' },
  'fire hydrant': { h: 0.7, w: 0.35, label: 'borne incendie', important: true },
  'parking meter': { h: 1.4, w: 0.3, label: 'horodateur', important: true },
  bench: { h: 0.85, w: 1.5, label: 'banc', important: true },
  chair: { h: 0.9, w: 0.5, label: 'chaise', important: true },
  'potted plant': { h: 0.8, w: 0.5, label: 'plante en pot', important: true },
  'dining table': { h: 0.75, w: 1.2, label: 'table', important: true },
  suitcase: { h: 0.65, w: 0.45, label: 'valise', important: true },
  dog: { h: 0.6, w: 0.7, label: 'chien' },
  cat: { h: 0.3, w: 0.45, label: 'chat' },
  umbrella: { h: 1.0, w: 1.0, label: 'parapluie' },
};

export function dirPhrase(a) {
  if (a < -20) return 'à gauche';
  if (a < -8) return 'légèrement à gauche';
  if (a <= 8) return 'devant';
  if (a <= 20) return 'légèrement à droite';
  return 'à droite';
}

/** Distance (m) d'une boîte de détection ; utilise la largeur si l'objet sort du cadre en hauteur. */
export function estimateDistance(c, [x, y, w, h], W, H, focal, calib = 1) {
  const m = 3;
  const cutV = y <= m || y + h >= H - m;
  const cutH = x <= m || x + w >= W - m;
  let d;
  if (!cutV) d = (c.h * focal) / h;
  else if (!cutH) d = (c.w * focal) / w;
  else d = Math.min((c.h * focal) / h, (c.w * focal) / w) * 0.7;
  return Math.max(0.3, d * calib);
}

export function focalPx(W, H, fovDeg) {
  return Math.max(W, H) / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - inter;
  return u > 0 ? inter / u : 0;
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('impossible de charger ' + src));
    document.head.appendChild(s);
  });
}

export class Vision {
  constructor({ video, canvas, say, log, settings, onObstacles, onStatus }) {
    Object.assign(this, { video, canvas, say, log, settings, onObstacles, onStatus });
    this.tracks = [];
    this.nextId = 1;
    this.running = false;
    this.lastObjSpeech = 0;
    this.recent = new Map(); // anti-répétition : "classe|direction" → horodatage
    this.tmp = document.createElement('canvas');
    this.fps = 0;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('caméra non disponible dans ce navigateur');
    if (!this.video.srcObject) {
      this.onStatus?.('Ouverture de la caméra…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      this.ownStream = true;
    }
    await this.video.play();
    if (!this.model || this.modelBase !== this.settings.modelBase) {
      this.onStatus?.('Chargement du modèle de détection (une seule fois)…');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
      await window.tf.ready();
      this.model = await window.cocoSsd.load({ base: this.settings.modelBase });
      this.modelBase = this.settings.modelBase;
      this.log?.(`Modèle de détection chargé (${this.modelBase}, ${window.tf.getBackend()}).`);
    }
    this.running = true;
    this.onStatus?.('Détection active');
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.ownStream) {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      this.ownStream = false;
    }
    this.stream = null;
    this.tracks = [];
    this.onObstacles?.([]);
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.onStatus?.('Détection coupée');
  }

  get focal() {
    return focalPx(this.video.videoWidth, this.video.videoHeight, this.settings.fov);
  }

  async _loop() {
    if (!this.running) return;
    const t0 = performance.now();
    try {
      if (this.video.readyState >= 2 && this.video.videoWidth) {
        const preds = await this.model.detect(this.video, 12, 0.5);
        if (this.running) this._process(preds, performance.now());
      }
    } catch (e) {
      this.log?.('Erreur de détection : ' + e.message);
    }
    const dt = performance.now() - t0;
    this.fps = this.fps * 0.8 + (1000 / Math.max(dt, 150)) * 0.2;
    setTimeout(() => this._loop(), Math.max(30, 180 - dt));
  }

  _process(preds, now) {
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    const f = this.focal;
    for (const t of this.tracks) t.matched = false;
    for (const p of preds) {
      const c = CLASSES[p.class];
      if (!c) continue;
      const [x, y, w, h] = p.bbox;
      const dist = estimateDistance(c, p.bbox, W, H, f, this.settings.calib);
      const angle = (Math.atan((x + w / 2 - W / 2) / f) * 180) / Math.PI;
      const elev = (-Math.atan((y + h / 2 - H / 2) / f) * 180) / Math.PI;
      let best = null;
      let bestS = 0;
      for (const t of this.tracks) {
        if (t.matched || t.cls !== p.class) continue;
        const s = iou(t.box, p.bbox);
        if (s > bestS) {
          best = t;
          bestS = s;
        }
      }
      if (best && bestS > 0.15) {
        best.dist = best.dist * 0.55 + dist * 0.45;
        best.angle = best.angle * 0.5 + angle * 0.5;
        best.elev = elev;
        best.box = p.bbox;
        best.hits++;
        best.miss = 0;
        best.matched = true;
        best.hist.push({ t: now, d: best.dist });
        while (best.hist.length && now - best.hist[0].t > 2000) best.hist.shift();
        const h0 = best.hist[0];
        best.speed = now - h0.t > 1000 ? (h0.d - best.dist) / ((now - h0.t) / 1000) : 0;
      } else {
        this.tracks.push({
          id: this.nextId++, cls: p.class, c, box: p.bbox, dist, angle, elev,
          hits: 1, miss: 0, matched: true, speed: 0, hist: [{ t: now, d: dist }],
        });
      }
    }
    this.tracks = this.tracks.filter((t) => t.matched || ++t.miss <= 3);
    this._lights(now);
    this._announce(now);
    this._draw();
    this.onObstacles?.(
      this.tracks
        .filter((t) => t.hits >= 2 && t.miss === 0 && !t.c.light)
        .map((t) => ({ id: 'o' + t.id, angle: t.angle, distance: t.dist, kind: 'object', label: t.c.label, elevation: t.elev > 15 ? 1 : 0 }))
    );
  }

  _recently(key, now, ms) {
    const t = this.recent.get(key);
    if (t && now - t < ms) return true;
    this.recent.set(key, now);
    return false;
  }

  _announce(now) {
    const mode = this.settings.objSpeech;
    if (mode === 'off') return;
    const range = this.settings.announceRange;
    const sorted = this.tracks.filter((t) => t.hits >= 2 && t.miss === 0).sort((a, b) => a.dist - b.dist);
    for (const t of sorted) {
      if (t.c.light) continue;
      if (mode === 'important' && !t.c.important) continue;
      const dir = dirPhrase(t.angle);
      if (t.dist < 2 && !t.warnedClose) {
        t.warnedClose = t.announced = true;
        if (this._recently(`${t.cls}|${dir}|close`, now, 6000)) continue;
        this.say(`Attention, ${t.c.label} très proche ${dir}.`, { priority: 3 });
        this.lastObjSpeech = now;
        return;
      }
      if (t.c.vehicle && t.speed > 1.5 && t.dist < 15 && t.hits >= 5 && !t.warnedApproach) {
        t.warnedApproach = t.announced = true;
        this.say(`Attention, ${t.c.label} qui approche ${dir}.`, { priority: 3 });
        this.lastObjSpeech = now;
        return;
      }
      if (!t.announced && t.dist <= range && now - this.lastObjSpeech > 2500) {
        t.announced = true;
        if (this._recently(`${t.cls}|${dir}`, now, 8000)) continue;
        this.say(`${cap(t.c.label)} ${dir}, ${fmtMeters(t.dist)}.`, { priority: 1, key: 'obj' });
        this.lastObjSpeech = now;
        return;
      }
    }
  }

  /** Couleur d'un feu (expérimental) : compte les pixels rouges et verts lumineux. */
  _lightColor(box) {
    const c = this.tmp;
    c.width = 12;
    c.height = 24;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, box[0], box[1], box[2], box[3], 0, 0, 12, 24);
    const d = ctx.getImageData(0, 0, 12, 24).data;
    let red = 0;
    let green = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 140 || max - min < 60) continue;
      let hue;
      if (max === r) hue = (60 * ((g - b) / (max - min)) + 360) % 360;
      else if (max === g) hue = 60 * ((b - r) / (max - min)) + 120;
      else hue = 60 * ((r - g) / (max - min)) + 240;
      if (hue < 20 || hue > 335) red++;
      else if (hue >= 100 && hue <= 200) green++;
    }
    if (red >= 4 && red > green * 2) return 'rouge';
    if (green >= 4 && green > red * 2) return 'vert';
    return null;
  }

  _lights(now) {
    for (const t of this.tracks) {
      if (!t.c.light || t.miss > 0 || t.dist > 30) continue;
      const col = this._lightColor(t.box);
      if (col && col === t.lastCol && col !== t.saidCol && this.settings.objSpeech !== 'off') {
        t.saidCol = col;
        if (!this._recently(`light|${col}`, now, 5000)) this.say(`Feu ${col} ${dirPhrase(t.angle)}.`, { priority: 2 });
      }
      t.lastCol = col;
      t.color = col;
    }
  }

  describe() {
    if (!this.running) return 'La détection n’est pas active.';
    const vis = this.tracks.filter((t) => t.miss === 0).sort((a, b) => a.dist - b.dist).slice(0, 5);
    if (!vis.length) return 'Je ne détecte rien de particulier devant vous.';
    return (
      'Devant vous : ' +
      vis
        .map((t) => `${t.c.label}${t.color ? ' ' + t.color : ''} ${dirPhrase(t.angle)} à ${fmtMeters(t.dist)}`)
        .join(', ') +
      '.'
    );
  }

  _draw() {
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const fs = Math.max(16, Math.round(W / 28));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.lineWidth = Math.max(3, W / 250);
    for (const t of this.tracks) {
      if (t.miss > 0) continue;
      const [x, y, w, h] = t.box;
      const col = t.dist < 2 ? '#ff5b4a' : t.dist < 5 ? '#f2c14e' : '#5fd38d';
      ctx.strokeStyle = col;
      ctx.strokeRect(x, y, w, h);
      const txt = `${t.c.label}${t.color ? ' ' + t.color : ''} · ${t.dist.toFixed(1)} m`;
      const tw = ctx.measureText(txt).width + 12;
      ctx.fillStyle = col;
      ctx.fillRect(x, Math.max(0, y - fs - 8), tw, fs + 8);
      ctx.fillStyle = '#0b1020';
      ctx.fillText(txt, x + 6, Math.max(fs, y - 6));
    }
  }
}
