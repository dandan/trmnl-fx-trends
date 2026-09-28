// The KV-backed lazy cache for the live rate (src/live.js).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getLive, KEY, DEFAULT_REFRESH_SECONDS, DEFAULT_EXPIRE_SECONDS, _reset } from "../src/live.js";

const FXRATES = JSON.parse(
  readFileSync(new URL("./fixtures/fxratesapi-usd.json", import.meta.url)),
);

// A KV namespace in a Map, recording puts so the TTL can be asserted on.
function fakeKv(initial = null) {
  const store = new Map();
  if (initial) store.set(KEY, JSON.stringify(initial));
  return {
    puts: [],
    gets: 0,
    async get(key, opts) {
      this.gets++;
      const v = store.get(key);
      if (v === undefined) return null;
      return opts?.type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value, opts) {
      this.puts.push({ key, value: JSON.parse(value), opts });
      store.set(key, value);
    },
  };
}

// A fetch stub that counts calls and answers with the fixture (or `res`).
function fetcher(res = null) {
  const f = async () => {
    f.calls++;
    if (res instanceof Response) return res.clone();
    return new Response(JSON.stringify(res ?? FXRATES), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  f.calls = 0;
  return f;
}

const T0 = Date.parse("2026-09-28T22:00:00Z");
const clock = (offsetMs) => () => T0 + offsetMs;
const env = (kv, extra = {}) => ({ FXRATES_API_KEY: "fxr_test_key", LIVE_CACHE: kv, ...extra });

beforeEach(() => _reset());

test("an empty store fetches, serves, and writes the value with the expiry TTL", async () => {
  const kv = fakeKv();
  const f = fetcher();
  const live = await getLive(env(kv), f, clock(0));
  assert.equal(f.calls, 1);
  assert.equal(live.cached, false);
  assert.equal(live.at, FXRATES.date);
  assert.equal(Object.keys(live.rates).length, 29);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, KEY);
  assert.equal(kv.puts[0].opts.expirationTtl, DEFAULT_EXPIRE_SECONDS);
  assert.equal(kv.puts[0].value.fetched_at, new Date(T0).toISOString());
  assert.equal(kv.puts[0].value.at, FXRATES.date);
});

test("a fresh stored value is served without a fetch", async () => {
  const kv = fakeKv();
  const f = fetcher();
  await getLive(env(kv), f, clock(0));
  const again = await getLive(env(kv), f, clock(DEFAULT_REFRESH_SECONDS * 1000 - 1));
  assert.equal(f.calls, 1);
  assert.equal(again.cached, true);
  assert.equal(again.at, FXRATES.date);
  assert.equal(again.reason, null);
});

test("a value older than the refresh interval is fetched again", async () => {
  const kv = fakeKv();
  const f = fetcher();
  await getLive(env(kv), f, clock(0));
  const again = await getLive(env(kv), f, clock(DEFAULT_REFRESH_SECONDS * 1000 + 1));
  assert.equal(f.calls, 2);
  assert.equal(again.cached, false);
  assert.equal(kv.puts.length, 2);
});

test("LIVE_REFRESH_SECONDS and LIVE_EXPIRE_SECONDS override the defaults (the QA setting)", async () => {
  const kv = fakeKv();
  const f = fetcher();
  const e = env(kv, { LIVE_REFRESH_SECONDS: "14400", LIVE_EXPIRE_SECONDS: "18000" });
  await getLive(e, f, clock(0));
  assert.equal(kv.puts[0].opts.expirationTtl, 18000);
  await getLive(e, f, clock(2 * 3600 * 1000));
  assert.equal(f.calls, 1, "two hours is still fresh on a four-hour interval");
  await getLive(e, f, clock(4 * 3600 * 1000 + 1));
  assert.equal(f.calls, 2);
});

test("a failed refetch serves the stale copy with the failure as its reason", async () => {
  const stale = { at: FXRATES.date, rates: FXRATES.rates, fetched_at: new Date(T0).toISOString() };
  const kv = fakeKv(stale);
  const f = fetcher(new Response("slow down", { status: 429 }));
  const live = await getLive(env(kv), f, clock(DEFAULT_REFRESH_SECONDS * 1000 + 1));
  assert.equal(f.calls, 1);
  assert.equal(live.cached, true);
  assert.deepEqual(live.rates, FXRATES.rates);
  assert.match(live.reason, /HTTP 429/);
  assert.equal(kv.puts.length, 0, "a failure never overwrites the stored value");
});

test("a failed fetch with nothing stored is a null rates with a reason", async () => {
  const kv = fakeKv();
  const live = await getLive(env(kv), fetcher(new Response("nope", { status: 500 })), clock(0));
  assert.equal(live.rates, null);
  assert.match(live.reason, /HTTP 500/);
  assert.equal(kv.puts.length, 0);
});

test("without a key nothing is fetched or stored", async () => {
  const kv = fakeKv();
  const f = fetcher();
  const live = await getLive({ LIVE_CACHE: kv }, f, clock(0));
  assert.equal(f.calls, 0);
  assert.equal(live.rates, null);
  assert.match(live.reason, /No FXRATES_API_KEY/);
  assert.equal(kv.puts.length, 0);
});

test("concurrent stale reads share one fetch", async () => {
  const kv = fakeKv();
  const f = fetcher();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => getLive(env(kv), f, clock(0))));
  assert.equal(f.calls, 1);
  for (const r of results) assert.equal(r.at, FXRATES.date);
});

test("a broken KV read or write degrades to a plain fetch", async () => {
  const kv = {
    async get() { throw new Error("kv down"); },
    async put() { throw new Error("kv down"); },
  };
  const f = fetcher();
  const live = await getLive(env(kv), f, clock(0));
  assert.equal(f.calls, 1);
  assert.equal(live.at, FXRATES.date);
});

test("without a binding every call fetches", async () => {
  const f = fetcher();
  await getLive({ FXRATES_API_KEY: "k" }, f, clock(0));
  await getLive({ FXRATES_API_KEY: "k" }, f, clock(0));
  assert.equal(f.calls, 2);
});
