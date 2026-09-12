// Lets the user tap around the rim of a physical Spin Stadium to define
// its boundary as a 2D polygon in processing-canvas coordinates. Tracked
// Tops that cross outside this polygon and stay out trigger a Ring-Out.

const OUT_CONFIRM_FRAMES = 6; // frames a blob must stay outside before it counts as out

export class StadiumBoundary {
  constructor() {
    this.points = []; // [{x,y}] in processing-canvas space
    this.closed = false;
  }

  reset() {
    this.points = [];
    this.closed = false;
  }

  addPoint(x, y) {
    if (this.closed) return;
    this.points.push({ x, y });
  }

  finish() {
    if (this.points.length >= 3) this.closed = true;
    return this.closed;
  }

  get isReady() {
    return this.closed && this.points.length >= 3;
  }

  /** Standard ray-casting point-in-polygon test. */
  contains(x, y) {
    if (!this.isReady) return true;
    let inside = false;
    const pts = this.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  center() {
    if (this.points.length === 0) return null;
    const sum = this.points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / this.points.length, y: sum.y / this.points.length };
  }
}

/** Tracks consecutive out-of-bounds frames per blob name so a single noisy
 *  reading doesn't falsely trigger a ring-out. */
export class RingOutWatcher {
  constructor(boundary) {
    this.boundary = boundary;
    this._outStreak = new Map();
  }

  reset() {
    this._outStreak.clear();
  }

  /** @returns {boolean} true the frame a blob is confirmed to have ringed out */
  check(blob) {
    if (!blob.isActive() || !this.boundary.isReady) return false;
    const inside = this.boundary.contains(blob.centroid.x, blob.centroid.y);
    const streak = (this._outStreak.get(blob.name) || 0);
    if (inside) {
      this._outStreak.set(blob.name, 0);
      return false;
    }
    const next = streak + 1;
    this._outStreak.set(blob.name, next);
    return next === OUT_CONFIRM_FRAMES;
  }
}
