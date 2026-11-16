// ORIANE v2 — worker de perception : segmentation SegFormer-B0 (ADE20K) + géométrie au sol.
// Tourne hors du fil principal : l'interface, la voix et les bips ne sont jamais bloqués.

import { analyze } from './geometry.js';

const MODEL = 'Xenova/segformer-b0-finetuned-ade-512-512';
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let T = null;
let model = null;
let device = null;
let canvas = null;
let ctx = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m).catch((err) => self.postMessage({ type: 'error', message: String(err?.message || err) }));
  else if (m.type === 'frame') frame(m).catch((err) => {
    m.bitmap?.close?.();
    self.postMessage({ type: 'frame-error', id: m.id, message: String(err?.message || err) });
  });
};

async function init({ prefer }) {
  const t0 = performance.now();
  T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
  T.env.allowLocalModels = false;
  const Cls = T.AutoModelForSemanticSegmentation || T.SegformerForSemanticSegmentation;
  if (prefer !== 'wasm' && self.navigator?.gpu) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('pas d’adaptateur WebGPU');
      model = await Cls.from_pretrained(MODEL, { device: 'webgpu', dtype: 'fp32' });
      device = 'webgpu';
    } catch (err) {
      self.postMessage({ type: 'log', message: 'WebGPU indisponible (' + (err?.message || err) + '), passage au processeur.' });
      model = null;
    }
  }
  if (!model) {
    model = await Cls.from_pretrained(MODEL, { device: 'wasm', dtype: 'q8' });
    device = 'wasm';
  }
  self.postMessage({ type: 'ready', device, loadMs: Math.round(performance.now() - t0) });
}

async function frame(m) {
  const { bitmap, w, h } = m;
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const px = ctx.getImageData(0, 0, w, h).data;
  const N = w * h;
  const input = new Float32Array(3 * N);
  let lum = 0;
  for (let i = 0; i < N; i++) {
    const r = px[4 * i] / 255;
    const g = px[4 * i + 1] / 255;
    const b = px[4 * i + 2] / 255;
    input[i] = (r - MEAN[0]) / STD[0];
    input[N + i] = (g - MEAN[1]) / STD[1];
    input[2 * N + i] = (b - MEAN[2]) / STD[2];
    lum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const t1 = performance.now();
  const out = await model({ pixel_values: new T.Tensor('float32', input, [1, 3, h, w]) });
  const logits = out.logits;
  const [, C, lh, lw] = logits.dims;
  const L = logits.data;
  const plane = lh * lw;
  const labels = new Uint8Array(plane);
  for (let p = 0; p < plane; p++) {
    let best = -Infinity;
    let bi = 0;
    for (let c = 0; c < C; c++) {
      const v = L[c * plane + p];
      if (v > best) { best = v; bi = c; }
    }
    labels[p] = bi;
  }
  const inferMs = performance.now() - t1;
  const res = analyze(labels, lw, lh, {
    frameW: m.frameW, frameH: m.frameH, cropTop: m.cropTop, fovDeg: m.fov,
    pitchDeg: m.pitch, camHeight: m.camHeight, corridorHalf: m.corridorHalf, maxDist: 12,
  });
  self.postMessage(
    { type: 'result', id: m.id, t: m.t, inferMs, device, lw, lh, labels, cropTop: m.cropTop, lum: lum / N, ...res },
    [labels.buffer]
  );
}
