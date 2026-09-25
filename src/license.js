// Client-side license verification against Supabase (see supabase/schema.sql
// for the backend side). The anon key below is meant to be public — Supabase
// row-level security restricts it to calling exactly two controlled
// functions (claim_license, verify_license), never reading the licenses
// table directly, so exposing it here doesn't let anyone forge a key.

// TODO: fill these in from Supabase -> Project Settings -> API once the
// project exists. Nothing here works until they're set.
export const SUPABASE_URL = "TODO_SUPABASE_URL";
export const SUPABASE_ANON_KEY = "TODO_SUPABASE_ANON_KEY";

// TODO: fill in with the Stripe Payment Link once it exists, so the "Buy a
// key" link in the app's license gate actually goes somewhere.
export const PURCHASE_URL = "#";

const STORAGE_KEY = "sbt_license";

/** The license key remembered on this device, if any — set once by a
 *  successful verifyLicense() call, so a buyer only has to enter it once. */
export function getStoredLicense() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearLicense() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — private browsing / blocked storage just means it won't
    // have persisted in the first place.
  }
}

async function callRpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json();
}

/** Checks a key against the backend and, if valid, remembers it on this
 *  device so the gate doesn't reappear on future visits. Throws only on a
 *  genuine network/config problem — a wrong key just resolves to false. */
export async function verifyLicense(key) {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const valid = await callRpc("verify_license", { input_key: trimmed });
  if (valid) {
    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      // Key still works this session even if it can't be remembered.
    }
  }
  return valid;
}

/** Claims the next unused key from the pool — called once from claim.html
 *  right after a Stripe payment succeeds. */
export async function claimLicense() {
  return callRpc("claim_license", {});
}
