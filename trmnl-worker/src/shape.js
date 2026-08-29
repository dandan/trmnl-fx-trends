// Response assembly: rounding rules and the row shape the Liquid consumes.

import {
  crossSeries, downsample, extent, plotPoints, changePct, MAX_POINTS,
} from "./series.js";
import { HttpError, RANGES } from "./source.js";

// The rate column shows a fixed number of SIGNIFICANT figures, not a fixed
// number of decimals, because that is what the source carries. ECB reference
// data is quoted to about five figures whatever the magnitude — JPY comes back
// as 159.68 (2dp) and CHF as 0.80426 (5dp) — so a decimals-by-magnitude rule
// either invents digits at the small end or discards them at the large end.
//
// Returned as a STRING as well as a number: JSON cannot carry a trailing zero,
// so 1.3450 would reach the device as 1.345 and render a character short of its
// neighbours. The ragged edge that produces is the whole reason this exists.
const SIG_FIGS = 5;

export function sigFigs(v, sf = SIG_FIGS) {
  if (!Number.isFinite(v)) return null;
  if (v === 0) return "0";
  // Round first, then measure: 999.9999 is 1000 at 5sf, and taking the exponent
  // before rounding would size the fraction against the pre-rounded magnitude
  // and emit six figures.
  const rounded = Number(v.toPrecision(sf));
  const exp = Math.floor(Math.log10(Math.abs(rounded)));
  const dp = Math.min(Math.max(sf - 1 - exp, 0), 20);
  return rounded.toFixed(dp);
}

// Decimals follow magnitude: 158.34 wants 2, 1.1535 wants 4, 0.934701 wants 6.
// Still used for lo/hi, which are set in smaller type beside the trace and are
// read as bounds rather than compared digit by digit.
export function sigRound(v) {
  if (!Number.isFinite(v)) return null;
  const a = Math.abs(v);
  const dp = a >= 100 ? 2 : a >= 1 ? 4 : 6;
  return Number(v.toFixed(dp));
}

const round2 = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null);

export function buildRow(rates, { from, to }, { w, h, maxPoints = MAX_POINTS }) {
  const full = crossSeries(rates, from, to);
  if (full.length === 0) {
    throw new HttpError(502, `No overlapping data for ${from}/${to}`);
  }

  const rateStr = sigFigs(full[full.length - 1][1]);
  const { lo, hi } = extent(full);
  const sampled = downsample(full, maxPoints);

  return {
    pair: `${from}/${to}`,
    from,
    to,
    rate: rateStr === null ? null : Number(rateStr),
    // Pre-formatted so the device does no rounding — see BUILD_PLAN §2.1.
    rate_str: rateStr,
    change_pct: round2(changePct(full)),
    lo: sigRound(lo),
    hi: sigRound(hi),
    points: plotPoints(sampled, { w, h, lo, hi }),
    n: sampled.length,
  };
}

export function buildResponse(rates, pairs, { range, w, h }) {
  const dates = Object.keys(rates);
  return {
    rows: pairs.map((p) => buildRow(rates, p, { w, h })),
    range,
    // Spelled-out form for the display. The window governs change_pct, the
    // sparkline and lo/hi alike, so the plugin states it once for the whole
    // table rather than labelling any single column with it.
    range_label: RANGES[range]?.label ?? range,
    as_of: dates.length ? dates[dates.length - 1] : null,
    generated_at: new Date().toISOString(),
  };
}
