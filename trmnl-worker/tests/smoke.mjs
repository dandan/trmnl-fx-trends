// Live smoke test: runs the Worker handler against the real upstreams,
// Frankfurter and fxratesapi. The fxratesapi key is read from .dev.vars
// (FXRATES_API_KEY); without it the live checks report the fallback. The KV
// binding is an in-memory stand-in, so the run costs one fxratesapi call.
//
// Kept out of `npm test` so the unit suite stays offline and deterministic.
//   npm run smoke
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { fetchLive, SUPPORTED } from "../src/source.js";

// .dev.vars is KEY=value per line, git-ignored. wrangler reads it for `dev`;
// this reads it the same way so the smoke test needs no second config.
function devVars() {
  try {
    return Object.fromEntries(
      readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
        .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
  } catch {
    return {};
  }
}

// One value in a Map: enough to prove the cache path without a real namespace.
const memoryKv = () => {
  const store = new Map();
  return {
    async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
  };
};

const TOKEN = "smoke-token";
const ENV = { API_TOKEN: TOKEN, FXRATES_API_KEY: devVars().FXRATES_API_KEY, LIVE_CACHE: memoryKv() };
let failures = 0;

function check(label, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function call(path) {
  const req = new Request(`https://worker.test${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const t0 = performance.now();
  const res = await worker.fetch(req, ENV, {});
  const ms = performance.now() - t0;
  return { res, ms, body: JSON.parse(await res.text()) };
}

const PAIRS = "GBP/AUD,EUR/USD,GBP/USD,USD/JPY,EUR/CHF,GBP/EUR";

console.log("Live smoke test against api.frankfurter.dev and api.fxratesapi.com\n");

// The live source on its own first, so a quota or changed endpoint is named
// rather than inferred from latest_source below. This is the run's one
// fxratesapi call: the in-memory KV serves every request after it.
{
  const live = await fetchLive(ENV.FXRATES_API_KEY);
  await ENV.LIVE_CACHE.put("live", JSON.stringify({ ...live, fetched_at: new Date().toISOString() }));
  const wanted = [...SUPPORTED].filter((c) => c !== "USD");   // USD is the base, never a rate
  const missing = live.rates ? wanted.filter((c) => !(c in live.rates)) : wanted;
  check("fxratesapi answers with a rate for every supported currency",
    live.rates !== null && missing.length === 0,
    live.reason ?? (missing.length ? `missing ${missing.join(",")}` : `at=${live.at}`));
}

for (const range of ["1M", "1Y", "5Y"]) {
  const path = `/rates?pairs=${encodeURIComponent(PAIRS)}&range=${range}&w=200&h=30`;
  const { res, ms, body } = await call(path);

  const bytes = JSON.stringify(body).length;
  console.log(`${range}  ${res.status}  ${Math.round(ms)} ms  ${bytes} bytes  as_of=${body.as_of}  latest=${body.latest_source}${body.latest_at ? ` @ ${body.latest_at}` : ""}`);

  if (res.status !== 200) {
    check(`${range} returns 200`, false, body.error);
    continue;
  }

  check(`${range}: 6 rows`, body.rows.length === 6);
  check(`${range}: no NaN/Infinity/null`, !/NaN|Infinity|null/.test(JSON.stringify(body)));
  check(`${range}: payload under 12 KB`, bytes < 12000, `${bytes} bytes`);
  check(`${range}: last point is the market rate`, body.latest_source === "market",
    body.latest_source === "market" ? body.latest_at : "fell back to ECB-only");

  for (const row of body.rows) {
    const xy = row.points.split(" ").map((p) => p.split(",").map(Number));
    const inBox = xy.every(([x, y]) => x >= 0 && x <= 200 && y >= 0 && y <= 30);
    const ordered = xy.every(([x], i) => i === 0 || x >= xy[i - 1][0]);
    const sane = Number.isFinite(row.rate) && row.lo <= row.rate && row.rate <= row.hi;
    check(
      `${range} ${row.pair}`,
      inBox && ordered && sane && xy.length === row.n,
      `rate=${row.rate} chg=${row.change_pct}% lo=${row.lo} hi=${row.hi} n=${row.n}`,
    );
  }
  console.log("");
}

// Cross-check against the figure measured independently during planning.
{
  const { body } = await call("/rates?pairs=GBP%2FAUD&range=1Y");
  const row = body.rows[0];
  check(
    "GBP/AUD 1Y change matches the planning figure (~-7%)",
    Math.abs(row.change_pct - -7.24) < 3,
    `got ${row.change_pct}%`,
  );
}

// Error paths against the live upstream.
{
  const { res } = await call("/rates?pairs=GBP%2FAED");
  check("unsupported currency -> 400", res.status === 400);
}

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
