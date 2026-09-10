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

export function renderHud(ctx, { canvas, camera, boundary, blobA, blobB, calibrationMode }) {
  const dpr = resizeCanvasToDisplaySize(canvas);
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(dpr, dpr);
  const dispW = canvas.clientWidth, dispH = canvas.clientHeight;

  drawBoundary(ctx, camera, boundary, dispW, dispH, calibrationMode === "stadium");
  drawBlob(ctx, camera, blobA, COLOR_A, dispW, dispH);
  drawBlob(ctx, camera, blobB, COLOR_B, dispW, dispH);
  drawDistanceLine(ctx, camera, blobA, blobB, dispW, dispH);

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
  const label = `${blob.name} · ${Math.round(blob.rpm)} RPM`;
  const ty = d.y - r - 14;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.strokeText(label, d.x, ty);
  ctx.fillText(label, d.x, ty);
  ctx.restore();
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
