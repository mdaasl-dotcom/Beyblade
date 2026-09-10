// Optional WebXR augmented-reality layer: lets the player place a glowing
// 3D ring anchor over their physical stadium via hit-testing, purely as a
// visual "XR stage" marker. All actual tracking (position/RPM/ring-out)
// keeps running from the 2D camera pipeline in tracker.js — WebXR does not
// expose raw camera pixels on most browsers, so this module never tries to
// do computer vision itself.
//
// three.js is loaded lazily from a CDN only when the player taps "Enter AR",
// so the core app has zero external dependencies until this is used.

const THREE_URL = "https://unpkg.com/three@0.160.0/build/three.module.js";

export async function isArSupported() {
  if (!("xr" in navigator)) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

export class XrStadiumView {
  constructor() {
    this.THREE = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.reticle = null;
    this.ringAnchor = null;
    this.hitTestSource = null;
    this.session = null;
    this._localSpace = null;
    this._viewerSpace = null;
  }

  async enter(onStatus = () => {}) {
    if (!(await isArSupported())) {
      throw new Error("WebXR immersive-ar is not supported on this device/browser.");
    }
    if (!this.THREE) {
      this.THREE = await import(/* webpackIgnore: true */ THREE_URL);
    }
    const THREE = this.THREE;

    const canvas = document.createElement("canvas");
    canvas.id = "xr-canvas";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    document.getElementById("app").appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    const light = new THREE.HemisphereLight(0xffffff, 0x444466, 1.2);
    this.scene.add(light);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.18, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd23f })
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "local-floor"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: document.getElementById("app") },
    });

    this.renderer.xr.setReferenceSpaceType("local-floor");
    await this.renderer.xr.setSession(this.session);

    this._viewerSpace = await this.session.requestReferenceSpace("viewer");
    this.hitTestSource = await this.session.requestHitTestSource({ space: this._viewerSpace });
    this._localSpace = await this.session.requestReferenceSpace("local-floor");

    this.session.addEventListener("select", () => this._placeAnchor(THREE));
    this.session.addEventListener("end", () => this._cleanup());

    onStatus("AR active. Point at the stadium floor and tap to place the ring anchor.");

    this.renderer.setAnimationLoop((timestamp, frame) => this._onFrame(frame));
  }

  _onFrame(frame) {
    if (!frame || !this.hitTestSource) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const results = frame.getHitTestResults(this.hitTestSource);
    if (results.length > 0) {
      const pose = results[0].getPose(this._localSpace);
      this.reticle.visible = true;
      this.reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      this.reticle.visible = false;
    }
    this.renderer.render(this.scene, this.camera);
  }

  _placeAnchor(THREE) {
    if (!this.reticle.visible) return;
    if (this.ringAnchor) this.scene.remove(this.ringAnchor);
    const geometry = new THREE.RingGeometry(0.5, 0.55, 48).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0x29c5ff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    this.ringAnchor = new THREE.Mesh(geometry, material);
    this.ringAnchor.matrixAutoUpdate = false;
    this.ringAnchor.matrix.copy(this.reticle.matrix);
    this.scene.add(this.ringAnchor);
  }

  async exit() {
    if (this.session) await this.session.end();
  }

  _cleanup() {
    this.renderer?.setAnimationLoop(null);
    document.getElementById("xr-canvas")?.remove();
    this.hitTestSource = null;
    this.session = null;
  }
}
