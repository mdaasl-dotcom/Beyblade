# Spin Battle Tracker

A browser app that turns a phone's camera into an AR tracking overlay for a
**real, physical** Spin Stadium. Point your phone at your stadium and it
tracks the actual Tops spinning in it — no simulation, no toy models.

## Features

- **Spin/RPM tracking** — estimates each Top's rotation speed from the
  live video using circular cross-correlation of brightness samples around
  its rim (works best when the Top has visible color/pattern markings).
- **Position & collision tracking** — tracks each Top's position frame
  to frame and flags clashes when they collide.
- **Ring-out / stamina-out detection** — after you calibrate the stadium's
  rim, a Top that crosses out of bounds is called out (Ring-Out); one
  that spins down below a low-RPM threshold is called out (Stamina-Out).
- **Battle stats overlay** — a scoreboard HUD with editable Player names,
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

## Using it

1. **Start Camera** — grants camera access and shows the live feed.
2. **Calibrate Stadium** — tap 6-8 points around the rim of the physical
   stadium bowl in the video, then tap the button again to close the
   boundary polygon.
3. **Calibrate Player A / B** — tap directly on each physical Top in
   the video. The app samples its color there and starts tracking it.
4. **Start Match** — begins live tracking: RPM readouts, a crosshair on each
   Top, and detection of clashes, ring-outs, and stamina-outs.
5. **Reset Round** — clears the round state so you can run another one
   without recalibrating (calibration only needs to be redone if lighting
   or camera angle changes significantly).

Rename "Player A" / "Player B" by tapping their names in the top scoreboard.

## How the tracking works

- **Position**: HSV color-thresholding within a search region around the
  Top's last known position (a lightweight mean-shift-style tracker),
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
- **Stamina-out**: triggered when a Top that was spinning meaningfully
  fast drops below a low RPM threshold and stays there.

## Limitations

- RPM and position tracking are **heuristic estimates** from a single 2D
  camera feed, not a certified measurement instrument. Accuracy depends on
  lighting, camera angle, motion blur, and how visually distinct each
  Top and the stadium background are.
- Two Tops can share the same calibrated color (e.g. matching stickers) —
  the tracker falls back to position (whichever one was last seen closest)
  to tell them apart, rather than requiring distinct colors. The one edge
  case: if two identically-colored tops are actually touching/overlapping
  when tracking needs to reacquire both at once, they may briefly be read
  as one blob until they separate.
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
