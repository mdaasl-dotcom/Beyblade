// Color-blob tracking of physical Tops in the live camera feed, plus a
// lightweight rotation-speed (RPM) estimator based on circular
// cross-correlation of a ring of brightness samples around each blob.
//
// This is a heuristic, not a precision instrument: it needs a Top with
// some visible color/pattern asymmetry and reasonable lighting. Treat the
// RPM readout as an estimate, not a certified measurement.

const RING_SAMPLES = 24; // angular samples used for rotation correlation
const SEARCH_MARGIN = 2.5; // how much the ROI grows around the last-known blob radius
const LOCK_CONFIDENCE_THRESHOLD = 0.15; // below this, search the whole frame to reacquire
const CLUSTER_MERGE_RADIUS = 18; // points within this distance are treated as one blob

// How fast the calibrated target color is allowed to drift toward what a
// confident, stationary-ish lock is actually seeing. Lighting conditions
// (a shadow crossing the stadium, a camera auto-adjusting exposure) can
// slowly shift a Top's apparent color well past its frozen calibration
// value over the course of a long match. Slow enough that a genuinely
// different color (e.g. the other Top drifting into view) can't "fix"
// itself into a false match within a few frames.
const COLOR_DRIFT_RATE = 0.015;
// Only drift while translating slowly: the speed-adaptive tolerance in
// _isMatch() admits background-tinted, motion-blurred pixels once a Top is
// moving fast, and those would otherwise corrupt the drift with exactly the
// blur we're trying to stay robust to.
const COLOR_DRIFT_MAX_SPEED = 250;
const COLOR_DRIFT_MIN_SAT = 0.15; // never drift toward a washed-out/gray sample

// Confidence used to move by a flat +-0.2/-0.15 per updatePosition() call,
// which quietly assumed ~30fps: a laggy camera pipeline calling this less
// often would take longer in wall-clock time to declare lock lost (or
// reacquired) than a fast one, purely from being called less frequently.
// Expressed per-second instead and scaled by actual elapsed time, these
// match the old per-call amounts exactly at a 30fps baseline.
const CONFIDENCE_GROWTH_PER_SEC = 6; // 0.2 / (1/30)
const CONFIDENCE_DECAY_PER_SEC = 4.5; // 0.15 / (1/30)
const CONFIDENCE_DT_CAP = 0.5; // guard against a huge step after a long pause (tab backgrounded, etc.)

// Real Tops spin at roughly 5,000-12,000 RPM. A camera sampling at
// ~30-60fps can only unambiguously resolve rotation up to about half a
// revolution per frame before the reading aliases into a plausible-looking
// but wrong number (the same "wagon-wheel effect" that makes a fast wheel
// look slow, stopped, or backwards on video) — roughly 900 RPM at 30fps,
// ~1800 at 60fps. Below that, a real Top slowing down late in a match
// is finally within a camera's reach. We can't detect aliasing directly, so
// this is a heuristic: once the smoothed estimate has stayed under the
// threshold for a bit (not just one lucky low frame), treat it as trustworthy
// and keep showing a number, since spin only decays from here — it won't
// suddenly speed back up and become untrustworthy again mid-round.
const RPM_TRUST_THRESHOLD = 900;
const RPM_TRUST_SETTLE_MS = 600;
// Time-based, not a fixed sample count: a laggy camera pipeline (e.g. a
// phone-as-webcam app like Camo over WiFi) can deliver genuinely new frames
// far slower than the render loop runs. A fixed count of samples would then
// span many real seconds instead of ~1s, so one bad position right after
// calibration (while confidence is still ramping up) could sit in the trail
// for the entire session instead of aging out quickly.
const TRAIL_DURATION_MS = 1200;
const TRAIL_MAX_POINTS = 200; // hard cap so a runaway high frame rate can't grow this unbounded

// Separate from the short glowing trail above: this one keeps the Top's
// entire path for the whole round (cleared only when a round starts), so
// players can see the full line it carved through the stadium. Capped and
// halved (keeping every other point) rather than dropping the oldest half
// outright, so a long round still shows its full shape at lower resolution
// instead of losing its early portion entirely.
const FULL_TRAIL_MAX_POINTS = 1500;

/** Greedily groups matched pixels into separate blobs by proximity. Needed
 *  when two Tops are calibrated to the *same* color (e.g. both wearing
 *  identical stickers): a naive single average over every matching pixel in
 *  the frame would blend two separate Tops into one bogus midpoint
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
    this.hueTolerance = 14; // adjustable live via the app's "Match Tightness" slider
    this.satMin = 0.25;
    this.valMin = 0.2;
    this.centroid = null; // {x,y} in processing-canvas space
    this.radius = 6;
    // A separate, smoothed copy of the radius used only for picking the RPM
    // ring's sampling radius. this.radius itself is deliberately responsive
    // (HUD, clash distance), but that means it jitters frame to frame with
    // measurement noise — sampling the rotation ring at a radius that jumps
    // around introduces signal differences that look like rotation but
    // aren't, especially right as a Top wobbles near the end of its spin.
    this._smoothedRadius = 6;
    this.confidence = 0;
    this.velocity = { x: 0, y: 0 };
    this.rpm = 0;
    this.rpmTrustworthy = false;
    this._lowRegimeSince = null;
    this._prevSignal = null;
    this._rotationLastTimestamp = null;
    this._lastAngleOffset = 0;
    this._lastTimestamp = null;
    // Separate from _lastTimestamp (which only advances on a *successful*
    // match): this tracks wall-clock time across every updatePosition()
    // call, success or miss, so confidence can decay/grow at a fixed rate
    // per second rather than a fixed amount per call — a laggy camera
    // pipeline calling this less often shouldn't make losing lock take
    // longer in real time than it would on a fast one.
    this._lastCallTimestamp = null;
    this._history = []; // recent centroids for smoothing/velocity
    this._fullHistory = []; // whole-round path, for the full-trail recap
  }

  _isMatch(h, s, v) {
    if (!this.targetHsv) return false;
    const [targetH] = this.targetHsv;
    let dh = Math.abs(h - targetH);
    if (dh > 180) dh = 360 - dh;
    // Fast motion blurs a Top's color across pixels — the blur mixes in
    // the background, which desaturates and darkens it — so a Top can
    // drop below the calibrated color thresholds purely from moving fast,
    // right when losing lock matters most (a launch dash, or flying off
    // after a clash). Loosen the thresholds proportionally to how fast
    // it was actually moving last frame, rather than leaving them fixed.
    const speedFactor = Math.min(1, this.speed / 900);
    const hueTolerance = this.hueTolerance + speedFactor * 10;
    const satMin = this.satMin * (1 - speedFactor * 0.4);
    const valMin = this.valMin * (1 - speedFactor * 0.4);
    return dh <= hueTolerance && s >= satMin && v >= valMin;
  }

  /** Nudges targetHsv a small step toward an observed color, and re-derives
   *  satMin/valMin from it exactly as calibrate() does — keeping the match
   *  thresholds consistent with whatever color is now considered "target"
   *  instead of leaving them pinned to the original calibration sample. */
  _driftTargetColor(observedH, observedS, observedV) {
    const [targetH, targetS, targetV] = this.targetHsv;
    // Hue wraps at 360, so lerp the *shorter* angular distance rather than
    // the raw difference — otherwise a target near 350° drifting toward an
    // observed 5° would swing the long way around through 180°.
    let dh = observedH - targetH;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    let newH = targetH + dh * COLOR_DRIFT_RATE;
    if (newH < 0) newH += 360;
    if (newH >= 360) newH -= 360;
    const newS = targetS + (observedS - targetS) * COLOR_DRIFT_RATE;
    const newV = targetV + (observedV - targetV) * COLOR_DRIFT_RATE;
    this.targetHsv = [newH, newS, newV];
    this.satMin = Math.max(0.2, newS * 0.55);
    this.valMin = Math.max(0.15, newV * 0.5);
  }

  /** For the debug overlay: samples every `stride`th pixel across the whole
   *  frame and returns the ones matching this tracker's calibrated color, so
   *  the UI can show exactly what the tracker considers "this Top" —
   *  useful for seeing whether it's picking up background clutter or barely
   *  matching the Top at all. Not used by the tracking logic itself. */
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
    // Tighter than a first cut: with a generous hue tolerance and low floors,
    // things like beige carpet or warm-toned lighting can fall "close enough"
    // to a calibrated color (e.g. neon yellow) to get matched as if they were
    // the Top. Scaling closer to the actual calibrated saturation/value
    // (instead of a low flat floor) makes the match track this Top's
    // specific color more specifically.
    this.satMin = Math.max(0.2, this.targetHsv[1] * 0.55);
    this.valMin = Math.max(0.15, this.targetHsv[2] * 0.5);
    this.centroid = { x: px, y: py };
    this.radius = 10;
    this._smoothedRadius = 10;
    this.rpm = 0;
    this.rpmTrustworthy = false;
    this._lowRegimeSince = null;
    this._prevSignal = null;
    this._rotationLastTimestamp = null;
    this._lastCallTimestamp = null;
    this._history = [];
    this._fullHistory = [];
    // Shiny metal/gray/white/near-black spots have low saturation, so hue
    // barely means anything there — color tracking will struggle to tell
    // that apart from similarly dull background/lighting. Flag it so the UI
    // can suggest tapping a more colorful spot on the Top instead.
    const lowSaturation = this.targetHsv[1] < 0.25;
    return { ok: true, lowSaturation };
  }

  /** Scans the frame (within a region of interest around the last known
   *  position, once one exists) and updates centroid/radius/confidence. */
  updatePosition(frame, timestampMs) {
    if (!this.targetHsv) return;
    const { data, width, height } = frame;

    // Elapsed wall-clock time since the *previous call* (success or miss
    // alike) — see CONFIDENCE_GROWTH_PER_SEC/CONFIDENCE_DECAY_PER_SEC above.
    // Assume a typical ~30fps gap for the very first call, rather than 0
    // (which would freeze confidence) or an undefined jump.
    const dtCall = this._lastCallTimestamp != null
      ? Math.min(CONFIDENCE_DT_CAP, Math.max(0, (timestampMs - this._lastCallTimestamp) / 1000))
      : 1 / 30;
    this._lastCallTimestamp = timestampMs;

    // Only trust the small region-of-interest search while we still have a
    // confident lock. Once confidence has decayed (the Top moved out of
    // the ROI, motion blur, etc.) fall back to scanning the whole frame so a
    // lost target can be reacquired instead of the tracker staying stuck
    // forever re-checking the same empty patch of the frame.
    const locked = this.centroid && this.confidence > LOCK_CONFIDENCE_THRESHOLD;
    let minX = 0, minY = 0, maxX = width, maxY = height;
    if (locked) {
      // Predict where the Top likely is *this* frame from its last known
      // velocity, instead of just re-centering the search on where it was
      // last frame. A fast-moving or just-launched Top can travel well
      // outside a position-only search window between frames — especially
      // on a laggy camera pipeline where the gap between frames is bigger
      // than it looks — which otherwise forces a full-frame reacquire
      // (slower, and more likely to mis-pick between same-colored Tops)
      // purely because the ROI trailed behind instead of leading it.
      const dtSincePrediction = this._lastTimestamp != null
        ? Math.min(0.15, Math.max(0, (timestampMs - this._lastTimestamp) / 1000))
        : 0;
      const searchCenterX = this.centroid.x + this.velocity.x * dtSincePrediction;
      const searchCenterY = this.centroid.y + this.velocity.y * dtSincePrediction;
      // Extra margin proportional to how far the prediction itself moved
      // the center, to absorb the Top accelerating/changing direction
      // (e.g. bouncing off the stadium wall) rather than just trusting a
      // constant-velocity prediction exactly.
      const speedBoost = Math.hypot(this.velocity.x, this.velocity.y) * dtSincePrediction * 0.6;
      const r = this.radius * SEARCH_MARGIN + 12 + speedBoost;
      minX = Math.max(0, Math.floor(searchCenterX - r));
      minY = Math.max(0, Math.floor(searchCenterY - r));
      maxX = Math.min(width, Math.ceil(searchCenterX + r));
      maxY = Math.min(height, Math.ceil(searchCenterY + r));
    }

    const minPixels = 4;
    let cx, cy, count, variance;
    // Circular-mean components for hue (can't just average hue degrees
    // directly — it wraps at 360) plus a plain sum for saturation/value,
    // gathered alongside the position scan so color-drift compensation
    // below is free: no second pass over the matched pixels.
    let sumCos = 0, sumSin = 0, sSum = 0, vSum = 0;

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
            const rad = (h * Math.PI) / 180;
            sumCos += Math.cos(rad); sumSin += Math.sin(rad);
            sSum += s; vSum += v;
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
      // since another Top sharing this same color could be visible
      // anywhere in the frame too. Pick whichever cluster is closest to
      // where this Top is now *predicted* to be, rather than where it was
      // last seen — after a clash sends two identically-colored Tops flying
      // apart, the last-known position sits roughly between them, which is
      // nearly equidistant to both and prone to picking the wrong one. The
      // velocity recorded right before lock was lost is still the best
      // available signal for which side it went.
      let predictedX = this.centroid ? this.centroid.x : null;
      let predictedY = this.centroid ? this.centroid.y : null;
      if (this.centroid && this._lastTimestamp != null) {
        // Capped: this is extrapolating across however long the Top has
        // been lost (could be several frames), not one frame gap, so an
        // unbounded projection could run the predicted point arbitrarily
        // far from reality if it's been lost for a while or has since
        // changed direction (e.g. bounced off a wall while out of lock).
        const dtLost = Math.min(0.3, Math.max(0, (timestampMs - this._lastTimestamp) / 1000));
        predictedX += this.velocity.x * dtLost;
        predictedY += this.velocity.y * dtLost;
      }
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
        const best = predictedX != null
          ? clusters.reduce((a, b) =>
              Math.hypot(a.x - predictedX, a.y - predictedY) <=
              Math.hypot(b.x - predictedX, b.y - predictedY) ? a : b)
          : clusters.reduce((a, b) => (a.count >= b.count ? a : b));
        cx = best.x; cy = best.y; count = best.count; variance = best.variance;
      }
    }

    if (count === undefined || count < minPixels) {
      this.confidence = Math.max(0, this.confidence - CONFIDENCE_DECAY_PER_SEC * dtCall);
      if (this.confidence === 0) {
        // Fully lost: isActive() already goes false from confidence alone,
        // so the HUD stops drawing a crosshair. Deliberately keep the stale
        // centroid (rather than clearing it) — it's the only way to tell
        // "my Top" apart from another one sharing the same calibrated
        // color when re-scanning the whole frame below finds several
        // matching clusters; without it, reacquiring after two identically
        // colored Tops both drop out (e.g. right after a clash) has no
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
    this._smoothedRadius = this._smoothedRadius * 0.7 + newRadius * 0.3;
    this.confidence = Math.min(1, this.confidence + CONFIDENCE_GROWTH_PER_SEC * dtCall);
    this._lastTimestamp = timestampMs;

    // Drift the calibrated color slowly toward what a strong, slow-moving
    // lock is actually seeing (see COLOR_DRIFT_RATE above). Gated on the
    // *locked* scan specifically — the full-frame reacquire branch above
    // never accumulates sumCos/sumSin/sSum/vSum, since it may be sampling a
    // different Top's blob entirely while lock is still unconfirmed.
    if (locked && this.confidence > 0.7 && this.speed < COLOR_DRIFT_MAX_SPEED) {
      let avgHue = (Math.atan2(sumSin / count, sumCos / count) * 180) / Math.PI;
      if (avgHue < 0) avgHue += 360;
      const avgSat = sSum / count;
      const avgVal = vSum / count;
      if (avgSat > COLOR_DRIFT_MIN_SAT) {
        this._driftTargetColor(avgHue, avgSat, avgVal);
      }
    }

    this._history.push({ x: cx, y: cy, t: timestampMs });
    const cutoff = timestampMs - TRAIL_DURATION_MS;
    while (this._history.length > 0 && this._history[0].t < cutoff) this._history.shift();
    if (this._history.length > TRAIL_MAX_POINTS) {
      this._history.splice(0, this._history.length - TRAIL_MAX_POINTS);
    }

    this._fullHistory.push({ x: cx, y: cy, t: timestampMs });
    if (this._fullHistory.length > FULL_TRAIL_MAX_POINTS) {
      this._fullHistory = this._fullHistory.filter((_, i) => i % 2 === 0);
    }

    this._updateRotation(frame, timestampMs);
  }

  /** Samples brightness around a ring at ~70% of the blob radius and
   *  cross-correlates against the previous frame's ring signal to find the
   *  angular shift, i.e. how far the pattern rotated this frame. */
  _updateRotation(frame, timestampMs) {
    const { data, width, height } = frame;
    const r = Math.max(3, this._smoothedRadius * 0.7);
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

    // NOTE: this deliberately uses its own _rotationLastTimestamp rather than
    // the position tracker's this._lastTimestamp — that field gets updated to
    // the *current* frame's timestamp in updatePosition() just before this
    // method runs, which used to make `timestampMs - this._lastTimestamp`
    // always ~0 here, forcing dt to the 1ms floor below on every frame. That
    // produced wildly inflated instantRpm values that got rejected as noise
    // every time, silently freezing this.rpm at its initial value forever —
    // the RPM readout never actually updated at all.
    if (this._prevSignal && this._rotationLastTimestamp != null) {
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
        const dt = Math.max(1, timestampMs - this._rotationLastTimestamp) / 1000;
        const angleShiftDeg = (bestShift / RING_SAMPLES) * 360;
        const instantRpm = Math.abs((angleShiftDeg / dt) / 360) * 60;
        // Reject implausible single-frame spikes (> 3000 RPM) as noise.
        if (instantRpm < 3000) {
          this.rpm = this.rpm * 0.7 + instantRpm * 0.3;
        }
      } else {
        this.rpm *= 0.9; // low texture/contrast: decay estimate rather than trust it
      }

      // Latch "trustworthy" once we've settled below the resolvable range
      // for a sustained stretch, not just a single lucky low reading.
      if (!this.rpmTrustworthy) {
        if (this.rpm < RPM_TRUST_THRESHOLD) {
          if (this._lowRegimeSince == null) this._lowRegimeSince = timestampMs;
          else if (timestampMs - this._lowRegimeSince >= RPM_TRUST_SETTLE_MS) {
            this.rpmTrustworthy = true;
          }
        } else {
          this._lowRegimeSince = null;
        }
      }
    }

    this._prevSignal = signal;
    this._rotationLastTimestamp = timestampMs;
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.y);
  }

  /** Recent centroids (oldest first), for drawing an on-screen motion trail. */
  get trail() {
    return this._history;
  }

  /** The Top's whole path so far this round (oldest first), for drawing a
   *  full recap trail rather than just the last ~1.2s. */
  get fullTrail() {
    return this._fullHistory;
  }

  /** Clears both trails without touching calibration/lock state — call this
   *  when a fresh round starts so the recap trail doesn't carry over the
   *  previous round's path. */
  clearTrail() {
    this._history = [];
    this._fullHistory = [];
  }

  isActive() {
    return this.confidence > 0.3 && this.centroid != null;
  }
}
