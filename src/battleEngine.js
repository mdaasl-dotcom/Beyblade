// Match state machine: turns raw tracking data (positions, RPM, ring-out
// events) into Top battle results — collisions, stamina-out, ring-out —
// and keeps the scoreboard/event log.

export const MatchState = {
  IDLE: "idle",
  READY: "ready",
  IN_PROGRESS: "in_progress",
  ROUND_OVER: "round_over",
};

const COLLISION_COOLDOWN_MS = 600;
// A clash fires once the Tops' edges are within this real-world gap of each
// other, not only on a dead-on hit — converted to pixels per-frame via
// pixelsPerCm (derived from the calibrated stadium's known diameter), so it
// stays accurate regardless of camera zoom/distance.
const CLASH_GAP_CM = 1;
const STAMINA_OUT_RPM = 50; // below this we consider a Top to have stopped
const STAMINA_OUT_CONFIRM_MS = 1500; // must stay below threshold this long
const MIN_RPM_TO_ARM_STAMINA_CHECK = 120; // must have been spinning meaningfully first

export class BattleEngine {
  constructor({ onEvent } = {}) {
    this.state = MatchState.IDLE;
    this.wins = { a: 0, b: 0 };
    this.log = [];
    this.onEvent = onEvent || (() => {});
    this._lastCollisionAt = 0;
    this._collisionCount = 0;
    this._staminaArmed = { a: false, b: false };
    this._lowRpmSince = { a: null, b: null };
    this._roundWinner = null;
    this._roundReason = null;
  }

  reset() {
    this.state = MatchState.IDLE;
    this._lastCollisionAt = 0;
    this._collisionCount = 0;
    this._staminaArmed = { a: false, b: false };
    this._lowRpmSince = { a: null, b: null };
    this._roundWinner = null;
    this._roundReason = null;
  }

  ready() {
    this.state = MatchState.READY;
  }

  startRound() {
    this.reset();
    this.state = MatchState.IN_PROGRESS;
    this._emit("round_start", "Round started!");
  }

  _emit(type, message, extra = {}) {
    const entry = { type, message, at: Date.now(), ...extra };
    this.log.push(entry);
    if (this.log.length > 50) this.log.shift();
    this.onEvent(entry);
  }

  /** Call once per animation frame while a round is in progress.
   *  @param {number} [pixelsPerCm] derived from the calibrated stadium's
   *    known real-world diameter; without it, clash detection falls back to
   *    a plain "blobs overlapping" check. */
  update({ blobA, blobB, ringOutA, ringOutB, now, pixelsPerCm }) {
    if (this.state !== MatchState.IN_PROGRESS) return;

    if (ringOutA || ringOutB) {
      const loserIsA = ringOutA;
      this._finishRound(loserIsA ? "b" : "a", "Ring-Out");
      return;
    }

    if (blobA.isActive() && blobB.isActive()) {
      const dist = Math.hypot(blobA.centroid.x - blobB.centroid.x, blobA.centroid.y - blobB.centroid.y);
      const clashGapPx = pixelsPerCm > 0 ? CLASH_GAP_CM * pixelsPerCm : 0;
      const contactDist = pixelsPerCm > 0
        ? blobA.radius + blobB.radius + clashGapPx
        : (blobA.radius + blobB.radius) * 0.9;
      if (dist <= contactDist && now - this._lastCollisionAt > COLLISION_COOLDOWN_MS) {
        this._lastCollisionAt = now;
        this._collisionCount++;
        this._emit("collision", `Clash! (${this._collisionCount})`, { count: this._collisionCount });
      }
    }

    this._checkStamina("a", blobA, now);
    this._checkStamina("b", blobB, now);
  }

  _checkStamina(key, blob, now) {
    if (!blob.isActive()) {
      this._lowRpmSince[key] = null;
      return;
    }
    if (!this._staminaArmed[key]) {
      if (blob.rpm >= MIN_RPM_TO_ARM_STAMINA_CHECK) this._staminaArmed[key] = true;
      return;
    }
    if (blob.rpm < STAMINA_OUT_RPM) {
      if (this._lowRpmSince[key] == null) this._lowRpmSince[key] = now;
      else if (now - this._lowRpmSince[key] >= STAMINA_OUT_CONFIRM_MS) {
        const otherKey = key === "a" ? "b" : "a";
        this._finishRound(otherKey, "Stamina-Out");
      }
    } else {
      this._lowRpmSince[key] = null;
    }
  }

  _finishRound(winnerKey, reason) {
    if (this.state !== MatchState.IN_PROGRESS) return;
    this.state = MatchState.ROUND_OVER;
    this._roundWinner = winnerKey;
    this._roundReason = reason;
    this.wins[winnerKey]++;
    this._emit("round_over", `${winnerKey.toUpperCase()} wins by ${reason}!`, {
      winner: winnerKey,
      reason,
    });
  }

  get roundResult() {
    if (this.state !== MatchState.ROUND_OVER) return null;
    return { winner: this._roundWinner, reason: this._roundReason };
  }
}
