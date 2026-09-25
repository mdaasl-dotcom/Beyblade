# Spin Battle Tracker — Raspberry Pi kit setup

Turns a Raspberry Pi into a dedicated, offline Spin Battle Tracker
appliance: plug in power, a USB webcam, and a display — it boots straight
into a live tracking screen, no phone, no WiFi, no keyboard needed after
setup.

## Recommended hardware (budget build, ~$105–120 in parts)

- **Raspberry Pi 4, 2GB is enough.** The tracker only processes a 240px-
  wide frame in JS — it's not a demanding workload, so the cheapest Pi 4
  variant (~$45) handles it fine. Pi 5 or more RAM is a "nice to have
  more headroom" upgrade, not a requirement. A Pi Zero 2 W is NOT
  recommended — its CPU is meaningfully weaker and live tracking will lag.
- **A plain, cheap USB webcam (~$10-15).** The app uses the standard
  browser camera API (`getUserMedia`), which any USB webcam satisfies with
  zero extra setup. Avoid the ribbon-cable Pi Camera Module — it needs an
  extra `libcamera`/`v4l2loopback` driver bridge to even be visible to a
  browser, and that setup is fragile and version-dependent.
- A display (HDMI monitor/TV — buyer-supplied, not part of the kit), and a
  microSD card (~16GB is plenty, ~$6) with **Raspberry Pi OS with Desktop**
  (Bookworm or newer) already flashed and booted at least once (so it's
  past first-boot setup).
- A USB-C power supply (~$8) and a basic case (~$6) round out the parts
  list.

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
