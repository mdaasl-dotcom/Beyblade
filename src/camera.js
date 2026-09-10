// Handles getUserMedia camera access and exposes raw pixel access via an
// offscreen processing canvas that the tracker reads from every frame.

// The <video> element is displayed with CSS `object-fit: cover`, which crops
// it to fill the screen instead of showing the full frame. grabFrame() below
// still processes the *full* native frame (uncropped), so any point given in
// on-screen coordinates has to be corrected for that crop before it lines up
// with process-canvas pixels — otherwise taps (and the drawn crosshair) drift
// away from what's actually visible whenever the camera's aspect ratio
// doesn't match the screen's, which is nearly always the case on a phone.
export function coverMapping(videoWidth, videoHeight, displayWidth, displayHeight) {
  const scale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  return {
    scale,
    offsetX: (renderedWidth - displayWidth) / 2,
    offsetY: (renderedHeight - displayHeight) / 2,
  };
}

export class CameraFeed {
  constructor(videoEl, { processWidth = 240 } = {}) {
    this.videoEl = videoEl;
    this.processWidth = processWidth;
    this.processHeight = 1;
    this.processCanvas = document.createElement("canvas");
    this.processCtx = this.processCanvas.getContext("2d", { willReadFrequently: true });
    this.stream = null;
  }

  /**
   * @param {string|null} deviceId specific camera to use (from
   *   listVideoInputs()); omit to use the browser/OS default.
   */
  async start(deviceId = null) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API not available in this browser.");
    }
    this.stop();
    const videoConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } };
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
    this.videoEl.srcObject = this.stream;
    await this.videoEl.play();
    await new Promise((resolve) => {
      if (this.videoEl.videoWidth) return resolve();
      this.videoEl.addEventListener("loadedmetadata", () => resolve(), { once: true });
    });

    const aspect = this.videoEl.videoHeight / this.videoEl.videoWidth;
    this.processHeight = Math.max(1, Math.round(this.processWidth * aspect));
    this.processCanvas.width = this.processWidth;
    this.processCanvas.height = this.processHeight;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** Lists available cameras. Device labels are only populated once camera
   *  permission has been granted at least once (a browser privacy rule), so
   *  call this after the first successful start(). Useful when more than one
   *  camera is available — e.g. a laptop's built-in webcam alongside a phone
   *  used as a webcam via an app like Camo/EpocCam/Iriun. */
  async listVideoInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  get videoWidth() {
    return this.videoEl.videoWidth;
  }

  get videoHeight() {
    return this.videoEl.videoHeight;
  }

  /** Draws the current video frame into the low-res processing canvas and
   *  returns its ImageData for the tracker to scan. */
  grabFrame() {
    this.processCtx.drawImage(this.videoEl, 0, 0, this.processWidth, this.processHeight);
    return this.processCtx.getImageData(0, 0, this.processWidth, this.processHeight);
  }

  /** Maps a point in on-screen (display) coordinates — where the video is
   *  shown cropped via object-fit:cover — to processing-canvas pixel
   *  coordinates, which represent the full uncropped native frame. */
  displayToProcess(x, y, displayWidth, displayHeight) {
    const { scale, offsetX, offsetY } = coverMapping(
      this.videoWidth, this.videoHeight, displayWidth, displayHeight
    );
    const videoX = (x + offsetX) / scale;
    const videoY = (y + offsetY) / scale;
    const procScale = this.processWidth / this.videoWidth;
    return { x: videoX * procScale, y: videoY * procScale };
  }

  /** Inverse of displayToProcess: maps a processing-canvas point back to
   *  where it should be drawn on screen given the object-fit:cover crop. */
  processToDisplay(x, y, displayWidth, displayHeight) {
    const procScale = this.processWidth / this.videoWidth;
    const videoX = x / procScale;
    const videoY = y / procScale;
    const { scale, offsetX, offsetY } = coverMapping(
      this.videoWidth, this.videoHeight, displayWidth, displayHeight
    );
    return { x: videoX * scale - offsetX, y: videoY * scale - offsetY };
  }
}
