// Spoken match callouts + haptics. No synthesized sound effects (tones,
// noise bursts) — just the "3, 2, 1, Go Shoot!" voice countdown via the
// browser's built-in speech synthesis, plus navigator.vibrate() feedback.

// Browsers block speech until a real user gesture unlocks it. Call
// unlockAudio() from an actual click handler (e.g. Start Camera) so voices
// are loaded and ready well before the countdown needs them.
export function unlockAudio() {
  window.speechSynthesis?.getVoices();
}

// Best-effort pick of a crisper-sounding voice. Browser TTS only ever gives
// access to whatever generic system/OS voices are installed — there's no
// way to get an actual licensed or custom character voice — but engines
// like Google's tend to read faster, punchier text more cleanly than a
// default OS voice, so prefer one of those where available.
function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang?.startsWith("en") && /google/i.test(v.name)) ||
    voices.find((v) => v.lang?.startsWith("en")) ||
    null
  );
}

function speak(text, { pitch = 1, rate = 1, volume = 1 } = {}) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel(); // don't let steps queue up and overlap
  const utter = new SpeechSynthesisUtterance(text);
  utter.pitch = pitch;
  utter.rate = rate;
  utter.volume = volume;
  const voice = pickVoice();
  if (voice) utter.voice = voice;
  window.speechSynthesis.speak(utter);
}

// Voice profile: dynamic, high-energy, sharp — quick pace throughout with a
// hard pitch jump on each step rather than a slow dramatic build, closer to
// a battle-computer callout than a lazy human count.
const COUNTDOWN_STEPS = [
  { text: "3", say: "Three", pitch: 0.9, rate: 1.15 },
  { text: "2", say: "Two", pitch: 1.0, rate: 1.25 },
  { text: "1", say: "One", pitch: 1.15, rate: 1.35 },
  { text: "GO SHOOT!", say: "Go shoot!", pitch: 1.4, rate: 1.5, phrase: true },
];
const COUNTDOWN_STEP_MS = 550;

/** Runs the "3, 2, 1, Go Shoot!" launch countdown: speaks each step and
 *  calls onStep(text, isPhrase) so the caller can display it. Resolves once
 *  it's done — callers should await it before actually starting the round. */
export function playCountdown(onStep) {
  unlockAudio();
  return new Promise((resolve) => {
    let i = 0;
    function step() {
      const s = COUNTDOWN_STEPS[i];
      onStep(s.text, !!s.phrase);
      speak(s.say, { pitch: s.pitch, rate: s.rate });
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
