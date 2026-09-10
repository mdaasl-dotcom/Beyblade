import { CameraFeed } from "./camera.js";
import { BlobTracker } from "./tracker.js";
import { StadiumBoundary, RingOutWatcher } from "./stadiumCalibration.js";
import { BattleEngine, MatchState } from "./battleEngine.js";
import { renderHud } from "./hud.js";
import { isArSupported, XrStadiumView } from "./xrView.js";

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

const winsAEl = document.getElementById("wins-a");
const winsBEl = document.getElementById("wins-b");
const nameAEl = document.getElementById("name-a");
const nameBEl = document.getElementById("name-b");

const camera = new CameraFeed(videoEl, { processWidth: 240 });
const boundary = new StadiumBoundary();
const ringOutWatcher = new RingOutWatcher(boundary);
const blobA = new BlobTracker("A", "accent-a");
const blobB = new BlobTracker("B", "accent-b");
const battle = new BattleEngine({ onEvent: handleBattleEvent });

let calibrationMode = null; // null | "stadium" | "calibrate-a" | "calibrate-b"
let running = false;
let currentFrame = null;
const xrView = new XrStadiumView();

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
    if (await isArSupported()) btnEnterAr.disabled = false;
    requestAnimationFrame(loop);
  } catch (err) {
    setStatus(`Camera error: ${err.message}`);
    btnStartCamera.disabled = false;
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
      btnCalibrateA.disabled = false;
      helpText.textContent = "Stadium set. Now calibrate each Beyblade.";
      setStatus("Stadium calibrated. Tap 'Calibrate Blader A', then tap the Beyblade in view.");
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
  helpText.textContent = `Tap directly on ${blob.name === "A" ? nameAEl.textContent : nameBEl.textContent}'s Beyblade in the camera view.`;
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
    if (blobA.calibrate(currentFrame, p.x, p.y)) {
      calibrationMode = null;
      btnCalibrateA.classList.remove("armed");
      btnCalibrateB.disabled = false;
      helpText.textContent = "Blader A locked on. Now calibrate Blader B.";
      setStatus("Calibrate Blader B, or start the match if both are ready.");
      maybeEnableStartMatch();
    }
    return;
  }

  if (calibrationMode === "calibrate-b") {
    if (blobB.calibrate(currentFrame, p.x, p.y)) {
      calibrationMode = null;
      btnCalibrateB.classList.remove("armed");
      helpText.textContent = "Both Beyblades locked on.";
      setStatus("Ready! Tap 'Start Match' to begin tracking the battle.");
      maybeEnableStartMatch();
    }
  }
});

function maybeEnableStartMatch() {
  if (blobA.targetHsv && blobB.targetHsv && boundary.isReady) {
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

  blobA.updatePosition(currentFrame, timestamp);
  blobB.updatePosition(currentFrame, timestamp);

  const ringOutA = ringOutWatcher.check(blobA);
  const ringOutB = ringOutWatcher.check(blobB);

  battle.update({ blobA, blobB, ringOutA, ringOutB, now: timestamp });

  renderHud(ctx, { canvas, camera, boundary, blobA, blobB, calibrationMode });

  requestAnimationFrame(loop);
}
