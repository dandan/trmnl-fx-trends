import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sigFigs, buildRow, buildResponse } from "../src/shape.js";
import { HttpError } from "../src/source.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/frankfurter-1y.json", import.meta.url)),
);
const RATES = FIXTURE.rates;
const BOX = { w: 200, h: 30 };

test("sigFigs keeps five significant figures, as a string", () => {
  assert.equal(sigFigs(158.3412), "158.34");
  assert.equal(sigFigs(1.153512), "1.1535");
  assert.equal(sigFigs(0.93470123), "0.93470");   // not 6 figures the source lacks
  assert.equal(sigFigs(12564.07), "12564");
  assert.equal(sigFigs(0.0051823), "0.0051823");  // leading zeros are not figures
  assert.equal(sigFigs(NaN), null);
  assert.equal(sigFigs(Infinity), null);
});

// The point of the string: JSON drops the trailing zero and the cell renders a
// character short of its neighbours, which is the ragged edge this replaced.
test("sigFigs keeps trailing zeros that a JSON number would drop", () => {
  assert.equal(sigFigs(1.345), "1.3450");
  assert.equal(sigFigs(1.166), "1.1660");
  assert.equal(Number(sigFigs(1.345)), 1.345);
});

// Rounding before measuring the exponent: 999.9999 is 1000 at five figures, and
// sizing the fraction against the pre-rounded magnitude would emit six.
test("sigFigs does not emit a sixth figure at a decade boundary", () => {
  assert.equal(sigFigs(999.9999), "1000.0");
  assert.equal(sigFigs(1000), "1000.0");
});

test("buildRow produces the row shape the Liquid expects", () => {
  const row = buildRow(RATES, { from: "GBP", to: "AUD" }, BOX);
  assert.deepEqual(Object.keys(row).sort(),
    ["change_pct", "change_str", "from", "hi", "hi_str", "lo", "lo_str", "n",
     "pair", "points", "rate", "rate_str", "to"].sort());
  assert.equal(row.pair, "GBP/AUD");
  assert.equal(row.rate, 1.9104);        // matches the live 1Y figure
  assert.equal(row.rate_str, "1.9104");  // what the views actually print
  assert.equal(row.change_pct, -7.24);
  // Unsigned and always 2dp: the glyph carries the sign, and a fixed width is
  // what keeps the column aligned.
  assert.equal(row.change_str, "7.24");
  // lo/hi go through the same five-figure rounding as the rate.
  assert.equal(row.lo, 1.8634);
  assert.equal(row.hi, 2.0799);
  assert.equal(row.lo_str, "1.8634");
  assert.equal(row.hi_str, "2.0799");
  assert.ok(row.lo <= row.rate && row.rate <= row.hi);
});

test("buildRow emits a well-formed, finite points string inside the box", () => {
  const row = buildRow(RATES, { from: "GBP", to: "AUD" }, BOX);
  const xy = row.points.split(" ").map((p) => p.split(",").map(Number));
  assert.equal(xy.length, row.n);
  for (const [x, y] of xy) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `${x},${y}`);
    assert.ok(x >= 0 && x <= BOX.w, `x out of box: ${x}`);
    assert.ok(y >= 0 && y <= BOX.h, `y out of box: ${y}`);
  }
});

// The pure-Liquid prototype produced NaN/Infinity for every USD pair.
test("USD pairs produce finite output in both directions", () => {
  for (const pair of [{ from: "USD", to: "JPY" }, { from: "JPY", to: "USD" }]) {
    const row = buildRow(RATES, pair, BOX);
    assert.ok(Number.isFinite(row.rate), `${row.pair} rate=${row.rate}`);
    assert.ok(Number.isFinite(row.change_pct));
    assert.ok(!/NaN|Infinity/.test(row.points), `${row.pair}: ${row.points.slice(0, 60)}`);
  }
  assert.equal(buildRow(RATES, { from: "USD", to: "JPY" }, BOX).rate, 158.34);
});

test("an identical pair is flat rather than broken", () => {
  const row = buildRow(RATES, { from: "EUR", to: "EUR" }, BOX);
  assert.equal(row.rate, 1);
  assert.equal(row.change_pct, 0);
  assert.equal(row.change_str, "0.00");
  assert.ok(!/NaN/.test(row.points));
});

// JSON cannot carry a trailing zero, so a change of 8.4 would reach the device
// as "8.4%" and sit a character short of the "0.13%" above it. The whole point
// of the string is that every cell is the same width.
test("change_str keeps a trailing zero and never prints a sign", () => {
  for (const { from, to } of [{ from: "GBP", to: "AUD" }, { from: "AUD", to: "GBP" },
                              { from: "USD", to: "JPY" }, { from: "EUR", to: "EUR" }]) {
    const row = buildRow(RATES, { from, to }, BOX);
    assert.match(row.change_str, /^\d+\.\d{2}$/, `${row.pair}: ${row.change_str}`);
    assert.equal(Number(row.change_str), Math.abs(row.change_pct));
  }
});

test("buildRow rejects a pair with no usable data", () => {
  assert.throws(
    () => buildRow({ "2026-01-01": { GBP: 0.8 } }, { from: "GBP", to: "AUD" }, BOX),
    (e) => e instanceof HttpError && e.status === 502,
  );
});

test("buildResponse assembles rows and metadata", () => {
  const pairs = [{ from: "GBP", to: "AUD" }, { from: "USD", to: "JPY" }];
  const res = buildResponse(RATES, pairs, { range: "1Y", ...BOX });
  assert.equal(res.rows.length, 2);
  assert.equal(res.range, "1Y");
  assert.equal(res.range_label, "1 YEAR");
  assert.equal(res.as_of, "2026-08-07");   // last date in the fixture
  assert.equal(res.start_date, Object.keys(RATES)[0]);  // first date in the fixture
  assert.ok(res.start_date < res.as_of);
  assert.ok(!Number.isNaN(Date.parse(res.generated_at)));
});

test("response stays comfortably under the TRMNL payload ceiling", () => {
  const pairs = [
    ["GBP", "AUD"], ["EUR", "USD"], ["GBP", "USD"],
    ["USD", "JPY"], ["EUR", "CHF"], ["GBP", "EUR"],
  ].map(([from, to]) => ({ from, to }));
  const bytes = JSON.stringify(buildResponse(RATES, pairs, { range: "1Y", ...BOX })).length;
  assert.ok(bytes < 12000, `payload ${bytes} bytes`);
});
