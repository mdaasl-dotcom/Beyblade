// Lightweight sound effects + haptics for match events. Sounds are
// synthesized on the fly with the Web Audio API (short oscillator tones and
// filtered noise bursts) rather than loaded from audio files — keeps this a
// zero-asset, zero-dependency static app, and it's plenty for a handful of
// short game "stingers".

let ctx = null;

// Browsers block audio until a real user gesture unlocks it. Call
// unlockAudio() from an actual click handler (e.g. Start Camera) so the
// AudioContext exists and is running by the time a match event needs it.
export function unlockAudio() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();
  }
  if (ctx.state === "suspended") ctx.resume();
  // Voice lists often load asynchronously after the page loads; touching
  // getVoices() here (from this same real user gesture) kicks that off so
  // it's ready well before the countdown needs it.
  window.speechSynthesis?.getVoices();
}

function tone(startAt, { freq, freqEnd, type = "sine", attack = 0.005, decay = 0.15, peak = 0.3 }) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  const t0 = ctx.currentTime + startAt;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + attack + decay);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + attack + decay);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + attack + decay + 0.05);
}

function noiseBurst({ duration = 0.1, peak = 0.5, filterFreq = 1500 }) {
  if (!ctx) return;
  const size = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = filterFreq;
  const gain = ctx.createGain();
  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(peak, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  source.start(t0);
}

/** A sharp percussive hit — filtered noise for the "crack" plus a quick
 *  low-frequency thump underneath, for a Top-on-Top clash. */
export function playClash() {
  if (!ctx) return;
  noiseBurst({ duration: 0.08, peak: 0.5, filterFreq: 2200 });
  tone(0, { freq: 150, freqEnd: 60, type: "sine", attack: 0.002, decay: 0.1, peak: 0.4 });
}

/** A rising-then-falling "whoosh" for a Top flying out of the stadium. */
export function playRingOut() {
  if (!ctx) return;
  tone(0, { freq: 500, freqEnd: 1400, type: "sawtooth", attack: 0.03, decay: 0.08, peak: 0.15 });
  tone(0.08, { freq: 900, freqEnd: 90, type: "sawtooth", attack: 0.01, decay: 0.32, peak: 0.22 });
}

/** A slow, descending "powering down" tone for a Top spinning to a stop. */
export function playStaminaOut() {
  if (!ctx) return;
  tone(0, { freq: 280, freqEnd: 35, type: "triangle", attack: 0.02, decay: 0.6, peak: 0.25 });
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
 *  calls onStep(text, isPhrase) so the caller can display it, with a sharp
 *  synth stinger layered under the final shout. Resolves once it's done —
 *  callers should await it before actually starting the round. */
export function playCountdown(onStep) {
  unlockAudio();
  return new Promise((resolve) => {
    let i = 0;
    function step() {
      const s = COUNTDOWN_STEPS[i];
      onStep(s.text, !!s.phrase);
      speak(s.say, { pitch: s.pitch, rate: s.rate });
      if (s.phrase) {
        noiseBurst({ duration: 0.15, peak: 0.35, filterFreq: 3200 });
        tone(0, { freq: 300, freqEnd: 950, type: "square", attack: 0.01, decay: 0.22, peak: 0.22 });
      }
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
