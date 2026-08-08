import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rangeToDates, symbolUnion, buildUrl, fetchRates, HttpError, SUPPORTED, RANGES,
} from "../src/source.js";

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
  assert.equal(seen.opts.cf.cacheTtl, 21600);
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
