import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossSeries, downsample, extent, plotPoints, changePct, mergeLive,
} from "../src/series.js";

// A base=USD response: note there is no "USD" key in any row.
const RATES = {
  "2026-01-01": { GBP: 0.80, AUD: 1.50, JPY: 150.0 },
  "2026-01-02": { GBP: 0.75, AUD: 1.50, JPY: 160.0 },
  "2026-01-03": { GBP: 0.80, AUD: 1.60, JPY: 155.0 },
};

test("crossSeries cross-rates two non-base currencies", () => {
  const s = crossSeries(RATES, "GBP", "AUD");
  assert.deepEqual(s.map(([d]) => d), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.equal(s[0][1], 1.5 / 0.8);
  assert.equal(s[1][1], 1.5 / 0.75);
});

// Regression: the base currency is absent from each row, so a naive lookup
// yields undefined -> NaN/Infinity and paints a blank sparkline with no error.
// This is the bug that decided the Worker vs pure-Liquid question (§2.1).
test("crossSeries treats the USD base as 1 rather than undefined", () => {
  const usdJpy = crossSeries(RATES, "USD", "JPY");
  assert.equal(usdJpy.length, 3);
  assert.equal(usdJpy[0][1], 150.0);
  assert.ok(usdJpy.every(([, v]) => Number.isFinite(v)));

  const jpyUsd = crossSeries(RATES, "JPY", "USD");
  assert.equal(jpyUsd[0][1], 1 / 150.0);
  assert.ok(jpyUsd.every(([, v]) => Number.isFinite(v)));

  const usdUsd = crossSeries(RATES, "USD", "USD");
  assert.ok(usdUsd.every(([, v]) => v === 1));
});

test("crossSeries skips dates with missing or zero rates", () => {
  const gappy = {
    "2026-01-01": { GBP: 0.8, AUD: 1.5 },
    "2026-01-02": { AUD: 1.5 },          // GBP missing
    "2026-01-03": { GBP: 0, AUD: 1.5 },  // would divide by zero
    "2026-01-04": { GBP: 0.8, AUD: 1.6 },
  };
  const s = crossSeries(gappy, "GBP", "AUD");
  assert.deepEqual(s.map(([d]) => d), ["2026-01-01", "2026-01-04"]);
});

test("downsample keeps first and last, and respects the cap", () => {
  const series = Array.from({ length: 255 }, (_, i) => [`d${i}`, i]);
  const out = downsample(series, 48);
  assert.ok(out.length <= 48 + 1, `got ${out.length}`);
  assert.deepEqual(out[0], series[0]);
  assert.deepEqual(out[out.length - 1], series[254]);
  // strictly increasing in time
  const idx = out.map(([d]) => Number(d.slice(1)));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});

test("downsample is a no-op when the series already fits", () => {
  const series = [["a", 1], ["b", 2]];
  assert.equal(downsample(series, 48), series);
});

test("extent finds min and max", () => {
  assert.deepEqual(extent([["a", 3], ["b", 1], ["c", 2]]), { lo: 1, hi: 3 });
});

test("plotPoints scales into the box and orients y correctly", () => {
  const series = [["a", 1], ["b", 2], ["c", 3]];
  const pts = plotPoints(series, { w: 100, h: 30, lo: 1, hi: 3, pad: 2 });
  const xy = pts.split(" ").map((p) => p.split(",").map(Number));

  assert.equal(xy.length, 3);
  assert.equal(xy[0][0], 0);      // first x at left edge
  assert.equal(xy[2][0], 100);    // last x at right edge
  // SVG y grows downward: the lowest value sits at the BOTTOM (largest y).
  assert.equal(xy[0][1], 28);     // pad + ih - 0   = 2 + 26
  assert.equal(xy[2][1], 2);      // pad + ih - ih  = 2
  assert.equal(xy[1][1], 15);     // midpoint
});

test("plotPoints centres a flat series instead of dividing by zero", () => {
  const flat = [["a", 5], ["b", 5], ["c", 5]];
  const pts = plotPoints(flat, { w: 100, h: 30, lo: 5, hi: 5 });
  const ys = pts.split(" ").map((p) => Number(p.split(",")[1]));
  assert.ok(ys.every((y) => y === 15), pts);
  assert.ok(ys.every(Number.isFinite));
});

test("plotPoints handles a single point without NaN", () => {
  const pts = plotPoints([["a", 5]], { w: 100, h: 30, lo: 5, hi: 5 });
  assert.equal(pts, "50,15");
});

test("plotPoints returns an empty string for an empty series", () => {
  assert.equal(plotPoints([], { w: 100, h: 30, lo: 0, hi: 1 }), "");
});

test("changePct measures first to last", () => {
  assert.equal(changePct([["a", 100], ["b", 110]]), 10);
  assert.equal(changePct([["a", 100], ["b", 50]]), -50);
  assert.equal(changePct([["a", 100]]), 0);
  assert.equal(changePct([]), 0);
});

// mergeLive: the daily ECB series plus one market-rate row.
const DAILY = {
  "2026-09-24": { AUD: 1.4200, GBP: 0.7500 },
  "2026-09-25": { AUD: 1.4224, GBP: 0.7546 },
};
const LIVE = { at: "2026-09-27T19:40:12.000Z", rates: { AUD: 1.4252, GBP: 0.7556 }, reason: null };

test("mergeLive appends a live point newer than the last fixing (weekend, weekday morning)", () => {
  const { rates, applied } = mergeLive(DAILY, LIVE, ["AUD", "GBP"]);
  assert.equal(applied, true);
  assert.deepEqual(Object.keys(rates), ["2026-09-24", "2026-09-25", "2026-09-27"]);
  assert.deepEqual(rates["2026-09-27"], { AUD: 1.4252, GBP: 0.7556 });
  assert.deepEqual(DAILY["2026-09-25"], { AUD: 1.4224, GBP: 0.7546 }, "input untouched");
  assert.equal("2026-09-27" in DAILY, false, "input untouched");
});

test("mergeLive supersedes a fixing on the same date (weekday evening)", () => {
  const live = { ...LIVE, at: "2026-09-25T19:40:12.000Z" };
  const { rates, applied } = mergeLive(DAILY, live, ["AUD", "GBP"]);
  assert.equal(applied, true);
  assert.deepEqual(Object.keys(rates), ["2026-09-24", "2026-09-25"]);
  assert.deepEqual(rates["2026-09-25"], { AUD: 1.4252, GBP: 0.7556 });
});

test("mergeLive drops a live point older than the last fixing", () => {
  const live = { ...LIVE, at: "2026-09-24T19:40:12.000Z" };
  const { rates, applied } = mergeLive(DAILY, live, ["AUD", "GBP"]);
  assert.equal(applied, false);
  assert.deepEqual(rates, DAILY);
});

test("mergeLive is all or nothing: a missing symbol drops the whole point", () => {
  const { rates, applied } = mergeLive(DAILY, LIVE, ["AUD", "GBP", "JPY"]);
  assert.equal(applied, false);
  assert.deepEqual(rates, DAILY);
});

test("mergeLive with no live data returns the series unchanged", () => {
  for (const live of [null, undefined, { at: null, rates: null, reason: "HTTP 429" }]) {
    const { rates, applied } = mergeLive(DAILY, live, ["AUD", "GBP"]);
    assert.equal(applied, false);
    assert.deepEqual(rates, DAILY);
  }
});

test("mergeLive keeps only the symbols asked for in the live row", () => {
  const live = { ...LIVE, rates: { ...LIVE.rates, JPY: 157.4 } };
  const { rates } = mergeLive(DAILY, live, ["AUD", "GBP"]);
  assert.deepEqual(Object.keys(rates["2026-09-27"]), ["AUD", "GBP"]);
});

test("mergeLive onto an empty series appends", () => {
  const { rates, applied } = mergeLive({}, LIVE, ["AUD"]);
  assert.equal(applied, true);
  assert.deepEqual(rates, { "2026-09-27": { AUD: 1.4252 } });
});
