// Response assembly: rounding rules and the row shape the Liquid consumes.

import {
  crossSeries, downsample, extent, plotPoints, changePct, MAX_POINTS,
} from "./series.js";
import { HttpError } from "./source.js";

// Decimals follow magnitude: 158.34 wants 2, 1.1535 wants 4, 0.934701 wants 6.
// One rule for the whole rate column, so it still aligns on tabular figures.
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

  const { lo, hi } = extent(full);
  const sampled = downsample(full, maxPoints);

  return {
    pair: `${from}/${to}`,
    from,
    to,
    rate: sigRound(full[full.length - 1][1]),
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
    as_of: dates.length ? dates[dates.length - 1] : null,
    generated_at: new Date().toISOString(),
  };
}
