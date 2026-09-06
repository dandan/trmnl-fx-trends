// Response assembly: rounding rules and the row shape the Liquid consumes.

import {
  crossSeries, downsample, extent, plotPoints, changePct, MAX_POINTS,
} from "./series.js";
import { HttpError, RANGES } from "./source.js";

// Every displayed figure — the rate and both bounds — carries a fixed number of
// SIGNIFICANT figures rather than a fixed number of decimals, because that is
// what the source carries. ECB reference data is quoted to about five figures
// whatever the magnitude (JPY comes back as 159.68, CHF as 0.80426), so a
// decimals-by-magnitude rule invents digits at the small end and discards them
// at the large end.
//
// Each is returned as a STRING as well as a number: JSON cannot carry a
// trailing zero, so 1.3450 would reach the device as 1.345 and render a
// character short of its neighbours. That ragged edge is why this exists.
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

const round2 = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null);

// The change is the one figure quoted in fixed DECIMALS rather than significant
// figures: it is a percentage, so its magnitude carries no information about the
// precision available — 8.4% and 0.13% are both good to the same 2dp. Fixing the
// decimals is what lets the column line up, since JSON would otherwise drop the
// trailing zero and print 8.4% a character short of 0.13%.
//
// Unsigned, because the row states direction with a glyph beside it (and for a
// change that rounds to zero, with no glyph at all). Math.abs also folds -0 in,
// so a hair-negative move cannot reach the panel as "-0.00%".
const changeStr = (v) => (v === null ? null : Math.abs(v).toFixed(2));

export function buildRow(rates, { from, to }, { w, h, maxPoints = MAX_POINTS }) {
  const full = crossSeries(rates, from, to);
  if (full.length === 0) {
    throw new HttpError(502, `No overlapping data for ${from}/${to}`);
  }

  const rateStr = sigFigs(full[full.length - 1][1]);
  // plotPoints scales against the UNROUNDED extent: rounding the bounds first
  // would move the trace by a fraction of a pixel for no gain.
  const { lo, hi } = extent(full);
  const loStr = sigFigs(lo);
  const hiStr = sigFigs(hi);
  const sampled = downsample(full, maxPoints);
  const change = round2(changePct(full));

  return {
    pair: `${from}/${to}`,
    from,
    to,
    rate: rateStr === null ? null : Number(rateStr),
    // Pre-formatted so the device does no rounding — see BUILD_PLAN §2.1.
    rate_str: rateStr,
    change_pct: change,
    // Pre-formatted for the same reason as rate_str above.
    change_str: changeStr(change),
    lo: loStr === null ? null : Number(loStr),
    hi: hiStr === null ? null : Number(hiStr),
    lo_str: loStr,
    hi_str: hiStr,
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
    // The window the data actually covers, first business day to last. The
    // requested range is a calendar span, but ECB publishes weekdays only, so
    // the first date returned is not `today minus 365` — quoting the real
    // endpoints is what makes the footer agree with the trace above it.
    start_date: dates.length ? dates[0] : null,
    as_of: dates.length ? dates[dates.length - 1] : null,
    generated_at: new Date().toISOString(),
  };
}
