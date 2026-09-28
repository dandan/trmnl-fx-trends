import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  rangeToDates, symbolUnion, buildUrl, fetchRates, fetchLive, HttpError, SUPPORTED, RANGES,
  LIVE_URL,
} from "../src/source.js";

const FXRATES = JSON.parse(
  readFileSync(new URL("./fixtures/fxratesapi-usd.json", import.meta.url)),
);
const KEY = "fxr_test_key";

test("SUPPORTED holds the 30 Frankfurter currencies", () => {
  assert.equal(SUPPORTED.size, 30);
  for (const c of ["USD", "EUR", "GBP", "AUD", "JPY", "PHP", "ZAR"]) {
    assert.ok(SUPPORTED.has(c), c);
  }
  assert.ok(!SUPPORTED.has("AED"));   // outside ECB set — see BUILD_PLAN §8.2
  assert.ok(!SUPPORTED.has("BTC"));   // no crypto
});

test("rangeToDates spans the right window and ends today", () => {
  const now = new Date("2026-08-08T12:00:00Z");
  assert.deepEqual(rangeToDates("1Y", now), { start: "2025-08-08", end: "2026-08-08" });
  assert.deepEqual(rangeToDates("1M", now), { start: "2026-07-09", end: "2026-08-08" });
  // 1826 days = 5 years including 2024's leap day.
  assert.equal(rangeToDates("5Y", now).start, "2021-08-08");
});

test("rangeToDates rejects an unknown range with a 400", () => {
  assert.throws(
    () => rangeToDates("99Y"),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test("every advertised range is usable", () => {
  const now = new Date("2026-08-08T12:00:00Z");
  for (const r of Object.keys(RANGES)) {
    const { start, end } = rangeToDates(r, now);
    assert.ok(Date.parse(start) < Date.parse(end), r);
  }
});

// The plugin renders `range_label` verbatim, so a range without one would show
// a blank window on the device. Defining both here is what prevents that.
test("every range carries days and a spelled-out label", () => {
  for (const [code, spec] of Object.entries(RANGES)) {
    assert.ok(Number.isInteger(spec.days) && spec.days > 0, `${code} days`);
    assert.match(spec.label, /^\d+ (MONTHS?|YEARS?)$/, `${code} label: ${spec.label}`);
  }
  assert.equal(RANGES["1Y"].label, "1 YEAR");
  assert.equal(RANGES["3M"].label, "3 MONTHS");
});

test("ranges are ordered and strictly increasing in length", () => {
  const days = Object.values(RANGES).map((s) => s.days);
  assert.deepEqual(days, [...days].sort((a, b) => a - b));
});

test("symbolUnion dedupes, sorts, and drops the USD base", () => {
  const pairs = [
    { from: "GBP", to: "AUD" },
    { from: "EUR", to: "USD" },
    { from: "GBP", to: "EUR" },
  ];
  assert.deepEqual(symbolUnion(pairs), ["AUD", "EUR", "GBP"]);
});

// An empty `symbols` makes Frankfurter return all 30 currencies, which would
// silently quadruple the upstream payload.
test("symbolUnion never yields an empty symbol list", () => {
  assert.deepEqual(symbolUnion([{ from: "USD", to: "USD" }]), ["EUR"]);
});

test("buildUrl targets the range endpoint with base=USD", () => {
  const url = buildUrl(["AUD", "GBP"], "2025-08-08", "2026-08-08");
  assert.ok(url.startsWith("https://api.frankfurter.dev/v1/2025-08-08..2026-08-08?"), url);
  const qs = new URL(url).searchParams;
  assert.equal(qs.get("base"), "USD");
  assert.equal(qs.get("symbols"), "AUD,GBP");
});

const okResponse = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" },
});

test("fetchRates returns the rates object and sends the edge-cache hint", async () => {
  let seen;
  const stub = async (url, opts) => {
    seen = { url, opts };
    return okResponse({ base: "USD", rates: { "2026-01-01": { GBP: 0.8 } } });
  };
  const rates = await fetchRates(["GBP"], "2025-01-01", "2026-01-01", stub);
  assert.deepEqual(rates, { "2026-01-01": { GBP: 0.8 } });
  assert.equal(seen.opts.cf.cacheTtl, 3600);
  assert.equal(seen.opts.cf.cacheEverything, true);
});

test("fetchRates maps an upstream error status to a 502", async () => {
  const stub = async () => new Response("nope", { status: 500 });
  await assert.rejects(
    () => fetchRates(["GBP"], "2025-01-01", "2026-01-01", stub),
    (e) => e instanceof HttpError && e.status === 502 && /HTTP 500/.test(e.message),
  );
});

test("fetchRates maps a network failure to a 502", async () => {
  const stub = async () => { throw new TypeError("connection refused"); };
  await assert.rejects(
    () => fetchRates(["GBP"], "2025-01-01", "2026-01-01", stub),
    (e) => e instanceof HttpError && e.status === 502 && /connection refused/.test(e.message),
  );
});

test("fetchRates rejects malformed upstream bodies", async () => {
  const bad = [
    new Response("<html>not json</html>", { status: 200 }),
    okResponse({ base: "USD" }),          // no rates
    okResponse({ base: "USD", rates: null }),
  ];
  for (const res of bad) {
    await assert.rejects(
      () => fetchRates(["GBP"], "2025-01-01", "2026-01-01", async () => res),
      (e) => e instanceof HttpError && e.status === 502,
    );
  }
});

const liveResponse = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" },
});

test("fetchLive asks for every supported currency, sends the key in a header, and stamps the response's date", async () => {
  let seen;
  const stub = async (url, opts) => {
    seen = { url: new URL(url), opts };
    return liveResponse(FXRATES);
  };
  const live = await fetchLive(KEY, stub);
  assert.equal(seen.url.origin + seen.url.pathname, LIVE_URL);
  assert.equal(seen.url.searchParams.get("base"), "USD");
  assert.equal(seen.url.searchParams.get("currencies").split(",").length, 29);
  assert.ok(!seen.url.searchParams.get("currencies").includes("USD"));
  assert.equal(seen.opts.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!seen.url.href.includes(KEY), "the key must not be in the URL");
  assert.equal(live.reason, null);
  assert.equal(live.at, FXRATES.date);
  assert.equal(Object.keys(live.rates).length, 29);
  assert.equal(live.rates.GBP, FXRATES.rates.GBP);
  for (const v of Object.values(live.rates)) assert.ok(Number.isFinite(v) && v > 0);
});

test("fetchLive is not edge-cached: the KV cache is the cache", async () => {
  let seen;
  await fetchLive(KEY, async (url, opts) => { seen = opts; return liveResponse(FXRATES); });
  assert.equal(seen.cf, undefined);
});

test("fetchLive falls back to the clock without a parseable date", async () => {
  const before = Date.now();
  const live = await fetchLive(KEY, async () => liveResponse({ ...FXRATES, date: "soon" }));
  const at = Date.parse(live.at);
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, live.at);
});

test("fetchLive without a key does not call out", async () => {
  let called = false;
  const live = await fetchLive(undefined, async () => { called = true; return liveResponse(FXRATES); });
  assert.equal(called, false);
  assert.equal(live.rates, null);
  assert.match(live.reason, /No FXRATES_API_KEY/);
});

test("fetchLive never throws: every failure is a null rates with a reason", async () => {
  const cases = [
    [async () => { throw new TypeError("connection refused"); }, /Could not reach/],
    [async () => new Response("slow down", { status: 429 }), /HTTP 429/],
    [async () => new Response("<html>", { status: 200 }), /non-JSON/],
    [async () => liveResponse({ success: true }), /no 'rates'/],
    // The monthly quota comes back as a 200 with success:false.
    [async () => liveResponse({ success: false, error: { message: "Monthly usage limit reached" } }),
      /Monthly usage limit/],
  ];
  for (const [stub, re] of cases) {
    const live = await fetchLive(KEY, stub);
    assert.equal(live.rates, null);
    assert.equal(live.at, null);
    assert.match(live.reason, re);
  }
});

test("fetchLive drops unparseable and non-positive rates", async () => {
  const body = { success: true, date: FXRATES.date, rates: { GBP: "abc", AUD: -1, EUR: 0, JPY: 157.4 } };
  const live = await fetchLive(KEY, async () => liveResponse(body));
  assert.deepEqual(live.rates, { JPY: 157.4 });
});
