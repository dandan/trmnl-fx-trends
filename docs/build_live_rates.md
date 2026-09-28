# Build plan — the latest market rate

Today the newest figure on the panel is the ECB's most recent daily fixing:
usually yesterday's, and Friday's all weekend. This adds one more point to the
end of every series, a market rate refreshed hourly, so LATEST is the latest
rate available rather than the latest fixing.

Status: built 2026-09-28 on branch `worker/live-rate`; §7 steps 1–4 are done,
QA and promotion remain. The source changed once during the build (§3.1), and
the Worker gained its first piece of state (§4.5); both are recorded here.

---

## 1. Where the lag comes from

Three things, and only the first is worth new code.

| Cause | Size | Fix |
|---|---|---|
| ECB fixes at 14:15 CET and publishes about 16:00 CET, once per working day | hours on a weekday, Friday-to-Monday at the weekend | a second source: this plan |
| The Worker cached Frankfurter for 6h, then its own response for 1h, and TRMNL polls hourly | up to 7h on top of the above | `UPSTREAM_CACHE_TTL` down to 1h (§4.4) |
| FX markets close Friday 22:00 UTC and reopen Sunday 22:00 UTC | inherent | none; a Saturday rate is Friday's close, whichever source quotes it |

So "several days old at the weekend" is mostly real: the second source only
adds Friday afternoon's move on top of the Friday fixing, and Sunday evening's
open before Monday's fixing arrives.

## 2. Decisions

Taken 2026-09-27 and 28.

- **The live point joins the series.** It is the last point of every row, so
  LATEST, the change, hi/lo and the sparkline's dot all agree with each other,
  as they do today. The final segment of each trace joins an ECB fixing to a
  market rate, a step of well under 1%; a headline-only design would have kept
  the series pure but put the dot somewhere other than LATEST.
- **The footer shows the live point's date and time, in UTC.** `27 Sep 2026
  19:40 UTC`. The time says it is a snapshot rather than a fixing, and explains
  a Sunday date when the markets are closed. Local time is not attempted
  (§9).
- **The narrow views drop the start date to make room.** On the device the
  bare range `26 Sep 2025 – 27 Sep 2026` already fills the quadrant's and
  half vertical's 400px beside the title, so with a time to show they print
  `27 Sep 2026 22:18 UTC` alone. The column header already names the window.
  Without a live point they print the range, as before.
- **One live source, then ECB-only.** When it fails, is out of quota or is
  down, the response is exactly what the Worker sent before. No second live
  source.
- **No setting.** Every installer gets the live point. One code path, and the
  form has no field that would need explaining.
- **The live value is cached in KV, lazily, refetched after an hour and
  expiring after two.** §4.5 has the reasoning. Chosen over a cron trigger for
  simplicity: no scheduled handler, no second code path, and the spend is
  bounded by the clock either way.

## 3. The source: fxratesapi

`GET https://api.fxratesapi.com/latest?base=USD&currencies=AUD,…,ZAR`
with `Authorization: Bearer <key>`.

- Mid-market rates aggregated from many sources, 185 currencies, all 29 the
  plugin needs against USD in one call. USD base is what the Worker already
  cross-rates from, so `crossSeries` needs no change.
- **Free plan:** 1,000 requests a month, 60 an hour, hourly updates, any base
  currency, no card. The account is free and the key is a Worker secret;
  installers of the recipe need nothing.
- **Licence** (Terms of Use & API License Agreement, Saritra GmbH, v1.0 of
  2022-11-28): the licensee is "permitted to receive, process, and display
  fxRatesAPI API Data & Services to individual end-users of your
  application(s), provided such end users use [it] strictly for their own
  personal use". That is a panel on a wall. Attribution "would be highly
  appreciated" but is not required; the bio links the site. The terms
  require every call to carry the issued credentials, so the Worker sends the
  key even though the endpoint answered without one when probed.
- The response's own `date` is the time the rates are good for, and is what
  the footer prints. A quota overrun comes back as a 200 with
  `success: false`; the parser treats that as a failure like any other.

### 3.1 Why not Coinbase

The first build used Coinbase's keyless App API endpoint
(`/v2/exchange-rates`): no account, all 30 currencies, live. Its [Market Data
Terms of Use](https://www.coinbase.com/legal/market_data) (2026-08-07) define
Market Data as "all data made available to you by Coinbase", license it
"exclusively for you or your entity's personal or research purposes", forbid
building "an application intended for use by end users other than for you",
and forbid redistributing or displaying it "to any third party outside of your
organization". A private plugin on one's own device would be fine; a published
recipe is exactly what those clauses forbid. The docs page for the endpoint
never links those terms, and whether they were meant to reach a keyless fiat
feed is arguable, but the definition is broad enough not to ship on. Swapped
2026-09-28; the merge, response fields and plugin work were untouched.

## 4. Worker

### 4.1 Fetch

`fetchLive(apiKey, fetchImpl)` in `source.js`, beside `fetchRates`:

- Asks for every supported currency, not just this request's, so the stored
  value (§4.5) serves every later request.
- Returns `{ at, rates, reason }`: `at` an ISO timestamp from the response's
  `date` (the clock if absent), `rates` a `{ CODE: number }` map with
  non-positive and non-finite values dropped, `reason` null.
- Never throws. Any failure, including a non-JSON body, a missing `rates`, or
  `success: false`, returns `rates: null` with `reason` saying why. Without a
  key it returns that reason without calling out. The request path reads only
  `rates`; the smoke test prints the reason.
- Not edge-cached. The KV value is the cache; two caches with different ages
  would make the footer's time hard to reason about.

### 4.2 Merge

`mergeLive(rates, live, symbols)` in `series.js`, pure and unit-tested. It
returns `{ rates, applied }`: a new rates object with at most one extra row,
and whether the live point is its last row.

- **Key by date.** The live point's key is `at` truncated to `YYYY-MM-DD`, so
  it looks to `crossSeries` and `buildResponse` like any other row and nothing
  downstream changes shape.
- **It supersedes the same date.** On a weekday after 16:00 CET Frankfurter
  already has today's fixing; the market rate is newer, and replaces it. So
  the last point of every series is the market rate whenever a live value was
  available, and the ECB series is intact behind it.
- **Newer only.** A live `at` older than the last Frankfurter date is dropped.
  It cannot happen with a working source, and if it did the ECB row is the
  better one.
- **All or nothing.** If any symbol the request needs is missing from the live
  value, the whole point is dropped rather than appended for some pairs.
  Otherwise rows would disagree about `as_of`, which is one field for the
  whole table.

Cases the tests cover: weekday morning (live is a new date, appended);
weekday evening (same date, replaced); weekend (Friday fixing, Sunday live,
appended); live missing a symbol (dropped); live `null` (identical output to
before).

### 4.3 Response

The additive rule (`build_multi_deploy.md` §5) applies: new fields only.

| Field | Before | After |
|---|---|---|
| `as_of` | last fixing date | unchanged meaning: the last point's date, `YYYY-MM-DD`. Becomes today's date when the live point landed |
| `latest_at` | absent | ISO timestamp of the live point, only when it is the last point |
| `latest_source` | absent | `"market"` or `"ecb"` |
| `rows[].rate` and the rest | | unchanged shape |

An old template reading only `as_of` shows the live date with no time. That
is the right degradation.

The health endpoint at `/` lists both sources.

### 4.4 Frankfurter cache

`UPSTREAM_CACHE_TTL` from 21600 to 3600. It was sized for a source that moves
once a day; now the end of the series moves hourly, and a fixing published at
16:00 CET should not wait until the six-hour copy expires. Frankfurter's own
`max-age=86400` is irrelevant to this, since `cf.cacheTtl` overrides it.

### 4.5 The live value lives in KV

`getLive(env, fetchImpl, now)` in `live.js`, which `handleRates` calls in
parallel with `fetchRates`.

**Why not the edge cache.** 1,000 calls a month is 24 a day with an hour's
freshness, but Cloudflare's cache is per data centre: a second colo doubles
the spend and there is no way to count it. KV is global, so one write serves
every colo, and the free tier (100,000 reads and 1,000 writes a day) is far
above one read per poll and 24 writes.

**Why lazy, not cron.** A cron handler would pin the spend at exactly 24 a
day with no dependence on traffic, but it is a second entry point with its
own failure mode, a first-deploy gap until its first run, and a scheduled
fetch whether anyone is polling or not. The lazy path bounds the spend the
same way — after a successful fetch nothing refetches until the copy is an
hour old — and reuses the request path's error handling.

**The rule.** Read `live` from the `LIVE_CACHE` namespace.

- Stored and fetched less than `LIVE_REFRESH_SECONDS` (3600) ago: serve it.
- Otherwise fetch. On success, serve and write back with an
  `expirationTtl` of `LIVE_EXPIRE_SECONDS` (7200).
- On failure, serve the stored copy if KV still has one, with the failure as
  the reason for the logs; otherwise `rates: null` and the response is
  ECB-only. A failure never overwrites the stored value.

Two ages, not one: between the refresh age and the expiry a single bad call
does not cost the live point. The footer prints the value's own timestamp,
so staleness within that window is visible on the panel.

**Stampede.** A module-global in-flight promise means concurrent stale reads
in one isolate share one fetch. KV is eventually consistent (about a minute),
so two isolates can still fetch once each at the same moment; that is the
bound, not the norm, and it is why the spend is "at most" 24 a day.

**Degradation.** A broken KV read or write falls through to a plain fetch;
no binding at all (a unit test) fetches every time; no key never calls out.

**Two environments.** `wrangler.toml` binds `LIVE_CACHE` at the top level and
again under `[[env.qa.kv_namespaces]]`, since environments inherit vars but
not bindings, and the two Workers must never serve each other's value. The
key is a secret per environment (`wrangler secret put FXRATES_API_KEY
[--env qa]`) and, for `wrangler dev`, the smoke test and the sample
refresher, a line in the git-ignored `.dev.vars`.

**Quota across environments.** The QA device polls hourly too, so QA would
spend as much as production. Rather than a second account, QA sets
`LIVE_REFRESH_SECONDS = "14400"`: 180 a month beside production's 720, under
one free plan's 1,000 with room for smoke tests. Production and QA hold
separate keys anyway, so a paid plan for one need not cover the other.

### 4.6 Tests

- `source.test.js`: `fetchLive` asks for every currency, sends the key in a
  header and never in the URL, stamps the response's `date`, is not
  edge-cached; returns `null` rates with a reason on a network error, a 429, a
  non-JSON body, a body without `rates`, a `success: false` quota message, and
  without a key (and then does not call out).
- `live.test.js`: against a Map standing in for KV and a fixed clock — empty
  store fetches and writes with the TTL; fresh serves without a fetch; stale
  refetches; the QA override; failed refetch serves the stale copy and never
  overwrites; failure with nothing stored; no key; five concurrent stale reads
  share one fetch; a broken KV degrades to a fetch; no binding fetches every
  time.
- `series.test.js`: the merge cases in §4.2.
- `worker.test.js`: the stub routes by host. A live 429 produces a body
  deep-equal to the pre-change body. A live 200 sets `latest_source`,
  `latest_at` and `as_of` and moves every row's `rate` to the live
  cross-rate. Without a key fxratesapi is never called.
- `smoke.mjs`: reads the key from `.dev.vars` and uses an in-memory KV, so a
  run costs one fxratesapi call; prints `latest_source` and `latest_at`.
- A fixture `tests/fixtures/fxratesapi-usd.json` from a live response.

## 5. Plugin

- `shared.liquid`: `fx_dates` appends the time when `latest_at` is present:
  `5 Sep – 27 Sep 2026 19:40 UTC`. Liquid's `date` filter formats an ISO
  string directly; `%H:%M`. The wide views' source credit after the dates
  becomes `· ECB · fxratesapi` when `latest_source` is `market`, so the panel
  says where its last point came from; the narrow views carry no credit, as
  before, and take `fx_dates_short` (§2). Nothing else on the panel changes.
  The column is still headed LATEST (BUILD_PLAN §6.3), and now means it more.
- `refresh-sample.mjs` runs the real handler with the key from the Worker's
  `.dev.vars` and an in-memory KV, so `sample.json` and the `.trmnlp.yml`
  variables carry a market point. `test-render.rb` then renders the footer
  with a time, and the ECB-only and older-Worker states without one.
- `settings.yml` author bio and the README: "Daily rates from the European
  Central Bank via Frankfurter, and the latest market rate from fxratesapi",
  with the link the licence asks for.

## 6. Documentation

- README "What it shows": the paragraph that said the newest figure is
  usually yesterday's is rewritten, and the data-source table gains a row.
- `BUILD_PLAN.md` §1 (the "no separate latest call" note), §2 (the stateless
  rule, relaxed for one value), §6.4 (refresh interval) and the §7 risks
  table.
- `build_multi_deploy.md` §3: environments now have a binding and a secret
  each.
- Worker README: the response fields, the cache, the secret. `deploy.sh` and
  `wrangler.toml` comments likewise.

## 7. Steps

1. **Worker** — `fetchLive`, `mergeLive`, `getLive`, the wiring in
   `handleRates`, the TTL change, fixture and tests. `npm test`, then
   `npm run smoke`. *Done.*
2. **Account** — sign up, `wrangler kv namespace create LIVE_CACHE` (and
   `--env qa`), the IDs into `wrangler.toml`, `wrangler secret put
   FXRATES_API_KEY --env qa`, the key into `.dev.vars`. *Done for QA;
   production's secret is set with its own key before step 6.*
3. **Sample** — `node refresh-sample.mjs`; check `latest_source` is `market`
   and that `test-render.rb` passes. *Done.*
4. **Plugin** — the footer time in `shared.liquid`; `trmnlp build` and
   headless screenshots of all four layouts; the bio. *Done.*
5. **QA** — `trmnl-worker/deploy.sh qa`, `trmnl-plugin/deploy.sh qa --force`.
   Watch one weekday evening and one weekend refresh on the device: the
   footer should show a time and today's date; `wrangler tail --env qa`
   should show no live-fetch fallback. `wrangler kv key get live
   --binding LIVE_CACHE --env qa` shows the stored value and its
   `fetched_at`.
6. **Production secret** — a production key from a second fxratesapi
   account, or the same account if its quota is known to cover both;
   `wrangler secret put FXRATES_API_KEY`.
7. **Docs** — §6, then commit, tag `v1.2.0` (minor: an installer notices), and
   promote in the order `build_multi_deploy.md` §5 gives.

## 8. Risks

| Risk | Mitigation |
|---|---|
| fxratesapi's monthly quota runs out | Bounded at 24 calls a day by the KV refresh age; a quota error is a failure like any other, so the stored copy is served until it expires and then the panel is ECB-only |
| fxratesapi is down or changes shape | Same fallback; `smoke.mjs` names the reason |
| fxratesapi drops a currency | All-or-nothing merge: the panel reverts to ECB-only rather than showing a partial row |
| The step between fixing and market rate shows in the trace | Under 1% against a 48-point series, below what the panel resolves; the hi/lo column stays honest |
| A live `at` near UTC midnight lands on a date Frankfurter has not published yet | Harmless: it is appended as that date and superseded by the fixing when it arrives |
| KV is unavailable | Read and write failures fall through to a plain fetch, so the panel still gets the live point, at the cost of the quota bound for that outage |
| Two upstreams instead of one | Concurrent fetches, so no added latency; only Frankfurter can fail the request |
| The free plan is withdrawn or the terms change | The source is one function and one fixture; the cache, merge and plugin are source-agnostic, as the Coinbase swap showed |

## 9. Not doing

- **A second live source.** One fallback that is the status quo is enough.
  Easy to add later as one more branch in `fetchLive`.
- **A cron trigger.** §4.5. Revisit if the lazy spend ever proves hard to
  predict.
- **A setting to stay ECB-only.** Nobody has asked, and it would double the
  test matrix.
- **Local time in the footer.** TRMNL exposes the user's UTC offset to Liquid,
  so it is possible. UTC first; revisit if the offset arithmetic in Liquid
  turns out clean.
- **Intraday history.** The sparkline covers a month or more at 48 points;
  hours would not be visible. KV holds one value, not a series.
- **Faster than hourly.** The plugin's refresh interval is 3600 and the
  Worker's response is cached for an hour. Anything fresher is wasted, and
  the free plan updates hourly anyway.
