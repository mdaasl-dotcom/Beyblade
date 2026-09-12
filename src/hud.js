// Draws the AR heads-up display on top of the camera feed: stadium boundary,
// per-Top tracking markers with RPM, and the inter-blob distance line.
// Pure rendering module — takes already-computed state, no logic.

const COLOR_A = "#ff5470";
const COLOR_B = "#29c5ff";
const BOUNDARY_COLOR = "rgba(255, 210, 63, 0.85)";

export function resizeCanvasToDisplaySize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

export function renderHud(ctx, { canvas, camera, boundary, blobA, blobB, calibrationMode, debugPoints }) {
  const dpr = resizeCanvasToDisplaySize(canvas);
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(dpr, dpr);
  const dispW = canvas.clientWidth, dispH = canvas.clientHeight;

  if (debugPoints) {
    drawDebugMatches(ctx, camera, debugPoints.a, COLOR_A, dispW, dispH);
    drawDebugMatches(ctx, camera, debugPoints.b, COLOR_B, dispW, dispH);
  }
  drawBoundary(ctx, camera, boundary, dispW, dispH, calibrationMode === "stadium");
  drawFullTrail(ctx, camera, blobA, COLOR_A, dispW, dispH);
  drawFullTrail(ctx, camera, blobB, COLOR_B, dispW, dispH);
  drawTrail(ctx, camera, blobA, COLOR_A, dispW, dispH);
  drawTrail(ctx, camera, blobB, COLOR_B, dispW, dispH);
  drawBlob(ctx, camera, blobA, COLOR_A, dispW, dispH);
  drawBlob(ctx, camera, blobB, COLOR_B, dispW, dispH);
  drawDistanceLine(ctx, camera, blobA, blobB, dispW, dispH);

  ctx.restore();
}

/** Debug aid: paints every pixel the tracker currently considers "this
 *  Top's color" as a translucent dot. Lets you see directly whether
 *  calibration is picking up just the Top, or also background/glare —
 *  much faster to diagnose than guessing from crosshair behavior alone.
 *  Takes already-computed points (see main.js) rather than a raw frame —
 *  scanning every pixel is too expensive to redo on every render frame. */
function drawDebugMatches(ctx, camera, points, color, dispW, dispH) {
  if (!points || points.length === 0) return;
  const dotSize = Math.max(2, (dispW / camera.processWidth) * 2.2);
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.5;
  for (const p of points) {
    const d = toDisplay(camera, p, dispW, dispH);
    ctx.fillRect(d.x - dotSize / 2, d.y - dotSize / 2, dotSize, dotSize);
  }
  ctx.restore();
}

function toDisplay(camera, p, dispW, dispH) {
  return camera.processToDisplay(p.x, p.y, dispW, dispH);
}

function drawBoundary(ctx, camera, boundary, dispW, dispH, highlight) {
  if (!boundary || boundary.points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = BOUNDARY_COLOR;
  ctx.lineWidth = highlight ? 3 : 2;
  ctx.setLineDash(boundary.isReady ? [] : [8, 6]);
  ctx.beginPath();
  boundary.points.forEach((p, i) => {
    const d = toDisplay(camera, p, dispW, dispH);
    if (i === 0) ctx.moveTo(d.x, d.y);
    else ctx.lineTo(d.x, d.y);
  });
  if (boundary.isReady) ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = BOUNDARY_COLOR;
  boundary.points.forEach((p) => {
    const d = toDisplay(camera, p, dispW, dispH);
    ctx.beginPath();
    ctx.arc(d.x, d.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

/** Light moving-average smoothing so small frame-to-frame tracking jitter
 *  doesn't turn into a zigzag when drawn — purely a rendering concern, the
 *  tracker's own raw positions (used for velocity/ring-out/etc.) are
 *  untouched. */
function smoothPoints(points, windowRadius = 1) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - windowRadius); j <= Math.min(points.length - 1, i + windowRadius); j++) {
      sx += points[j].x; sy += points[j].y; n++;
    }
    out.push({ x: sx / n, y: sy / n });
  }
  return out;
}

/** Draws the Top's entire path so far this round as a faint, constant-width
 *  line — a recap of where it's been, underneath the brighter short trail
 *  below. A single stroked path (no per-segment styling) so it stays cheap
 *  to draw even once a long round has built up hundreds of points. */
function drawFullTrail(ctx, camera, blob, color, dispW, dispH) {
  const full = blob?.fullTrail;
  if (!full || full.length < 2) return;
  const pts = full.map((p) => toDisplay(camera, p, dispW, dispH));

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.restore();
}

/** Draws a fading motion trail behind a Top using its recent tracked
 *  positions (tracker.js keeps a short rolling history for this), rendered
 *  as a smooth curve — quadratic Bezier segments through the midpoints of
 *  each pair of (smoothed) points, a standard trick for turning a polyline
 *  into a natural-looking curve without full spline math. Drawn before the
 *  crosshair so the crosshair sits on top of it. */
function drawTrail(ctx, camera, blob, color, dispW, dispH) {
  const trail = blob?.trail;
  if (!trail || trail.length < 3) return;
  const pts = smoothPoints(trail.map((p) => toDisplay(camera, p, dispW, dispH)));

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const midA = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const midB = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const t = i / pts.length; // 0 (oldest) -> 1 (newest)
    ctx.globalAlpha = 0.25 + t * 0.65;
    ctx.lineWidth = 2.5 + t * 5;
    ctx.shadowBlur = 6 * t;
    ctx.beginPath();
    ctx.moveTo(midA.x, midA.y);
    ctx.quadraticCurveTo(p1.x, p1.y, midB.x, midB.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBlob(ctx, camera, blob, color, dispW, dispH) {
  if (!blob || !blob.isActive()) return;
  const d = toDisplay(camera, blob.centroid, dispW, dispH);
  const scale = dispW / camera.processWidth;
  const r = blob.radius * scale;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = 0.4 + blob.confidence * 0.6;

  ctx.beginPath();
  ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
  ctx.stroke();

  // crosshair
  ctx.beginPath();
  ctx.moveTo(d.x - r - 8, d.y);
  ctx.lineTo(d.x - r + 4, d.y);
  ctx.moveTo(d.x + r - 4, d.y);
  ctx.lineTo(d.x + r + 8, d.y);
  ctx.moveTo(d.x, d.y - r - 8);
  ctx.lineTo(d.x, d.y - r + 4);
  ctx.moveTo(d.x, d.y + r - 4);
  ctx.lineTo(d.x, d.y + r + 8);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.font = "600 13px -apple-system, sans-serif";
  ctx.textAlign = "center";
  const label = `${blob.name} · ${spinStatusLabel(blob)}`;
  const ty = d.y - r - 14;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.strokeText(label, d.x, ty);
  ctx.fillText(label, d.x, ty);
  ctx.restore();
}

/** A phone camera can't resolve real Top spin speeds (several thousand
 *  RPM) without aliasing into a plausible-but-wrong number — see the
 *  RPM_TRUST_THRESHOLD comment in tracker.js. So while a blob's rpm reading
 *  hasn't settled into the camera's actually-resolvable range, show a plain
 *  qualitative status instead of a fabricated-looking number; once it has,
 *  show both the status and the estimate together. */
function spinStatusLabel(blob) {
  if (!blob.rpmTrustworthy) return "Spinning fast";
  if (blob.rpm > 200) return `Slowing · ~${Math.round(blob.rpm)} RPM`;
  if (blob.rpm > 50) return `Nearly stopped · ~${Math.round(blob.rpm)} RPM`;
  return "Almost stopped";
}

function drawDistanceLine(ctx, camera, blobA, blobB, dispW, dispH) {
  if (!blobA?.isActive() || !blobB?.isActive()) return;
  const a = toDisplay(camera, blobA.centroid, dispW, dispH);
  const b = toDisplay(camera, blobB.centroid, dispW, dispH);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}
