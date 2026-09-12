// Draws the AR heads-up display on top of the camera feed: stadium boundary,
// per-Beyblade tracking markers with RPM, and the inter-blob distance line.
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

export function renderHud(ctx, { canvas, camera, boundary, blobA, blobB, calibrationMode, debugFrame }) {
  const dpr = resizeCanvasToDisplaySize(canvas);
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(dpr, dpr);
  const dispW = canvas.clientWidth, dispH = canvas.clientHeight;

  if (debugFrame) {
    drawDebugMatches(ctx, camera, blobA, COLOR_A, dispW, dispH, debugFrame);
    drawDebugMatches(ctx, camera, blobB, COLOR_B, dispW, dispH, debugFrame);
  }
  drawBoundary(ctx, camera, boundary, dispW, dispH, calibrationMode === "stadium");
  drawTrail(ctx, camera, blobA, COLOR_A, dispW, dispH);
  drawTrail(ctx, camera, blobB, COLOR_B, dispW, dispH);
  drawBlob(ctx, camera, blobA, COLOR_A, dispW, dispH);
  drawBlob(ctx, camera, blobB, COLOR_B, dispW, dispH);
  drawDistanceLine(ctx, camera, blobA, blobB, dispW, dispH);

  ctx.restore();
}

/** Debug aid: paints every pixel the tracker currently considers "this
 *  Beyblade's color" as a translucent dot. Lets you see directly whether
 *  calibration is picking up just the Beyblade, or also background/glare —
 *  much faster to diagnose than guessing from crosshair behavior alone. */
function drawDebugMatches(ctx, camera, blob, color, dispW, dispH, frame) {
  if (!blob?.targetHsv) return;
  const points = blob.computeDebugMatches(frame, 2);
  if (points.length === 0) return;
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

/** Draws a fading motion trail behind a Beyblade using its recent tracked
 *  positions (tracker.js keeps a short rolling history for this). Drawn
 *  before the crosshair so the crosshair sits on top of it. */
function drawTrail(ctx, camera, blob, color, dispW, dispH) {
  const trail = blob?.trail;
  if (!trail || trail.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  for (let i = 1; i < trail.length; i++) {
    const a = toDisplay(camera, trail[i - 1], dispW, dispH);
    const b = toDisplay(camera, trail[i], dispW, dispH);
    const t = i / trail.length; // 0 (oldest) -> 1 (newest)
    ctx.globalAlpha = 0.06 + t * 0.35;
    ctx.lineWidth = 1.5 + t * 3.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
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

/** A phone camera can't resolve real Beyblade spin speeds (several thousand
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
