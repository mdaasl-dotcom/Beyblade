import { CameraFeed } from "./camera.js";
import { BlobTracker } from "./tracker.js";
import { StadiumBoundary, RingOutWatcher } from "./stadiumCalibration.js";
import { BattleEngine, MatchState } from "./battleEngine.js";
import { renderHud } from "./hud.js";
import { isArSupported, XrStadiumView } from "./xrView.js";
import { AiDetector } from "./aiDetector.js";

const videoEl = document.getElementById("camera-feed");
const canvas = document.getElementById("hud-canvas");
const ctx = canvas.getContext("2d");
const statusLine = document.getElementById("status-line");
const helpText = document.getElementById("help-text");
const logPanel = document.getElementById("log-panel");
const toast = document.getElementById("event-toast");

const btnStartCamera = document.getElementById("btn-start-camera");
const btnCalibrateStadium = document.getElementById("btn-calibrate-stadium");
const btnCalibrateA = document.getElementById("btn-calibrate-a");
const btnCalibrateB = document.getElementById("btn-calibrate-b");
const btnStartMatch = document.getElementById("btn-start-match");
const btnResetRound = document.getElementById("btn-reset-round");
const btnEnterAr = document.getElementById("btn-enter-ar");
const btnDebugView = document.getElementById("btn-debug-view");
const btnAiMode = document.getElementById("btn-ai-mode");
const cameraSelect = document.getElementById("camera-select");
const toleranceRow = document.getElementById("tolerance-row");
const toleranceSlider = document.getElementById("tolerance-slider");
const toleranceLabel = document.getElementById("tolerance-label");

const winsAEl = document.getElementById("wins-a");
const winsBEl = document.getElementById("wins-b");
const nameAEl = document.getElementById("name-a");
const nameBEl = document.getElementById("name-b");

// ---------- First-open walkthrough ----------

const WALKTHROUGH_SLIDES = [
  {
    icon: "1",
    title: "Point your camera at the stadium",
    body: "Spin Battle Tracker turns your phone or laptop camera into a live AR overlay for your real stadium — no simulation, it tracks the actual tops spinning in front of you.",
  },
  {
    icon: "2",
    title: "Start the camera",
    body: "Tap “Start Camera” and allow camera access when your browser asks. You'll see your stadium show up live on screen.",
  },
  {
    icon: "3",
    title: "Trace the stadium rim",
    body: "Tap “Calibrate Stadium,” then tap 6–8 points around the inside rim of your bowl. Tap the button again to close the boundary — this is what makes ring-outs work.",
  },
  {
    icon: "4",
    title: "Lock on to each top",
    body: "Tap “Calibrate Player A,” then tap directly on the first top's most colorful spot. Do the same for Player B — matching stickers on both is fine, the app tells them apart by position too, not just color.",
  },
  {
    icon: "5",
    title: "Start the match",
    body: "Tap “Start Match” and spin in. Clashes, ring-outs, and stamina-outs are called automatically, with a live scoreboard across rounds.",
  },
];

const walkthroughEl = document.getElementById("walkthrough");
const walkthroughIcon = document.getElementById("walkthrough-icon");
const walkthroughDots = document.getElementById("walkthrough-dots");
const walkthroughTitle = document.getElementById("walkthrough-title");
const walkthroughBody = document.getElementById("walkthrough-body");
const walkthroughBack = document.getElementById("walkthrough-back");
const walkthroughNext = document.getElementById("walkthrough-next");
const walkthroughSkip = document.getElementById("walkthrough-skip");

let walkthroughStep = 0;

function renderWalkthroughStep() {
  const slide = WALKTHROUGH_SLIDES[walkthroughStep];
  walkthroughIcon.textContent = slide.icon;
  walkthroughTitle.textContent = slide.title;
  walkthroughBody.textContent = slide.body;

  walkthroughDots.innerHTML = "";
  WALKTHROUGH_SLIDES.forEach((_, i) => {
    const dot = document.createElement("span");
    if (i === walkthroughStep) dot.classList.add("active");
    walkthroughDots.appendChild(dot);
  });

  walkthroughBack.hidden = walkthroughStep === 0;
  const isLast = walkthroughStep === WALKTHROUGH_SLIDES.length - 1;
  walkthroughNext.textContent = isLast ? "Let's go" : "Next";
}

function closeWalkthrough() {
  walkthroughEl.hidden = true;
}

walkthroughNext.addEventListener("click", () => {
  if (walkthroughStep < WALKTHROUGH_SLIDES.length - 1) {
    walkthroughStep++;
    renderWalkthroughStep();
  } else {
    closeWalkthrough();
  }
});

walkthroughBack.addEventListener("click", () => {
  if (walkthroughStep > 0) {
    walkthroughStep--;
    renderWalkthroughStep();
  }
});

walkthroughSkip.addEventListener("click", closeWalkthrough);

renderWalkthroughStep();

// ---------- App state ----------

const camera = new CameraFeed(videoEl, { processWidth: 240 });
const boundary = new StadiumBoundary();
const ringOutWatcher = new RingOutWatcher(boundary);
const blobA = new BlobTracker("A", "accent-a");
const blobB = new BlobTracker("B", "accent-b");
const battle = new BattleEngine({ onEvent: handleBattleEvent });

let calibrationMode = null; // null | "stadium" | "calibrate-a" | "calibrate-b"
let running = false;
let currentFrame = null;
let debugView = false;
let debugFrameCounter = 0;
let cachedDebugPoints = { a: [], b: [] };
const DEBUG_RECOMPUTE_EVERY = 4; // frames between full-frame debug-mask scans
const xrView = new XrStadiumView();
const aiDetector = new AiDetector();
let aiMode = false;

// AI detection replaces the color-scanning step with a small model trained
// on real footage of these tops — it doesn't need per-Top color
// calibration, since it already knows roughly what "a top" looks like. If
// the model fails to load (e.g. it hasn't been trained/published yet),
// this fails gracefully and the app just keeps using the color tracker —
// nothing about the existing flow is disturbed either way.
btnAiMode.addEventListener("click", async () => {
  if (aiMode) {
    aiMode = false;
    btnAiMode.classList.remove("armed");
    btnAiMode.textContent = "Try AI Detection (Beta)";
    btnCalibrateA.disabled = !boundary.isReady;
    btnCalibrateB.disabled = !boundary.isReady;
    helpText.textContent = "Back to color tracking — calibrate each Player's color if you haven't already.";
    maybeEnableStartMatch();
    return;
  }

  btnAiMode.disabled = true;
  setStatus("Loading AI model…");
  try {
    if (!aiDetector.ready) await aiDetector.load();
    aiMode = true;
    btnAiMode.disabled = false;
    btnAiMode.classList.add("armed");
    btnAiMode.textContent = "AI Mode: ON (tap for Color Mode)";
    // AI mode doesn't need per-Top color calibration.
    btnCalibrateA.disabled = true;
    btnCalibrateB.disabled = true;
    helpText.textContent = "AI detection active — no color calibration needed for the Tops.";
    setStatus("AI mode ready. Calibrate the stadium if you haven't, then start the match.");
    maybeEnableStartMatch();
  } catch (err) {
    btnAiMode.disabled = false;
    setStatus(`Couldn't load the AI model (${err.message}) — staying on color tracking.`);
  }
});

btnDebugView.addEventListener("click", () => {
  debugView = !debugView;
  btnDebugView.classList.toggle("armed", debugView);
  btnDebugView.textContent = debugView ? "Hide Debug View" : "Show Debug View";
  // The tightness slider only does anything for color matching — hide it in
  // AI mode so it doesn't look like it should be affecting the model.
  toleranceRow.hidden = !debugView || aiMode;
  if (debugView && currentFrame && !aiMode) {
    // Force an immediate recompute on the next frame instead of waiting up
    // to DEBUG_RECOMPUTE_EVERY frames to show anything.
    debugFrameCounter = 0;
    cachedDebugPoints = {
      a: blobA.computeDebugMatches(currentFrame, 3),
      b: blobB.computeDebugMatches(currentFrame, 3),
    };
  }
});

// Lets the user tighten/loosen how picky the color match is while watching
// the debug-view dots shrink or grow in real time — much faster to dial in
// per-lighting-setup than guessing at fixed numbers in code.
toleranceSlider.addEventListener("input", () => {
  const value = Number(toleranceSlider.value);
  blobA.hueTolerance = value;
  blobB.hueTolerance = value;
  toleranceLabel.textContent = `Match tightness: ${value}°`;
});

function setStatus(text) {
  statusLine.textContent = text;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function logLine(text) {
  const div = document.createElement("div");
  div.textContent = text;
  logPanel.appendChild(div);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function handleBattleEvent(entry) {
  if (entry.type === "collision") showToast(entry.message);
  if (entry.type === "round_over") {
    showToast(entry.message);
    winsAEl.textContent = battle.wins.a;
    winsBEl.textContent = battle.wins.b;
    btnStartMatch.disabled = false;
    btnStartMatch.textContent = "Start Next Round";
  }
  if (entry.type === "round_start") {
    showToast(entry.message);
  }
  logLine(entry.message);
}

btnStartCamera.addEventListener("click", async () => {
  btnStartCamera.disabled = true;
  setStatus("Requesting camera access…");
  try {
    await camera.start();
    running = true;
    setStatus("Camera live. Calibrate the stadium boundary next.");
    btnCalibrateStadium.disabled = false;
    btnAiMode.disabled = false;
    if (await isArSupported()) btnEnterAr.disabled = false;
    await populateCameraSelect();
    requestAnimationFrame(loop);
  } catch (err) {
    setStatus(`Camera error: ${err.message}`);
    btnStartCamera.disabled = false;
  }
});

/** Shows a camera picker once more than one video input is available —
 *  e.g. a laptop's built-in webcam alongside a phone used as a webcam via
 *  an app like Camo/EpocCam/Iriun. Device labels only become visible after
 *  permission has been granted at least once, hence calling this after the
 *  first successful camera.start(). */
async function populateCameraSelect() {
  const devices = await camera.listVideoInputs();
  if (devices.length < 2) return;

  cameraSelect.innerHTML = "";
  devices.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    cameraSelect.appendChild(opt);
  });
  cameraSelect.hidden = false;
}

cameraSelect.addEventListener("change", async () => {
  setStatus("Switching camera…");
  try {
    await camera.start(cameraSelect.value);
    // Prior calibration was tied to the old camera's view/colors and is no
    // longer valid, so clear it rather than silently tracking the wrong spot.
    boundary.reset();
    ringOutWatcher.reset();
    blobA.targetHsv = null;
    blobA.centroid = null;
    blobB.targetHsv = null;
    blobB.centroid = null;
    battle.reset();
    btnCalibrateStadium.disabled = false;
    btnCalibrateA.disabled = true;
    btnCalibrateB.disabled = true;
    btnStartMatch.disabled = true;
    btnResetRound.disabled = true;
    setStatus("Camera switched. Re-calibrate the stadium and Tops to match the new view.");
    helpText.textContent = "Tap 'Calibrate Stadium' again for the new camera view.";
  } catch (err) {
    setStatus(`Camera error: ${err.message}`);
  }
});

btnCalibrateStadium.addEventListener("click", () => {
  if (calibrationMode !== "stadium") {
    calibrationMode = "stadium";
    boundary.reset();
    ringOutWatcher.reset();
    btnCalibrateStadium.classList.add("armed");
    btnCalibrateStadium.textContent = "Finish Stadium (0 pts)";
    helpText.textContent = "Tap around the rim of the stadium bowl (6-8 points), then tap this button again to finish.";
  } else {
    if (boundary.finish()) {
      calibrationMode = null;
      btnCalibrateStadium.classList.remove("armed");
      btnCalibrateStadium.textContent = "2. Calibrate Stadium";
      if (aiMode) {
        helpText.textContent = "Stadium set. AI detection is on, so you're ready to go.";
        setStatus("Stadium calibrated. Tap 'Start Match' to begin.");
      } else {
        btnCalibrateA.disabled = false;
        helpText.textContent = "Stadium set. Now calibrate each Top.";
        setStatus("Stadium calibrated. Tap 'Calibrate Player A', then tap the Top in view.");
      }
      maybeEnableStartMatch();
    } else {
      helpText.textContent = "Need at least 3 points to close the stadium boundary.";
    }
  }
});

btnCalibrateA.addEventListener("click", () => armColorCalibration("calibrate-a", blobA, btnCalibrateA));
btnCalibrateB.addEventListener("click", () => armColorCalibration("calibrate-b", blobB, btnCalibrateB));

function armColorCalibration(mode, blob, btn) {
  calibrationMode = mode;
  btn.classList.add("armed");
  helpText.textContent = `Tap directly on ${blob.name === "A" ? nameAEl.textContent : nameBEl.textContent}'s Top in the camera view.`;
}

canvas.addEventListener("pointerdown", (e) => {
  if (!calibrationMode || !currentFrame) return;
  const rect = canvas.getBoundingClientRect();
  const dispX = e.clientX - rect.left;
  const dispY = e.clientY - rect.top;
  const p = camera.displayToProcess(dispX, dispY, rect.width, rect.height);

  if (calibrationMode === "stadium") {
    boundary.addPoint(p.x, p.y);
    btnCalibrateStadium.textContent = `Finish Stadium (${boundary.points.length} pts)`;
    return;
  }

  if (calibrationMode === "calibrate-a") {
    const result = blobA.calibrate(currentFrame, p.x, p.y);
    if (result.ok) {
      calibrationMode = null;
      btnCalibrateA.classList.remove("armed");
      btnCalibrateB.disabled = false;
      if (result.lowSaturation) {
        helpText.textContent = "That spot looked gray/metallic/white — hard to track by color. Tap Player A again on a more colorful spot if tracking seems unreliable, otherwise continue.";
      } else {
        helpText.textContent = "Player A locked on. Now calibrate Player B.";
      }
      setStatus("Calibrate Player B, or start the match if both are ready.");
      maybeEnableStartMatch();
    }
    return;
  }

  if (calibrationMode === "calibrate-b") {
    const result = blobB.calibrate(currentFrame, p.x, p.y);
    if (result.ok) {
      calibrationMode = null;
      btnCalibrateB.classList.remove("armed");
      if (result.lowSaturation) {
        helpText.textContent = "That spot looked gray/metallic/white — hard to track by color. Tap Player B again on a more colorful spot if tracking seems unreliable, otherwise continue.";
      } else {
        helpText.textContent = "Both Tops locked on.";
      }
      setStatus("Ready! Tap 'Start Match' to begin tracking the battle.");
      maybeEnableStartMatch();
    }
  }
});

function maybeEnableStartMatch() {
  const topsReady = aiMode || (blobA.targetHsv && blobB.targetHsv);
  if (topsReady && boundary.isReady) {
    btnStartMatch.disabled = false;
  }
}

btnStartMatch.addEventListener("click", () => {
  battle.startRound();
  btnStartMatch.disabled = true;
  btnResetRound.disabled = false;
  setStatus("Match in progress — tracking spin, position, and collisions.");
});

btnResetRound.addEventListener("click", () => {
  battle.reset();
  battle.ready();
  btnStartMatch.disabled = false;
  btnStartMatch.textContent = "Start Match";
  setStatus("Round reset. Tap 'Start Match' when ready.");
});

btnEnterAr.addEventListener("click", async () => {
  try {
    btnEnterAr.disabled = true;
    await xrView.enter(setStatus);
    btnEnterAr.textContent = "Exit AR";
    btnEnterAr.disabled = false;
    btnEnterAr.onclick = null;
    btnEnterAr.addEventListener("click", async () => {
      await xrView.exit();
      btnEnterAr.textContent = "Enter AR";
    }, { once: true });
  } catch (err) {
    setStatus(`AR error: ${err.message}`);
    btnEnterAr.disabled = false;
  }
});

function loop(timestamp) {
  if (!running) return;
  currentFrame = camera.grabFrame();

  let aiPoints = null;
  if (aiMode) {
    // Both trackers get the SAME candidate points — like two Tops sharing a
    // calibrated color in color mode, each tracker independently picks
    // whichever point is closest to its own last-known position, so
    // identity naturally stays consistent frame to frame without the model
    // needing to know "which top is which".
    aiPoints = aiDetector.detect(videoEl, camera.processWidth, camera.processHeight);
    blobA.updatePositionFromPoints(currentFrame, aiPoints, timestamp);
    blobB.updatePositionFromPoints(currentFrame, aiPoints, timestamp);
  } else {
    blobA.updatePosition(currentFrame, timestamp);
    blobB.updatePosition(currentFrame, timestamp);
  }

  const ringOutA = ringOutWatcher.check(blobA);
  const ringOutB = ringOutWatcher.check(blobB);

  battle.update({ blobA, blobB, ringOutA, ringOutB, now: timestamp });

  // The debug-mask scan touches every pixel in the frame for both trackers —
  // too expensive to redo on every single render frame, especially on top of
  // an already-taxed pipeline like a phone-as-webcam app. Recompute only
  // every few frames; the HUD just keeps redrawing the last computed points
  // in between, which looks effectively the same for a diagnostic overlay.
  if (debugView) {
    debugFrameCounter++;
    if (debugFrameCounter % DEBUG_RECOMPUTE_EVERY === 0) {
      cachedDebugPoints = {
        a: blobA.computeDebugMatches(currentFrame, 3),
        b: blobB.computeDebugMatches(currentFrame, 3),
      };
    }
  }

  renderHud(ctx, {
    canvas, camera, boundary, blobA, blobB, calibrationMode,
    debugPoints: debugView && !aiMode ? cachedDebugPoints : null,
    aiDebugPoints: debugView && aiMode ? aiPoints : null,
  });

  requestAnimationFrame(loop);
}
