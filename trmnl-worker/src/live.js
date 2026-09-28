// The live rate's cache: one KV value, refreshed lazily on the request path.
//
// fxratesapi's free plan is 1,000 calls a month. Cloudflare's edge cache is
// per data centre and cannot be counted, so the value lives in KV instead,
// where one fetch serves every colo and the spend is bounded by the clock:
// a poll that finds the value older than REFRESH fetches once and writes it
// back, and nothing else fetches until that copy ages out. At most 24 a day
// on the hourly default. See docs/build_live_rates.md §4.5.
//
// Two ages, not one. Past REFRESH the value is refetched; past EXPIRE (the
// KV TTL) it is gone. Between the two, a failed refetch serves the stale copy
// rather than dropping to ECB-only over a single bad call. The footer prints
// the value's own timestamp, so staleness within that window is visible.

import { fetchLive } from "./source.js";

export const KEY = "live";
export const DEFAULT_REFRESH_SECONDS = 3600;
export const DEFAULT_EXPIRE_SECONDS = 7200;

// One fetch per isolate at a time, however many requests found the value
// stale together. KV is eventually consistent (about a minute), so a second
// isolate may fetch too; that is the bound, not the norm.
let inflight = null;

function seconds(value, def) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Returns { at, rates, reason, cached } — the same shape fetchLive returns,
// plus whether it came from KV. `rates` is null when there is nothing to show.
export async function getLive(env, fetchImpl = fetch, now = Date.now) {
  const kv = env?.LIVE_CACHE;
  const refreshMs = seconds(env?.LIVE_REFRESH_SECONDS, DEFAULT_REFRESH_SECONDS) * 1000;
  const expire = seconds(env?.LIVE_EXPIRE_SECONDS, DEFAULT_EXPIRE_SECONDS);

  // No binding (a unit test, or a dev setup without one): fetch every time.
  if (!kv) return { ...(await fetchLive(env?.FXRATES_API_KEY, fetchImpl)), cached: false };

  let stored = null;
  try {
    stored = await kv.get(KEY, { type: "json" });
  } catch {
    stored = null;
  }
  if (stored?.rates && now() - Date.parse(stored.fetched_at) < refreshMs) {
    return { at: stored.at, rates: stored.rates, reason: null, cached: true };
  }

  if (!inflight) {
    inflight = fetchLive(env?.FXRATES_API_KEY, fetchImpl).finally(() => { inflight = null; });
  }
  const fresh = await inflight;

  if (fresh.rates) {
    const value = { at: fresh.at, rates: fresh.rates, fetched_at: new Date(now()).toISOString() };
    try {
      await kv.put(KEY, JSON.stringify(value), { expirationTtl: expire });
    } catch {
      // A failed write costs the next poll a fetch, nothing more.
    }
    return { ...fresh, cached: false };
  }

  // The refetch failed; the stale copy is better than nothing while KV still
  // holds it. The reason names the failure for the smoke test and the logs.
  if (stored?.rates) {
    return { at: stored.at, rates: stored.rates, reason: fresh.reason, cached: true };
  }
  return { ...fresh, cached: false };
}

// Test-only: forget an in-flight fetch between tests.
export function _reset() {
  inflight = null;
}
