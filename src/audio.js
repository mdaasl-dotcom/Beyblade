// Haptics + the "3, 2, 1, Go Shoot!" launch countdown timing. No sound at
// all — no synthesized effects, no speech — the countdown is silent and
// purely visual (see the onStep callback in main.js's runCountdown()).

const COUNTDOWN_STEPS = ["3", "2", "1", "GO SHOOT!"];
const COUNTDOWN_STEP_MS = 550;

/** Runs the "3, 2, 1, Go Shoot!" launch countdown: calls onStep(text,
 *  isPhrase) on a fixed interval so the caller can display each step.
 *  Resolves once it's done — callers should await it before actually
 *  starting the round. */
export function playCountdown(onStep) {
  return new Promise((resolve) => {
    let i = 0;
    function step() {
      const text = COUNTDOWN_STEPS[i];
      onStep(text, text === "GO SHOOT!");
      i++;
      if (i < COUNTDOWN_STEPS.length) setTimeout(step, COUNTDOWN_STEP_MS);
      else setTimeout(resolve, COUNTDOWN_STEP_MS);
    }
    step();
  });
}

/** Wraps navigator.vibrate — unsupported (notably iOS Safari) or blocked
 *  calls just silently no-op rather than throwing. */
export function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Ignore — haptics are a nice-to-have, never worth surfacing an error.
  }
}
