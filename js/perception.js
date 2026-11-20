// ORIANE v2 — pilote de la perception : capture des images, envoi au worker, affichage du masque.

import { FAMILY_COLORS, CLASS_FAMILY } from './classes.js';
import { projectGround } from './geometry.js';

const round32 = (v) => Math.max(64, Math.min(320, Math.round(v / 32) * 32));

export class Perception {
  constructor({ video, maskCanvas, overlay, settings, getPitch, log, onResult, onStatus }) {
    Object.assign(this, { video, maskCanvas, overlay, settings, getPitch, log, onResult, onStatus });
    this.running = false;
    this.busy = false;
    this.lastSent = 0;
    this.frameId = 0;
    this.device = null;
    this.stats = { inferMs: 0, latencyMs: 0, fps: 0 };
    this._lastResultAt = 0;
    this.record = false; // enregistrement d'une marche : le worker renvoie aussi l'image JPEG
  }

  /** Charge le modèle dans le worker. Rejette si le chargement échoue (le secours COCO-SSD prend alors le relais). */
  async start() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./perception-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (e) => this.log?.('Worker : ' + (e.message || 'erreur'));
      this.onStatus?.('Chargement du modèle de scène (≈ 15 Mo la première fois)…');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('chargement du modèle trop long')), 180000);
        this._ready = (msg) => { clearTimeout(timer); resolve(msg); };
        this._fail = (msg) => { clearTimeout(timer); reject(new Error(msg)); };
        this.worker.postMessage({ type: 'init', prefer: this.settings.engine === 'wasm' ? 'wasm' : 'webgpu' });
      });
    }
    this.running = true;
    this.busy = false;
    this._schedule();
  }

  stop() {
    this.running = false;
    this._clearOverlay();
  }

  dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this.device = msg.device;
      this.log?.(`Modèle de scène chargé en ${(msg.loadMs / 1000).toFixed(1)} s (${msg.device === 'webgpu' ? 'processeur graphique, WebGPU' : 'processeur, WASM'}).`);
      this._ready?.(msg);
    } else if (msg.type === 'error') {
      this._fail?.(msg.message);
      this.log?.('Modèle de scène : ' + msg.message);
    } else if (msg.type === 'log') {
      this.log?.(msg.message);
    } else if (msg.type === 'frame-error') {
      this.busy = false;
      this.log?.('Analyse : ' + msg.message);
    } else if (msg.type === 'result') {
      this.busy = false;
      if (!this.running) return;
      const now = performance.now();
      this.stats.inferMs = this.stats.inferMs * 0.8 + msg.inferMs * 0.2;
      this.stats.latencyMs = this.stats.latencyMs * 0.8 + (now - msg.t) * 0.2;
      if (this._lastResultAt) this.stats.fps = this.stats.fps * 0.8 + (1000 / (now - this._lastResultAt)) * 0.2;
      this._lastResultAt = now;
      if (this.settings.showMask) this._drawMask(msg);
      this.onResult?.(msg);
    }
  }

  _schedule() {
    if (!this.running) return;
    const v = this.video;
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this._tick());
    else setTimeout(() => this._tick(), 33);
  }

  async _tick() {
    if (!this.running) return;
    const v = this.video;
    const now = performance.now();
    const gap = 1000 / (this.settings.maxFps || 6);
    if (this.busy || now - this.lastSent < gap || !v.videoWidth) return this._schedule();
    const W = v.videoWidth;
    const H = v.videoHeight;
    const w = 224;
    const h = round32((224 * 0.75 * H) / W);
    const cropH = Math.min(H, (h * W) / w);
    const sy = H - cropH;
    this.busy = true;
    this.lastSent = now;
    try {
      const bitmap = await createImageBitmap(v, 0, sy, W, cropH, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
      this.lastFrame = { frameW: W, frameH: H };
      this.worker.postMessage({
        type: 'frame', id: ++this.frameId, bitmap, w, h, frameW: W, frameH: H, cropTop: sy / H,
        pitch: this.getPitch() ?? 12, camHeight: this.settings.camHeight, fov: this.settings.fov,
        corridorHalf: this.settings.corridorWidth / 2, t: now, record: !!this.record,
      }, [bitmap]);
    } catch (e) {
      this.busy = false;
      this.log?.('Capture : ' + e.message);
    }
    this._schedule();
  }

  _drawMask(msg) {
    const c = this.maskCanvas;
    if (c.width !== msg.lw || c.height !== msg.lh) {
      c.width = msg.lw;
      c.height = msg.lh;
    }
    c.style.top = msg.cropTop * 100 + '%';
    c.style.height = (1 - msg.cropTop) * 100 + '%';
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(msg.lw, msg.lh);
    const d = img.data;
    for (let i = 0; i < msg.labels.length; i++) {
      const col = FAMILY_COLORS[CLASS_FAMILY[msg.labels[i]]];
      d[4 * i] = col[0];
      d[4 * i + 1] = col[1];
      d[4 * i + 2] = col[2];
      d[4 * i + 3] = col[3];
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Dessine le couloir, la limite d'alerte, les obstacles suivis et la bordure (mode testeur). */
  drawOverlay(tracks, curb) {
    const o = this.overlay;
    const v = this.video;
    if (!v.videoWidth) return;
    const scale = 480 / v.videoWidth;
    const W = Math.round(v.videoWidth * scale);
    const H = Math.round(v.videoHeight * scale);
    if (o.width !== W) o.width = W;
    if (o.height !== H) o.height = H;
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const cam = {
      frameW: v.videoWidth, frameH: v.videoHeight, fovDeg: this.settings.fov,
      pitchDeg: this.getPitch() ?? 12, camHeight: this.settings.camHeight,
    };
    const P = (d, l) => {
      const p = projectGround(cam, d, l);
      return p ? { x: p.u * scale, y: p.v * scale } : null;
    };
    const half = this.settings.corridorWidth / 2;
    const range = this.settings.alertRange;
    // Couloir
    const pts = [P(0.6, -half), P(range, -half), P(range, half), P(0.6, half)];
    if (pts.every(Boolean)) {
      ctx.fillStyle = 'rgba(242,193,78,0.10)';
      ctx.strokeStyle = 'rgba(242,193,78,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(242,193,78,1)';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(`${range} m`, pts[2].x + 4, pts[2].y);
    }
    // Bordure de trottoir
    if (curb) {
      const a = P(curb.distance, -half - 0.5);
      const b = P(curb.distance, half + 0.5);
      if (a && b) {
        ctx.strokeStyle = 'rgba(170,90,250,1)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Obstacles suivis
    ctx.font = '700 14px system-ui, sans-serif';
    for (const tr of tracks) {
      if (tr.misses > 0) continue;
      const p = P(tr.distance, tr.lateral);
      if (!p) continue;
      const col = tr.distance < 1.5 ? '#ff5b4a' : tr.inZone ? '#f2c14e' : '#5fd38d';
      const txt = `${tr.label} · ${tr.distance.toFixed(1).replace('.', ',')} m`;
      const tw = ctx.measureText(txt).width + 10;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(p.x - tw / 2, p.y - 26, tw, 19);
      ctx.fillStyle = '#0b1020';
      ctx.fillText(txt, p.x - tw / 2 + 5, p.y - 12);
    }
  }

  _clearOverlay() {
    for (const c of [this.maskCanvas, this.overlay]) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
}
