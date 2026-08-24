// The IP allowlist: matching, normalisation, caching and the fail-open paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ipAllowed, normalizeIp, _primeCache } from "../src/allowlist.js";

const LIST = {
  ipv4: ["78.46.130.97", "88.198.48.93"],
  ipv6: ["2a01:4f8:120:52b6::2", "2604:a880:400:d1:0:1:705e:1001"],
};
const ok = async () => new Response(JSON.stringify({ data: LIST }), { status: 200 });
const boom = async () => { throw new Error("network down"); };

test.beforeEach(() => _primeCache(null));

test("expands IPv6 so abbreviation differences still match", () => {
  assert.equal(normalizeIp("2a01:4f8:120:52b6::2"), normalizeIp("2a01:04f8:0120:52b6:0:0:0:0002"));
  assert.equal(normalizeIp("[2a01:4f8:120:52b6::2]"), normalizeIp("2A01:4F8:120:52B6::2"));
  assert.equal(normalizeIp("78.46.130.97"), "78.46.130.97");
});

test("allows a listed IPv4 and rejects an unlisted one", async () => {
  assert.equal(await ipAllowed("78.46.130.97", ok), true);
  assert.equal(await ipAllowed("1.2.3.4", ok), false);
});

test("allows a listed IPv6 written in any abbreviation", async () => {
  assert.equal(await ipAllowed("2A01:04F8:0120:52B6:0000:0000:0000:0002", ok), true);
  assert.equal(await ipAllowed("2a01:4f8:120:52b6::3", ok), false);
});

test("fails open when the IP list cannot be fetched", async () => {
  assert.equal(await ipAllowed("1.2.3.4", boom), true);
  assert.equal(await ipAllowed("1.2.3.4", async () => new Response("nope", { status: 500 })), true);
  _primeCache(null);
  assert.equal(await ipAllowed("1.2.3.4", async () => new Response("{}", { status: 200 })), true);
});

test("treats wrangler dev's loopback origin as no origin", async () => {
  _primeCache(["78.46.130.97"]);
  assert.equal(await ipAllowed("127.0.0.1", ok), true);
  assert.equal(await ipAllowed("::1", ok), true);
});

test("fails open when there is no CF-Connecting-IP at all", async () => {
  let called = false;
  assert.equal(await ipAllowed(null, async () => { called = true; return ok(); }), true);
  assert.equal(called, false, "no origin to check means no reason to fetch the list");
});

test("keeps enforcing a stale list when a refresh fails", async () => {
  await ipAllowed("78.46.130.97", ok);
  assert.equal(await ipAllowed("1.2.3.4", boom), false, "last-known-good still applies");
});

test("fetches the list once, then serves from the module cache", async () => {
  let fetches = 0;
  const counting = async (...a) => { fetches++; return ok(...a); };
  await Promise.all(Array(5).fill(0).map(() => ipAllowed("1.2.3.4", counting)));
  await ipAllowed("78.46.130.97", counting);
  assert.equal(fetches, 1, "concurrent misses share one in-flight fetch");
});

test("re-checks a miss against a fresh list, catching a newly added TRMNL IP", async () => {
  _primeCache(["78.46.130.97"], 2 * 60 * 1000);   // yesterday's list, in effect
  const withNewIp = async () => new Response(JSON.stringify({
    data: { ipv4: ["78.46.130.97", "5.6.7.8"], ipv6: [] },
  }), { status: 200 });
  assert.equal(await ipAllowed("5.6.7.8", withNewIp), true,
    "a poller IP added since the last refresh must not 403 until the TTL expires");
});

test("a miss on a fresh list is rejected without another fetch", async () => {
  let fetches = 0;
  const counting = async (...a) => { fetches++; return ok(...a); };
  assert.equal(await ipAllowed("1.2.3.4", counting), false);
  assert.equal(await ipAllowed("1.2.3.4", counting), false);
  assert.equal(fetches, 1, "MISS_MS stops every rejected request triggering a refresh");
});

test("a re-check that fails leaves the miss rejected, not allowed", async () => {
  _primeCache(["78.46.130.97"], 2 * 60 * 1000);
  assert.equal(await ipAllowed("1.2.3.4", boom), false,
    "a usable list still says no; only having no list at all fails open");
});

test("backs off rather than refetching on every request after a failure", async () => {
  let fetches = 0;
  const failing = async () => { fetches++; throw new Error("down"); };
  for (let i = 0; i < 5; i++) await ipAllowed("1.2.3.4", failing);
  assert.equal(fetches, 1);
});
