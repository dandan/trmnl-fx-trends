// Network-origin check: is this request coming from a TRMNL core server?
//
// TRMNL does not sign its polling requests — no HMAC, no mTLS, no token of its
// own — so source IP is the only thing about a poll that cannot be forged. The
// published list at https://trmnl.com/api/ips is the whole of the available
// evidence. It proves "some TRMNL server", not "this user's plugin", so it sits
// a coarse filter rather than per-tenant authentication — and, since there is no
// bearer token any more, the only guard on /rates. See BUILD_PLAN.md §4.3.
//
// FAIL OPEN, deliberately: if the list cannot be fetched we allow the request.
// The payload is public exchange-rate data, and a TRMNL outage that also blanked
// the screen would be a worse failure than briefly serving an unknown caller.

const IPS_URL = "https://trmnl.com/api/ips";
const TTL_MS = 24 * 60 * 60 * 1000;   // refresh the list daily
const RETRY_MS = 60 * 1000;           // after a failure, don't hammer the API
const MISS_MS = 60 * 1000;            // floor on re-checking a miss against a fresh list

// Module globals live as long as the isolate (minutes to hours across many
// requests), so this collapses nearly every repeat fetch on its own. The
// `cf.cacheTtl` below is a second line of defence and is reportedly a no-op on
// workers.dev subdomains, which is exactly why the memo is not optional.
let cache = { at: 0, ips: null };
let inflight = null;
let nextAttempt = 0;

// Expand an IPv6 address to its full eight-group form so that string equality
// is address equality: `2a01:4f8:120:52b6::2` and the form Cloudflare puts in
// CF-Connecting-IP must compare equal whichever way each side abbreviates.
function expandIpv6(addr) {
  let str = addr;

  // ::ffff:1.2.3.4 -> ::ffff:0102:0304
  const v4 = str.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.every((n) => n <= 255)) {
      str = str.slice(0, -v4[1].length)
        + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
    }
  }

  const parts = str.split("::");
  if (parts.length > 2) return str;                     // malformed; never matches
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return str;

  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return str;
  return groups.map((g) => (g || "0").padStart(4, "0")).join(":");
}

export function normalizeIp(ip) {
  const s = String(ip).trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  return s.includes(":") ? expandIpv6(s) : s;
}

async function refresh(fetchImpl) {
  try {
    const res = await fetchImpl(IPS_URL, { cf: { cacheTtl: TTL_MS / 1000 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json();
    const ips = new Set([...(data?.ipv4 ?? []), ...(data?.ipv6 ?? [])].map(normalizeIp));
    if (ips.size === 0) throw new Error("empty IP list");
    cache = { at: Date.now(), ips };
    nextAttempt = 0;
    return ips;
  } catch {
    // Keep serving the last-known-good list past its TTL rather than falling
    // open the moment a refresh fails; only a cold isolate returns null here.
    nextAttempt = Date.now() + RETRY_MS;
    return cache.ips;
  }
}

// One refresh at a time per isolate, however many requests are waiting on it.
function sharedRefresh(fetchImpl) {
  if (!inflight) inflight = refresh(fetchImpl).finally(() => { inflight = null; });
  return inflight;
}

async function trmnlIps(fetchImpl) {
  const now = Date.now();
  if (cache.ips && now - cache.at < TTL_MS) return cache.ips;
  if (now < nextAttempt) return cache.ips;
  return sharedRefresh(fetchImpl);
}

// `wrangler dev` sets CF-Connecting-IP itself, to loopback. Cloudflare never
// does, so treating loopback as "no origin" keeps local dev usable without
// widening anything in production.
const LOOPBACK = new Set(["127.0.0.1", normalizeIp("::1")]);

// True when the request may proceed. Unknown origin (no CF-Connecting-IP, or a
// loopback one from `wrangler dev`) and an unavailable list both allow.
export async function ipAllowed(ip, fetchImpl = fetch) {
  if (!ip || LOOPBACK.has(normalizeIp(ip))) return true;
  const key = normalizeIp(ip);

  const ips = await trmnlIps(fetchImpl);
  if (!ips) return true;
  if (ips.has(key)) return true;

  // A miss may only mean the list has moved on: TRMNL adding a poller IP would
  // otherwise 403 every poll until the TTL expired, blanking the device for up
  // to a day with nothing to explain it — the failure the fail-open exists to
  // prevent, arriving by another route. Re-check once against a fresh copy.
  // MISS_MS and the failure backoff together cap this at one fetch per minute
  // however many rejected requests arrive.
  const now = Date.now();
  if (now - cache.at < MISS_MS || now < nextAttempt) return false;
  const fresh = await sharedRefresh(fetchImpl);
  return fresh ? fresh.has(key) : true;
}

// Test-only: seed or clear the module cache so tests need no network. `ageMs`
// backdates the seeded list, to exercise the re-check-on-miss path.
export function _primeCache(list, ageMs = 0) {
  cache = list
    ? { at: Date.now() - ageMs, ips: new Set(list.map(normalizeIp)) }
    : { at: 0, ips: null };
  inflight = null;
  nextAttempt = 0;
}
