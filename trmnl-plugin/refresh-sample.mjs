#!/usr/bin/env node
//
// Regenerate the offline preview data.
//
//   node refresh-sample.mjs [pairs] [range]
//   node refresh-sample.mjs "GBP/AUD, EUR/USD, USD/JPY" 1Y
//
// Runs the Worker's own handler against live Frankfurter data — no deployed
// Worker and no token needed — then writes sample.json and rewrites the
// `variables:` block in .trmnlp.yml so `trmnlp serve` works offline.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = (await import(join(here, "../trmnl-worker/src/index.js"))).default;

const pairs = process.argv[2] || "GBP/AUD, EUR/USD, GBP/USD, USD/JPY, EUR/CHF, GBP/EUR";
const range = process.argv[3] || "1Y";
const TOKEN = "local-sample-token";

const url = `https://local/rates?pairs=${encodeURIComponent(pairs)}&range=${range}&w=200&h=30`;
const res = await worker.fetch(
  new Request(url, { headers: { Authorization: `Bearer ${TOKEN}` } }),
  { API_TOKEN: TOKEN },
  {},
);
const body = await res.json();

if (res.status !== 200) {
  console.error(`Worker returned ${res.status}: ${body.error}`);
  process.exit(1);
}

writeFileSync(join(here, "sample.json"), JSON.stringify(body, null, 2) + "\n");

// Rewrite .trmnlp.yml. custom_fields drive the polling URL; variables are what
// the offline preview actually renders.
// Mirror EVERY top-level key the Worker returned, rather than an explicit list.
// A hand-maintained list silently omits new fields, and the preview then renders
// them blank while the tests — which read sample.json — still pass.
const vars = Object.entries(body)
  .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
  .join("\n");

const yml = `# TRMNLP config. Local preview uses the 'variables' below (offline, no token).
# Regenerate with: node refresh-sample.mjs "GBP/AUD, EUR/USD" 1Y
---
watch:
  - .trmnlp.yml
  - src

custom_fields:
  pairs: ${JSON.stringify(pairs)}
  range: ${JSON.stringify(range)}

variables:
  trmnl: {}
${vars}
`;
writeFileSync(join(here, ".trmnlp.yml"), yml);

console.log(`Wrote sample.json + .trmnlp.yml`);
console.log(`  ${body.rows.length} pairs, range ${body.range}, as_of ${body.as_of}`);
for (const r of body.rows) {
  console.log(`    ${r.pair.padEnd(9)} ${String(r.rate).padStart(10)}  ${r.change_pct > 0 ? "+" : ""}${r.change_pct}%  n=${r.n}`);
}
