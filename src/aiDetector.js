// Optional AI-based detector: an alternative to tracker.js's color matching,
// using a small CNN (trained on real footage of these tops, see
// /model/README.md for how) that outputs a coarse "is a top here" heatmap
// instead of relying on a calibrated color. This is a SEPARATE detection
// source — the color tracker in tracker.js is untouched and stays the
// default; this only supplies candidate points to the same
// updatePositionFromPoints() entry point color detection also feeds into,
// so all the downstream battle logic (ring-out, collisions, RPM, HUD) is
// shared either way.
//
// Model expectations (see ai-dataset/train.py for how it was produced):
//  - Input: 128x128 RGB, values in [0,1], full-frame squashed (not
//    aspect-preserving) to that size.
//  - Output: 16x16x1 heatmap, sigmoid activation, single class ("a top").

const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js";
const MODEL_URL = "model/model.json";
const INPUT_SIZE = 128;
const HEATMAP_SIZE = 16;
const PEAK_THRESHOLD = 0.4;
const SUPPRESS_RADIUS = 1.6; // heatmap-grid units; greedy non-max suppression
const MAX_PEAKS = 4;

function loadScriptOnce(src) {
  if (document.querySelector(`script[src="${src}"]`)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Greedy peak-picking over the heatmap grid: strongest cell first, then
 *  skip anything too close to an already-picked peak, so one blob doesn't
 *  get reported as several duplicate points. */
function extractPeaks(values, size, threshold) {
  const candidates = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = values[y * size + x];
      if (v >= threshold) candidates.push({ x, y, v });
    }
  }
  candidates.sort((a, b) => b.v - a.v);

  const peaks = [];
  for (const c of candidates) {
    const tooClose = peaks.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < SUPPRESS_RADIUS);
    if (tooClose) continue;
    peaks.push(c);
    if (peaks.length >= MAX_PEAKS) break;
  }
  return peaks;
}

export class AiDetector {
  constructor() {
    this.tf = null;
    this.model = null;
    this.ready = false;
  }

  async load() {
    await loadScriptOnce(TFJS_URL);
    this.tf = window.tf;
    this.model = await this.tf.loadGraphModel(MODEL_URL);
    // Warm up: first inference is slower (shader compilation etc.) — do it
    // once up front so it doesn't stall the first real frame.
    const warm = this.tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 3]);
    const out = await this.model.executeAsync(warm);
    this.tf.dispose([warm, out]);
    this.ready = true;
  }

  /** Runs detection on the current video frame and returns candidate points
   *  in PROCESS-canvas coordinate space (i.e. camera.processWidth /
   *  processHeight), matching what tracker.updatePositionFromPoints expects
   *  — so callers can feed the result straight in alongside the raw frame. */
  detect(videoEl, processWidth, processHeight) {
    if (!this.ready) return [];
    const tf = this.tf;
    return tf.tidy(() => {
      const input = tf.browser.fromPixels(videoEl)
        .resizeBilinear([INPUT_SIZE, INPUT_SIZE]) // full-frame squash, matches training
        .toFloat()
        .div(255.0)
        .expandDims(0);
      const output = this.model.execute(input); // [1, 16, 16, 1]
      const values = output.dataSync();
      const peaks = extractPeaks(values, HEATMAP_SIZE, PEAK_THRESHOLD);
      return peaks.map((p) => ({
        x: ((p.x + 0.5) / HEATMAP_SIZE) * processWidth,
        y: ((p.y + 0.5) / HEATMAP_SIZE) * processHeight,
        weight: p.v,
      }));
    });
  }
}
