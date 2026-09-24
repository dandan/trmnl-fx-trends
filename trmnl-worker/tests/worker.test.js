// End-to-end tests of the Worker handler. Node 22 provides fetch/Request/
// Response/crypto.subtle, so the module runs unmodified with a stubbed upstream
// — no wrangler or miniflare needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { HttpError, parsePairs, MAX_PAIRS } from "../src/source.js";
import { _primeCache } from "../src/allowlist.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/frankfurter-1y.json", import.meta.url)),
);

const upstream = async () => new Response(JSON.stringify(FIXTURE), {
  status: 200, headers: { "Content-Type": "application/json" },
});

function call(path, { env = {}, fetchImpl = upstream, ip = null } = {}) {
  const headers = ip ? { "CF-Connecting-IP": ip } : {};
  const req = new Request(`https://worker.test${path}`, { headers });
  return worker.fetch(req, env, {}, fetchImpl);
}

const body = async (res) => JSON.parse(await res.text());

// workerd treats every named export of the entrypoint module as a service
// entrypoint and requires each to be a function or ExportedHandler. A named
// export of any other type (e.g. `export const MAX_PAIRS = 8`) makes the
// runtime refuse to start with "Incorrect type for map entry" — and node:test
// alone will not catch it, because plain Node imports the module happily.
test("index.js exports only the default handler", async () => {
  const mod = await import("../src/index.js");
  const named = Object.keys(mod).filter((k) => k !== "default");
  assert.deepEqual(named, [], `named exports of the entrypoint break workerd: ${named.join(", ")}`);
  assert.equal(typeof mod.default.fetch, "function");
});

test("health endpoint is public and data-free", async () => {
  const res = await call("/");
  assert.equal(res.status, 200);
  const b = await body(res);
  assert.equal(b.currencies, 30);
  assert.ok(Array.isArray(b.ranges));
  assert.ok(!("rows" in b));
});

test("unknown paths 404", async () => {
  assert.equal((await call("/nope")).status, 404);
});

test("a caller outside the TRMNL IP list is refused", async () => {
  _primeCache(["78.46.130.97", "2a01:4f8:120:52b6::2"]);
  const res = await call("/rates?pairs=GBP/AUD", { ip: "1.2.3.4" });
  assert.equal(res.status, 403);
  assert.equal((await body(res)).error, "Forbidden");

  assert.equal((await call("/rates?pairs=GBP/AUD", { ip: "78.46.130.97" })).status, 200);
  assert.equal((await call("/rates?pairs=GBP/AUD", { ip: "2A01:4F8:120:52B6::2" })).status, 200);
  _primeCache(null);
});

// Installs made while the Worker still required a token keep sending it. The
// compatibility guarantee is that an unread header is inert, not rejected.
test("a leftover Authorization header from an older install is ignored", async () => {
  const req = new Request("https://worker.test/rates?pairs=GBP/AUD", {
    headers: { Authorization: "Bearer some-retired-token" },
  });
  assert.equal((await worker.fetch(req, {}, {}, upstream)).status, 200);
});

test("the health endpoint stays reachable from any IP", async () => {
  _primeCache(["78.46.130.97"]);
  assert.equal((await call("/", { ip: "1.2.3.4" })).status, 200);
  _primeCache(null);
});

test("happy path returns rows for every requested pair", async () => {
  const res = await call("/rates?pairs=GBP/AUD,USD/JPY,EUR/CHF&range=1Y&w=200&h=30");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");

  const b = await body(res);
  assert.deepEqual(b.rows.map((r) => r.pair), ["GBP/AUD", "USD/JPY", "EUR/CHF"]);
  assert.equal(b.range, "1Y");
  assert.equal(b.range_label, "1 YEAR");
  assert.equal(b.as_of, "2026-08-07");
  assert.ok(b.start_date < b.as_of, `${b.start_date} .. ${b.as_of}`);
  assert.equal(b.rows[0].rate, 1.9104);
  assert.equal(b.rows[0].change_pct, -7.24);
  assert.equal(b.rows[0].change_str, "-7.24");
});

test("no row anywhere contains NaN or Infinity", async () => {
  const res = await call("/rates?pairs=GBP/AUD,USD/JPY,JPY/USD,EUR/EUR");
  const text = JSON.stringify(await body(res));
  assert.ok(!/NaN|Infinity|null/.test(text), text.slice(0, 300));
});

test("pair order is preserved so rows match the form field", async () => {
  const res = await call("/rates?pairs=EUR/CHF,GBP/AUD,USD/JPY");
  assert.deepEqual((await body(res)).rows.map((r) => r.pair),
    ["EUR/CHF", "GBP/AUD", "USD/JPY"]);
});

test("w and h are honoured and points stay inside the box", async () => {
  const res = await call("/rates?pairs=GBP/AUD&w=120&h=40");
  const { points } = (await body(res)).rows[0];
  for (const p of points.split(" ")) {
    const [x, y] = p.split(",").map(Number);
    assert.ok(x >= 0 && x <= 120, `x=${x}`);
    assert.ok(y >= 0 && y <= 40, `y=${y}`);
  }
});

test("w and h are clamped to sane bounds", async () => {
  const res = await call("/rates?pairs=GBP/AUD&w=99999&h=-5");
  const { points } = (await body(res)).rows[0];
  const xs = points.split(" ").map((p) => Number(p.split(",")[0]));
  assert.ok(Math.max(...xs) <= 800);
});

test("input errors are 400 with a usable message", async () => {
  const cases = [
    ["/rates", /Missing required 'pairs'/],
    ["/rates?pairs=", /Missing required 'pairs'/],
    ["/rates?pairs=GBPAUD", /Malformed pair/],
    ["/rates?pairs=GBP%2F", /Malformed pair/],
    ["/rates?pairs=GBP%2FAED", /Unsupported currency 'AED'/],
    ["/rates?pairs=GBP%2FAUD&range=99Y", /Unknown range/],
  ];
  for (const [path, re] of cases) {
    const res = await call(path);
    assert.equal(res.status, 400, path);
    assert.match((await body(res)).error, re, path);
  }
});

test("more than MAX_PAIRS is rejected", async () => {
  const many = Array(MAX_PAIRS + 1).fill("GBP/AUD").join(",");
  const res = await call(`/rates?pairs=${encodeURIComponent(many)}`);
  assert.equal(res.status, 400);
  assert.match((await body(res)).error, /Too many pairs/);
});

test("an upstream failure surfaces as 502, not a partial screen", async () => {
  const res = await call("/rates?pairs=GBP/AUD", {
    fetchImpl: async () => new Response("boom", { status: 503 }),
  });
  assert.equal(res.status, 502);
  const b = await body(res);
  assert.match(b.error, /HTTP 503/);
  assert.ok(!("rows" in b));
});

test("parsePairs normalises case and whitespace", () => {
  assert.deepEqual(parsePairs(" gbp/aud , eur/usd "), [
    { from: "GBP", to: "AUD" },
    { from: "EUR", to: "USD" },
  ]);
});

test("parsePairs throws HttpError 400 on bad input", () => {
  assert.throws(() => parsePairs("GBP/AUD/EUR"),
    (e) => e instanceof HttpError && e.status === 400);
});

test("names its environment only when DEPLOY_ENV is set", async () => {
  const prod = await (await call("/rates?pairs=GBP/AUD&range=1M")).json();
  assert.equal("env" in prod, false, "production response must carry no env field");
  const qa = await (await call("/rates?pairs=GBP/AUD&range=1M", { env: { DEPLOY_ENV: "qa" } })).json();
  assert.equal(qa.env, "qa");
});
