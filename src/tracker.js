// Color-blob tracking of physical Beyblades in the live camera feed, plus a
// lightweight rotation-speed (RPM) estimator based on circular
// cross-correlation of a ring of brightness samples around each blob.
//
// This is a heuristic, not a precision instrument: it needs a Beyblade with
// some visible color/pattern asymmetry and reasonable lighting. Treat the
// RPM readout as an estimate, not a certified measurement.

const RING_SAMPLES = 24; // angular samples used for rotation correlation
const SEARCH_MARGIN = 1.8; // how much the ROI grows around the last-known blob radius

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return [h, s, v];
}

export class BlobTracker {
  /**
   * @param {{x:number,y:number}} initialTarget calibration point in
   *   processing-canvas coordinates
   * @param {ImageData} frame the frame the calibration point was sampled from
   */
  constructor(name, colorLabel) {
    this.name = name;
    this.colorLabel = colorLabel;
    this.targetHsv = null;
    this.hueTolerance = 22;
    this.satMin = 0.25;
    this.valMin = 0.2;
    this.centroid = null; // {x,y} in processing-canvas space
    this.radius = 6;
    this.confidence = 0;
    this.velocity = { x: 0, y: 0 };
    this.rpm = 0;
    this._prevSignal = null;
    this._lastAngleOffset = 0;
    this._lastTimestamp = null;
    this._history = []; // recent centroids for smoothing/velocity
  }

  calibrate(frame, x, y) {
    const { data, width, height } = frame;
    const px = Math.round(x), py = Math.round(y);
    let hSum = 0, sSum = 0, vSum = 0, n = 0;
    const R = 6;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const sx = px + dx, sy = py + dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const idx = (sy * width + sx) * 4;
        const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
        hSum += h; sSum += s; vSum += v; n++;
      }
    }
    if (n === 0) return false;
    this.targetHsv = [hSum / n, sSum / n, vSum / n];
    this.satMin = Math.max(0.15, this.targetHsv[1] * 0.4);
    this.valMin = Math.max(0.12, this.targetHsv[2] * 0.35);
    this.centroid = { x: px, y: py };
    this.radius = 10;
    this._prevSignal = null;
    this._history = [];
    return true;
  }

  /** Scans the frame (within a region of interest around the last known
   *  position, once one exists) and updates centroid/radius/confidence. */
  updatePosition(frame, timestampMs) {
    if (!this.targetHsv) return;
    const { data, width, height } = frame;
    const [targetH] = this.targetHsv;

    let minX = 0, minY = 0, maxX = width, maxY = height;
    if (this.centroid) {
      const r = this.radius * SEARCH_MARGIN + 12;
      minX = Math.max(0, Math.floor(this.centroid.x - r));
      minY = Math.max(0, Math.floor(this.centroid.y - r));
      maxX = Math.min(width, Math.ceil(this.centroid.x + r));
      maxY = Math.min(height, Math.ceil(this.centroid.y + r));
    }

    let sumX = 0, sumY = 0, count = 0;
    let sumX2 = 0;
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const idx = (y * width + x) * 4;
        const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
        let dh = Math.abs(h - targetH);
        if (dh > 180) dh = 360 - dh;
        if (dh <= this.hueTolerance && s >= this.satMin && v >= this.valMin) {
          sumX += x; sumY += y; count++;
          sumX2 += x * x;
        }
      }
    }

    const minPixels = 4;
    if (count < minPixels) {
      this.confidence = Math.max(0, this.confidence - 0.15);
      return;
    }

    const cx = sumX / count;
    const cy = sumY / count;
    const variance = Math.max(1, sumX2 / count - cx * cx);
    const newRadius = Math.min(40, Math.max(4, Math.sqrt(variance) * 1.4));

    if (this.centroid && this._lastTimestamp != null) {
      const dt = Math.max(1, timestampMs - this._lastTimestamp) / 1000;
      this.velocity = { x: (cx - this.centroid.x) / dt, y: (cy - this.centroid.y) / dt };
    }

    this.centroid = { x: cx, y: cy };
    this.radius = newRadius;
    this.confidence = Math.min(1, this.confidence + 0.2);
    this._lastTimestamp = timestampMs;

    this._history.push({ x: cx, y: cy, t: timestampMs });
    if (this._history.length > 20) this._history.shift();

    this._updateRotation(frame, timestampMs);
  }

  /** Samples brightness around a ring at ~70% of the blob radius and
   *  cross-correlates against the previous frame's ring signal to find the
   *  angular shift, i.e. how far the pattern rotated this frame. */
  _updateRotation(frame, timestampMs) {
    const { data, width, height } = frame;
    const r = Math.max(3, this.radius * 0.7);
    const signal = new Float32Array(RING_SAMPLES);
    for (let i = 0; i < RING_SAMPLES; i++) {
      const theta = (i / RING_SAMPLES) * Math.PI * 2;
      const sx = Math.round(this.centroid.x + Math.cos(theta) * r);
      const sy = Math.round(this.centroid.y + Math.sin(theta) * r);
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
        signal[i] = 0;
        continue;
      }
      const idx = (sy * width + sx) * 4;
      signal[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }

    // Mean-center to reduce sensitivity to overall lighting changes.
    let mean = 0;
    for (let i = 0; i < RING_SAMPLES; i++) mean += signal[i];
    mean /= RING_SAMPLES;
    for (let i = 0; i < RING_SAMPLES; i++) signal[i] -= mean;

    if (this._prevSignal && this._lastTimestamp != null) {
      let bestShift = 0, bestScore = -Infinity;
      for (let shift = -Math.floor(RING_SAMPLES / 2); shift <= Math.floor(RING_SAMPLES / 2); shift++) {
        let score = 0;
        for (let i = 0; i < RING_SAMPLES; i++) {
          const j = ((i + shift) % RING_SAMPLES + RING_SAMPLES) % RING_SAMPLES;
          score += signal[i] * this._prevSignal[j];
        }
        if (score > bestScore) { bestScore = score; bestShift = shift; }
      }

      const energy = signal.reduce((a, v) => a + v * v, 0);
      if (energy > 40) {
        // Smooth the raw per-frame shift so noise doesn't spike the RPM readout.
        const dt = Math.max(1, timestampMs - this._lastTimestamp) / 1000;
        const angleShiftDeg = (bestShift / RING_SAMPLES) * 360;
        const instantRpm = Math.abs((angleShiftDeg / dt) / 360) * 60;
        // Reject implausible single-frame spikes (> 3000 RPM) as noise.
        if (instantRpm < 3000) {
          this.rpm = this.rpm * 0.7 + instantRpm * 0.3;
        }
      } else {
        this.rpm *= 0.9; // low texture/contrast: decay estimate rather than trust it
      }
    }

    this._prevSignal = signal;
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.y);
  }

  isActive() {
    return this.confidence > 0.3 && this.centroid != null;
  }
}
