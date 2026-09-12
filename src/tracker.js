// Color-blob tracking of physical Beyblades in the live camera feed, plus a
// lightweight rotation-speed (RPM) estimator based on circular
// cross-correlation of a ring of brightness samples around each blob.
//
// This is a heuristic, not a precision instrument: it needs a Beyblade with
// some visible color/pattern asymmetry and reasonable lighting. Treat the
// RPM readout as an estimate, not a certified measurement.

const RING_SAMPLES = 24; // angular samples used for rotation correlation
const SEARCH_MARGIN = 2.5; // how much the ROI grows around the last-known blob radius
const LOCK_CONFIDENCE_THRESHOLD = 0.15; // below this, search the whole frame to reacquire
const CLUSTER_MERGE_RADIUS = 18; // points within this distance are treated as one blob

/** Greedily groups matched pixels into separate blobs by proximity. Needed
 *  when two Beyblades are calibrated to the *same* color (e.g. both wearing
 *  identical stickers): a naive single average over every matching pixel in
 *  the frame would blend two separate Beyblades into one bogus midpoint
 *  position instead of recognizing them as two distinct objects. */
function clusterPoints(points, mergeRadius) {
  const clusters = [];
  for (const p of points) {
    let target = null;
    for (const c of clusters) {
      const cx = c.sumX / c.count, cy = c.sumY / c.count;
      if (Math.hypot(p.x - cx, p.y - cy) <= mergeRadius) { target = c; break; }
    }
    if (!target) {
      target = { sumX: 0, sumY: 0, sumX2: 0, count: 0 };
      clusters.push(target);
    }
    target.sumX += p.x;
    target.sumY += p.y;
    target.sumX2 += p.x * p.x;
    target.count++;
  }
  return clusters.map((c) => ({
    x: c.sumX / c.count,
    y: c.sumY / c.count,
    count: c.count,
    variance: Math.max(1, c.sumX2 / c.count - (c.sumX / c.count) ** 2),
  }));
}

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

  _isMatch(h, s, v) {
    if (!this.targetHsv) return false;
    const [targetH] = this.targetHsv;
    let dh = Math.abs(h - targetH);
    if (dh > 180) dh = 360 - dh;
    return dh <= this.hueTolerance && s >= this.satMin && v >= this.valMin;
  }

  /** For the debug overlay: samples every `stride`th pixel across the whole
   *  frame and returns the ones matching this tracker's calibrated color, so
   *  the UI can show exactly what the tracker considers "this Beyblade" —
   *  useful for seeing whether it's picking up background clutter or barely
   *  matching the Beyblade at all. Not used by the tracking logic itself. */
  computeDebugMatches(frame, stride = 2) {
    if (!this.targetHsv) return [];
    const { data, width, height } = frame;
    const points = [];
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const idx = (y * width + x) * 4;
        const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
        if (this._isMatch(h, s, v)) points.push({ x, y });
      }
    }
    return points;
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
    if (n === 0) return { ok: false };
    this.targetHsv = [hSum / n, sSum / n, vSum / n];
    this.satMin = Math.max(0.15, this.targetHsv[1] * 0.4);
    this.valMin = Math.max(0.12, this.targetHsv[2] * 0.35);
    this.centroid = { x: px, y: py };
    this.radius = 10;
    this._prevSignal = null;
    this._history = [];
    // Shiny metal/gray/white/near-black spots have low saturation, so hue
    // barely means anything there — color tracking will struggle to tell
    // that apart from similarly dull background/lighting. Flag it so the UI
    // can suggest tapping a more colorful spot on the Beyblade instead.
    const lowSaturation = this.targetHsv[1] < 0.25;
    return { ok: true, lowSaturation };
  }

  /** Scans the frame (within a region of interest around the last known
   *  position, once one exists) and updates centroid/radius/confidence. */
  updatePosition(frame, timestampMs) {
    if (!this.targetHsv) return;
    const { data, width, height } = frame;

    // Only trust the small region-of-interest search while we still have a
    // confident lock. Once confidence has decayed (the Beyblade moved out of
    // the ROI, motion blur, etc.) fall back to scanning the whole frame so a
    // lost target can be reacquired instead of the tracker staying stuck
    // forever re-checking the same empty patch of the frame.
    const locked = this.centroid && this.confidence > LOCK_CONFIDENCE_THRESHOLD;
    let minX = 0, minY = 0, maxX = width, maxY = height;
    if (locked) {
      const r = this.radius * SEARCH_MARGIN + 12;
      minX = Math.max(0, Math.floor(this.centroid.x - r));
      minY = Math.max(0, Math.floor(this.centroid.y - r));
      maxX = Math.min(width, Math.ceil(this.centroid.x + r));
      maxY = Math.min(height, Math.ceil(this.centroid.y + r));
    }

    const minPixels = 4;
    let cx, cy, count, variance;

    if (locked) {
      // Small region, effectively one object expected in it: a running sum
      // is enough and keeps this per-frame hot path cheap.
      let sumX = 0, sumY = 0, sumX2 = 0;
      count = 0;
      for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
          const idx = (y * width + x) * 4;
          const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
          if (this._isMatch(h, s, v)) {
            sumX += x; sumY += y; count++;
            sumX2 += x * x;
          }
        }
      }
      if (count >= minPixels) {
        cx = sumX / count;
        cy = sumY / count;
        variance = Math.max(1, sumX2 / count - cx * cx);
      }
    } else {
      // Full-frame reacquire: collect every matching point and cluster them,
      // since another Beyblade sharing this same color could be visible
      // anywhere in the frame too. Pick whichever cluster is closest to
      // where this Beyblade was last seen, rather than averaging everything
      // into one meaningless midpoint between two separate objects.
      const points = [];
      for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
          const idx = (y * width + x) * 4;
          const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
          if (this._isMatch(h, s, v)) points.push({ x, y });
        }
      }
      const clusters = clusterPoints(points, CLUSTER_MERGE_RADIUS).filter((c) => c.count >= minPixels);
      if (clusters.length > 0) {
        const best = this.centroid
          ? clusters.reduce((a, b) =>
              Math.hypot(a.x - this.centroid.x, a.y - this.centroid.y) <=
              Math.hypot(b.x - this.centroid.x, b.y - this.centroid.y) ? a : b)
          : clusters.reduce((a, b) => (a.count >= b.count ? a : b));
        cx = best.x; cy = best.y; count = best.count; variance = best.variance;
      }
    }

    if (count === undefined || count < minPixels) {
      this.confidence = Math.max(0, this.confidence - 0.15);
      if (this.confidence === 0) {
        // Fully lost: isActive() already goes false from confidence alone,
        // so the HUD stops drawing a crosshair. Deliberately keep the stale
        // centroid (rather than clearing it) — it's the only way to tell
        // "my Beyblade" apart from another one sharing the same calibrated
        // color when re-scanning the whole frame below finds several
        // matching clusters; without it, reacquiring after two identically
        // colored Beyblades both drop out (e.g. right after a clash) has no
        // way to avoid randomly locking onto the other one's blob instead.
        this._prevSignal = null;
      }
      return;
    }

    const newRadius = Math.min(40, Math.max(4, Math.sqrt(variance) * 1.4));

    if (locked && this._lastTimestamp != null) {
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
