# Spin Battle Tracker — Raspberry Pi kit setup

Turns a Raspberry Pi into a dedicated, offline Spin Battle Tracker
appliance: plug in power, a USB webcam, and a display — it boots straight
into a live tracking screen, no phone, no WiFi, no keyboard needed after
setup.

## What's in the kit vs. what the buyer supplies

The kit ships just the Pi (preloaded via the steps below) and the printed
card. The buyer supplies their own **stadium + tops**, **USB webcam**, and
**HDMI display** — this is a tracker add-on for a stadium they already
own (or buy separately), not a full toy set, which keeps the kit itself
cheap and lets everyone use whatever hardware they already have.

## Recommended hardware (budget build, ~$65–70 in kit parts)

- **Raspberry Pi 4, 2GB is enough.** The tracker only processes a 240px-
  wide frame in JS — it's not a demanding workload, so the cheapest Pi 4
  variant (~$45) handles it fine. Pi 5 or more RAM is a "nice to have
  more headroom" upgrade, not a requirement. A Pi Zero 2 W is NOT
  recommended — its CPU is meaningfully weaker and live tracking will lag.
- A microSD card (~16GB is plenty, ~$6) with **Raspberry Pi OS with
  Desktop** (Bookworm or newer) already flashed and booted at least once
  (so it's past first-boot setup).
- A USB-C power supply (~$8) and a basic case (~$6) round out the Pi side.

### The webcam the buyer brings

Any standard USB webcam works — the app uses the browser's standard
camera API (`getUserMedia`), which every USB webcam satisfies with zero
extra setup, same as it already works on a phone or laptop. Worth a line
on the kit card or instructions: **avoid a built-in laptop-style ribbon
camera or the Raspberry Pi Camera Module** — the Pi Camera needs an extra
`libcamera`/`v4l2loopback` driver bridge to even be visible to a browser,
which is fragile and version-dependent, and isn't set up by this script.

## One-time setup (per Pi)

1. Boot the Pi into the desktop, connect it to WiFi (only needed for this
   step — packages are installed once, then it's fully offline).
2. Plug in the USB webcam.
3. Clone or copy this repo onto the Pi, open a terminal in it, then:
   ```bash
   cd pi-kit
   chmod +x install.sh
   ./install.sh
   ```
4. `sudo reboot`. It should come up full-screen in the app, camera already
   granted (no permission prompt — kiosk Chromium auto-accepts it), ready
   for stadium calibration.

## What the script actually does

- Copies `index.html`, `css/`, and `src/` into `/opt/spin-battle-tracker`.
- Installs a tiny local web server (`http-server`) as a systemd service, so
  the app is served from `http://localhost:8080` — camera access requires
  a "secure context", and `localhost` counts as one even with no internet
  connection, which is what makes fully offline operation possible.
- Adds a desktop autostart entry that launches Chromium in kiosk mode
  (full-screen, no address bar, no other apps reachable) pointed at
  `http://localhost:8080/index.html?kiosk=1` — the `?kiosk=1` tells the
  app to skip the walkthrough and start the camera automatically instead
  of waiting for a tap.

## Updating the app on Pis already in the field

Pull the latest code, then re-run `./install.sh` — it overwrites
`/opt/spin-battle-tracker` and restarts the service. No re-flashing needed.

## Exiting kiosk mode for maintenance

`Alt+F4` closes Chromium (the local server keeps running in the
background as its own systemd service). SSH in and `pkill chromium-browser`
works the same way remotely.

## Known limitations

- This hasn't been tested on real Raspberry Pi hardware in this
  environment — verify camera access and frame rate on an actual unit
  before shipping kits with it.
- `--use-fake-ui-for-media-stream` auto-grants the camera permission
  prompt for *any* site loaded in this kiosk browser, not just this app —
  fine for a locked-down single-purpose kiosk, but don't reuse this same
  Chromium profile/flags for general browsing.
