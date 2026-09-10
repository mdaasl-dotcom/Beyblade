// Handles getUserMedia camera access and exposes raw pixel access via an
// offscreen processing canvas that the tracker reads from every frame.

export class CameraFeed {
  constructor(videoEl, { processWidth = 240 } = {}) {
    this.videoEl = videoEl;
    this.processWidth = processWidth;
    this.processHeight = 1;
    this.processCanvas = document.createElement("canvas");
    this.processCtx = this.processCanvas.getContext("2d", { willReadFrequently: true });
    this.stream = null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API not available in this browser.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
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

  /** Maps a point in full-resolution overlay-canvas space (matching the
   *  video's displayed size) to processing-canvas pixel coordinates. */
  displayToProcess(x, y, displayWidth, displayHeight) {
    return {
      x: (x / displayWidth) * this.processWidth,
      y: (y / displayHeight) * this.processHeight,
    };
  }

  processToDisplay(x, y, displayWidth, displayHeight) {
    return {
      x: (x / this.processWidth) * displayWidth,
      y: (y / this.processHeight) * displayHeight,
    };
  }
}
