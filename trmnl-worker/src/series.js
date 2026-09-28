// Pure series maths: cross-rate, downsample, scale to an SVG box.
//
// No I/O and no Worker globals in here, so it runs anywhere and is unit-tested
// directly. Ported from the Python prototype validated against live data.

// Max points per sparkline. 48 across a ~200px box is ~4px/point, which is
// about the density a 1-bit panel can actually resolve.
export const MAX_POINTS = 48;

// Cross-rate a USD-based timeseries into from->to.
//
// The base currency is NOT a key in each row — a base=USD response has no "USD"
// field — so it has to be treated as 1. Getting this wrong is silent: nil/x
// yields 0 and x/nil yields Infinity, both of which render as a blank
// sparkline rather than an error. See BUILD_PLAN.md §2.1.
export function crossSeries(rates, from, to) {
  const out = [];
  // Object.entries preserves insertion order for non-numeric keys, and JSON
  // parsing preserves document order, so dates arrive chronologically. No sort.
  for (const [date, row] of Object.entries(rates)) {
    const rf = from === "USD" ? 1 : row?.[from];
    const rt = to === "USD" ? 1 : row?.[to];
    if (Number.isFinite(rf) && Number.isFinite(rt) && rf > 0) {
      out.push([date, rt / rf]);
    }
  }
  return out;
}

// Even-stride downsample that always keeps the first and last points, so the
// endpoints of the drawn line match the reported first/last values.
export function downsample(series, n = MAX_POINTS) {
  if (series.length <= n || n < 2) return series;
  const step = (series.length - 1) / (n - 1);
  const idx = new Set();
  for (let i = 0; i < n; i++) idx.add(Math.round(i * step));
  idx.add(series.length - 1);
  return [...idx].sort((a, b) => a - b).map((i) => series[i]);
}

export function extent(series) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, v] of series) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

const r1 = (n) => Math.round(n * 10) / 10;

// Map points into a w x h box and return the SVG `points` string.
//
// `lo`/`hi` come from the FULL series, not the downsampled one, so the y-scale
// matches the lo/hi labels shown next to the sparkline. Downsampled points are
// a subset, so they stay inside the box either way.
export function plotPoints(series, { w, h, lo, hi, pad = 2 }) {
  const n = series.length;
  if (n === 0) return "";

  const ih = h - 2 * pad;
  const span = hi - lo;
  const parts = new Array(n);

  for (let i = 0; i < n; i++) {
    const v = series[i][1];
    const x = n === 1 ? w / 2 : (i * w) / (n - 1);
    // A perfectly flat series (span 0) would divide by zero; centre it instead.
    const norm = span === 0 ? 0.5 : (v - lo) / span;
    const y = pad + ih - norm * ih;
    parts[i] = `${r1(x)},${r1(y)}`;
  }
  return parts.join(" ");
}

// Percent change across the full series, first to last.
export function changePct(series) {
  if (series.length < 2) return 0;
  const first = series[0][1];
  const last = series[series.length - 1][1];
  if (!(first > 0)) return 0;
  return ((last - first) / first) * 100;
}

// Append the live market rate to the daily series as one more row.
//
// Returns { rates, applied }: `rates` is a new object, `applied` says whether
// the live point is its last row. The point is keyed by its date, so to
// crossSeries and buildResponse it looks like any other row and nothing
// downstream changes shape. Rules (docs/build_live_rates.md §4.2):
//
//   - It supersedes a fixing on the same date. After 16:00 CET Frankfurter
//     already has today's fixing; the market rate is newer and replaces it, so
//     the last point is the market rate whenever the fetch succeeded.
//   - Older than the last fixing, it is dropped: the fixing is the better row.
//   - All or nothing. A symbol the request needs that the live response lacks
//     drops the whole point, because `as_of` is one field for the whole table
//     and rows cannot disagree about it.
export function mergeLive(rates, live, symbols) {
  const out = { ...rates };
  if (!live?.rates || !live.at) return { rates: out, applied: false };

  const date = String(live.at).slice(0, 10);
  const dates = Object.keys(rates);
  const last = dates.length ? dates[dates.length - 1] : "";
  if (date < last) return { rates: out, applied: false };

  const row = {};
  for (const code of symbols) {
    const v = live.rates[code];
    if (!(Number.isFinite(v) && v > 0)) return { rates: out, applied: false };
    row[code] = v;
  }
  out[date] = row;
  return { rates: out, applied: true };
}
