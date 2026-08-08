// Frankfurter client: range -> date math, symbol union, one cached fetch.
//
// One request serves every pair. We always ask for base=USD and cross-rate
// locally (see series.js), so the number of upstream fetches is independent of
// how many pairs the plugin asked for.

export const API_BASE = "https://api.frankfurter.dev/v1";

// The 30 currencies Frankfurter carries (ECB reference rates). Hardcoded rather
// than fetched: it changes at most once every few years, and having it locally
// lets us reject bad input before touching the network.
export const SUPPORTED = new Set([
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD",
  "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK",
  "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

// Everything is quoted against USD, so USD itself is never a `symbols` entry.
export const BASE = "USD";

// The range vocabulary, and the only place it is defined. `label` is the
// spelled-out form the plugin shows; keeping it here means a range can never be
// added without one, which a lookup table on the display side would allow.
export const RANGES = {
  "1M": { days: 30, label: "1 MONTH" },
  "3M": { days: 91, label: "3 MONTHS" },
  "6M": { days: 182, label: "6 MONTHS" },
  "1Y": { days: 365, label: "1 YEAR" },
  "2Y": { days: 730, label: "2 YEARS" },
  "5Y": { days: 1826, label: "5 YEARS" },
};

// Cache upstream responses at the edge for 6h. ECB publishes once per weekday,
// so this is generous; Frankfurter itself sends max-age=86400.
export const UPSTREAM_CACHE_TTL = 21600;

export const MAX_PAIRS = 8;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Parse and validate the `pairs` query parameter into [{ from, to }].
//
// Lives here rather than in index.js because workerd treats every named export
// of the entrypoint module as a service entrypoint, which must be a function or
// an ExportedHandler — exporting a constant like MAX_PAIRS from index.js makes
// the runtime refuse to start.
export function parsePairs(raw) {
  if (!raw || !raw.trim()) {
    throw new HttpError(400, "Missing required 'pairs' parameter, e.g. pairs=GBP/AUD,EUR/USD");
  }
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > MAX_PAIRS) {
    throw new HttpError(400, `Too many pairs (${parts.length}); the maximum is ${MAX_PAIRS}.`);
  }

  return parts.map((p) => {
    const bits = p.split("/").map((s) => s.trim().toUpperCase());
    if (bits.length !== 2 || !bits[0] || !bits[1]) {
      throw new HttpError(400, `Malformed pair '${p}'. Expected FROM/TO, e.g. GBP/AUD.`);
    }
    for (const code of bits) {
      if (!SUPPORTED.has(code)) {
        throw new HttpError(400, `Unsupported currency '${code}'. Frankfurter carries ${SUPPORTED.size} currencies.`);
      }
    }
    return { from: bits[0], to: bits[1] };
  });
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// range -> { start, end } as YYYY-MM-DD. `end` is today; Frankfurter clamps it
// to the most recent publication, which is why the last point of the series is
// also the current rate (no separate "latest" call).
export function rangeToDates(range, now = new Date()) {
  const spec = RANGES[range];
  if (!spec) {
    throw new HttpError(400, `Unknown range '${range}'. Valid: ${Object.keys(RANGES).join(", ")}.`);
  }
  const start = new Date(now.getTime() - spec.days * 86400000);
  return { start: isoDate(start), end: isoDate(now) };
}

// The set of currencies to request: every code across all pairs, minus the base.
export function symbolUnion(pairs) {
  const syms = new Set();
  for (const { from, to } of pairs) {
    if (from !== BASE) syms.add(from);
    if (to !== BASE) syms.add(to);
  }
  // Frankfurter returns all 30 currencies when `symbols` is empty, which would
  // happen for a USD-only request like USD/USD. Ask for one cheap symbol
  // instead of accidentally pulling the full set.
  if (syms.size === 0) syms.add("EUR");
  return [...syms].sort();
}

export function buildUrl(symbols, start, end) {
  const qs = new URLSearchParams({ base: BASE, symbols: symbols.join(",") });
  return `${API_BASE}/${start}..${end}?${qs}`;
}

// Fetch the timeseries. Returns the raw `rates` object: { date: { CODE: n } }.
export async function fetchRates(symbols, start, end, fetchImpl = fetch) {
  const url = buildUrl(symbols, start, end);

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: UPSTREAM_CACHE_TTL, cacheEverything: true },
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach Frankfurter: ${err.message}`);
  }

  if (!res.ok) {
    throw new HttpError(502, `Frankfurter returned HTTP ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new HttpError(502, "Frankfurter returned a non-JSON response");
  }

  if (!body || typeof body.rates !== "object" || body.rates === null) {
    throw new HttpError(502, "Frankfurter response has no 'rates'");
  }
  return body.rates;
}
