// Live smoke test: runs the Worker handler against the real Frankfurter API.
//
// Kept out of `npm test` so the unit suite stays offline and deterministic.
//   npm run smoke
import worker from "../src/index.js";

const TOKEN = "smoke-token";
const ENV = { API_TOKEN: TOKEN };
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

console.log("Live smoke test against api.frankfurter.dev\n");

for (const range of ["1M", "1Y", "5Y"]) {
  const path = `/rates?pairs=${encodeURIComponent(PAIRS)}&range=${range}&w=200&h=30`;
  const { res, ms, body } = await call(path);

  const bytes = JSON.stringify(body).length;
  console.log(`${range}  ${res.status}  ${Math.round(ms)} ms  ${bytes} bytes  as_of=${body.as_of}`);

  if (res.status !== 200) {
    check(`${range} returns 200`, false, body.error);
    continue;
  }

  check(`${range}: 6 rows`, body.rows.length === 6);
  check(`${range}: no NaN/Infinity/null`, !/NaN|Infinity|null/.test(JSON.stringify(body)));
  check(`${range}: payload under 12 KB`, bytes < 12000, `${bytes} bytes`);

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
