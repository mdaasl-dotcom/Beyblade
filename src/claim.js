import { claimLicense } from "./license.js";

const statusEl = document.getElementById("claim-status");
const keyEl = document.getElementById("claim-key");
const copyBtn = document.getElementById("claim-copy");
const openAppLink = document.getElementById("claim-open-app");

// Guards against a page refresh claiming a second key — same tab/session
// re-shows the key it already claimed instead of drawing a fresh one. (This
// doesn't stop someone opening the link in a new incognito tab to grab an
// extra key for free; that's a known gap in this first version, not worth
// the extra complexity to close until it's actually a real problem.)
const SESSION_KEY = "sbt_claimed_key";

function showKey(key) {
  statusEl.textContent = "Here's your license key — copy it and paste it into the app.";
  keyEl.textContent = key;
  keyEl.hidden = false;
  copyBtn.hidden = false;
  openAppLink.hidden = false;
}

function showError(message) {
  statusEl.textContent = `${message} If this keeps happening, get in touch and we'll sort you out manually.`;
}

async function run() {
  const already = sessionStorage.getItem(SESSION_KEY);
  if (already) {
    showKey(already);
    return;
  }
  try {
    const key = await claimLicense();
    sessionStorage.setItem(SESSION_KEY, key);
    showKey(key);
  } catch (err) {
    showError(`Couldn't get your key (${err.message}).`);
  }
}

copyBtn.addEventListener("click", () => {
  navigator.clipboard?.writeText(keyEl.textContent);
  copyBtn.textContent = "Copied!";
  setTimeout(() => {
    copyBtn.textContent = "Copy key";
  }, 1500);
});

run();
