#!/usr/bin/env bash
# Turns a fresh Raspberry Pi OS (Bookworm, with desktop) install into a
# dedicated Spin Battle Tracker appliance: copies the app onto local disk,
# serves it from localhost (works fully offline, no WiFi needed after this
# script runs), and boots straight into it full-screen with the camera
# already live — no keyboard/mouse needed after first boot.
#
# Run this ONCE, on the Pi itself, from a full desktop session:
#   cd pi-kit && chmod +x install.sh && ./install.sh
#
# Requires: Raspberry Pi OS with Desktop (Bookworm or newer), internet
# access DURING setup only (to install packages) — not needed after.

set -euo pipefail

APP_DIR="/opt/spin-battle-tracker"
SERVICE_USER="$(whoami)"
PORT=8080

echo "==> Installing dependencies (chromium, a static file server)…"
sudo apt-get update
sudo apt-get install -y --no-install-recommends chromium-browser nodejs npm

echo "==> Copying app files to $APP_DIR…"
sudo mkdir -p "$APP_DIR"
sudo cp -r ../index.html ../css ../src "$APP_DIR/"
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "==> Installing a tiny local web server (http-server)…"
sudo npm install -g http-server

echo "==> Creating the local-server systemd service…"
sudo tee /etc/systemd/system/spin-battle-tracker.service > /dev/null << EOF
[Unit]
Description=Spin Battle Tracker local server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v http-server) -p $PORT -c-1 --silent .
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now spin-battle-tracker.service

echo "==> Setting up Chromium kiosk autostart…"
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"

# --use-fake-ui-for-media-stream auto-grants the camera permission prompt
# instead of showing it (there's no visible chrome to anchor a real prompt
# to in kiosk mode anyway) — this is the standard trick for a kiosk app
# that needs real camera access with zero human interaction on boot.
# The GPU flags matter most on a Pi: they push video decode/canvas
# compositing onto the VideoCore GPU instead of the CPU, which is the
# difference between smooth and laggy live tracking on this hardware.
cat > "$AUTOSTART_DIR/spin-battle-tracker.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Spin Battle Tracker
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --disable-session-crashed-bubble --disable-translate \
  --use-fake-ui-for-media-stream \
  --enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  "http://localhost:$PORT/index.html?kiosk=1"
X-GNOME-Autostart-enabled=true
EOF

echo ""
echo "==> Done. Reboot to launch into the app full-screen:"
echo "    sudo reboot"
echo ""
echo "To update the app later, re-run this script after pulling a newer"
echo "version of the repo — it overwrites $APP_DIR and restarts the service."
echo ""
echo "To exit kiosk mode for maintenance: Alt+F4 on the Pi, or SSH in and run"
echo "    pkill chromium-browser"
echo "(the local server keeps running in the background either way — it's"
echo " a separate systemd service, restart it with:"
echo "    sudo systemctl restart spin-battle-tracker)"
