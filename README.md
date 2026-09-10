# Beyblade XR Stage

A browser app that turns a phone's camera into an AR tracking overlay for a
**real, physical** Beyblade Stadium. Point your phone at your stadium and it
tracks the actual Beyblades spinning in it — no simulation, no toy models.

## Features

- **Spin/RPM tracking** — estimates each Beyblade's rotation speed from the
  live video using circular cross-correlation of brightness samples around
  its rim (works best when the Beyblade has visible color/pattern markings).
- **Position & collision tracking** — tracks each Beyblade's position frame
  to frame and flags clashes when they collide.
- **Ring-out / stamina-out detection** — after you calibrate the stadium's
  rim, a Beyblade that crosses out of bounds is called out (Ring-Out); one
  that spins down below a low-RPM threshold is called out (Stamina-Out).
- **Battle stats overlay** — a scoreboard HUD with editable Blader names,
  win counts, and an event log (clashes, ring-outs, stamina-outs) updated
  live during the match.
- **Optional WebXR AR anchor** — on supported devices/browsers, "Enter AR"
  lets you place a glowing 3D ring marker over the physical stadium via
  hit-testing, as a visual XR "stage" marker. Tracking itself always runs
  from the 2D camera pipeline, not from the XR scene (see *Limitations*).

## Running it

This is a static app — no build step.

```bash
npm start
# then open the printed http://localhost:8080 URL
```

Camera access requires a **secure context**: `localhost` is fine for desktop
testing, but testing on a phone requires HTTPS (e.g. serve via `ngrok`, or
any static host with TLS) — browsers block camera access on plain HTTP for
any host other than localhost.

### Windows 11 desktop app

The app also ships as an installable Windows desktop app (via Electron), so
you can run it in its own window using your PC's webcam instead of opening a
browser tab.

Requires [Node.js](https://nodejs.org) installed on Windows first. Then, in
a terminal (PowerShell or Command Prompt) in this project folder:

```powershell
npm install
npm run electron      # launch it in a window, for quick testing
npm run dist:win      # build an installable .exe (output in dist/)
```

`npm run dist:win` produces a Windows installer under `dist/`. Run it once to
install "Beyblade XR Stage" like any other desktop app; it'll ask for webcam
permission the first time you click "Start Camera".

## Using it

1. **Start Camera** — grants camera access and shows the live feed.
2. **Calibrate Stadium** — tap 6-8 points around the rim of the physical
   stadium bowl in the video, then tap the button again to close the
   boundary polygon.
3. **Calibrate Blader A / B** — tap directly on each physical Beyblade in
   the video. The app samples its color there and starts tracking it.
4. **Start Match** — begins live tracking: RPM readouts, a crosshair on each
   Beyblade, and detection of clashes, ring-outs, and stamina-outs.
5. **Reset Round** — clears the round state so you can run another one
   without recalibrating (calibration only needs to be redone if lighting
   or camera angle changes significantly).

Rename "Blader A" / "Blader B" by tapping their names in the top scoreboard.

## How the tracking works

- **Position**: HSV color-thresholding within a search region around the
  Beyblade's last known position (a lightweight mean-shift-style tracker),
  recomputing the centroid and radius each frame from matching pixels.
- **RPM**: brightness is sampled at 24 points around a ring at ~70% of the
  tracked radius each frame. The ring signal is cross-correlated against the
  previous frame's signal to find the angular shift that best explains the
  rotation, which converts to an RPM estimate. This needs visible surface
  detail (stickers, color patterns, scratches) to work — a perfectly
  uniform, featureless top will read close to 0 RPM.
- **Ring-out**: point-in-polygon test of the tracked centroid against the
  calibrated stadium boundary, confirmed over several consecutive
  out-of-bounds frames to reject noise.
- **Stamina-out**: triggered when a Beyblade that was spinning meaningfully
  fast drops below a low RPM threshold and stays there.

## Limitations

- RPM and position tracking are **heuristic estimates** from a single 2D
  camera feed, not a certified measurement instrument. Accuracy depends on
  lighting, camera angle, motion blur, and how visually distinct each
  Beyblade and the stadium background are.
- Two Beyblades must be reasonably distinguishable by color for the tracker
  to tell them apart.
- WebXR's `immersive-ar` session does not expose raw camera pixels on most
  browsers, so the AR anchor view (`Enter AR`) is a separate, optional,
  purely decorative layer for placing a 3D marker over the stadium. It
  requires a device/browser with WebXR `immersive-ar` + `hit-test` support
  (recent Android Chrome on ARCore-capable devices); the app auto-detects
  support and hides/disables the AR button when unavailable. All actual
  tracking, RPM, and battle-stat features work without it, in any modern
  mobile browser with camera access.
- This app has not been validated on physical hardware in this environment
  (no camera/AR device available here) — test it on an actual phone with a
  real stadium before relying on it during a match.
