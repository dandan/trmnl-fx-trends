# Build plan — TRMNL Exchange Rates

A TRMNL private plugin showing several currency pairs as rows, each with its
current rate, change over the selected window, and a sparkline. Data comes from
[Frankfurter](https://frankfurter.dev) (ECB reference rates) via a Cloudflare
Worker.

Structure follows `../meetup_2026` (Worker + plugin, deployed separately).

---

## 1. Data source

```
GET https://api.frankfurter.dev/v1/{start}..{end}?base=USD&symbols=GBP,AUD,EUR,JPY,CHF
```

Returns `{"base":"USD","start_date":…,"end_date":…,"rates":{"2026-08-07":{"GBP":0.7435,…},…}}`
— keyless, no signup, ECB reference data.

**One request serves every pair.** Fetch the union of currencies across all
requested pairs with `base=USD`, then cross-rate locally. Six pairs cost the same
as one.

**The same request also carries the current rate.** `end` clamps to the latest
publication, so the final point of the series *is* today's rate — no separate
"latest" call.

Verified 2026-08-08:

| Range | Payload (6 symbols) | Points |
|---|---|---|
| 1M | 2.3 KB | 23 |
| 1Y | 24 KB | 255 |
| 5Y | 123 KB | 1,282 |
| 10Y | 245 KB | 2,560 |
| 1Y, *all 30 symbols* | 101 KB | 255 |

Cross-checked against an unrelated source (fawazahmed0): GBP/AUD over the last
year reads −7.24% from both.

### Coverage — 30 currencies

> AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR
> NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR

Every major, plus INR, PHP, IDR, THB, MYR, ZAR, TRY, BRL, MXN, KRW, CNY. Not
covered: the Gulf currencies (AED, SAR), most of Africa (NGN, KES, EGP), VND,
TWD, PKR, and Latin America beyond BRL/MXN. **If a wanted pair falls outside this
list, see §8.2 before working around it.**

### Weekday-only

ECB publishes once per weekday, ~16:00 CET. There is no weekend or holiday data,
so a 1-month sparkline has ~23 points, not 30. This is fine at 200 px wide, but
it means the series is *business days*, and gaps are normal rather than errors.

---

## 2. Architecture

```
  api.frankfurter.dev
        │  one range request, union of symbols
        │  (edge-cached by Cloudflare for 6 h)
        ▼
  ┌──────────── Cloudflare Worker ────────────┐
  │  GET /rates  → auth → validate            │
  │      cross-rate · downsample · scale      │
  └──────────────────┬────────────────────────┘
                     │  ~6 KB JSON, plot-ready
                     ▼
              TRMNL device (polling, hourly)
                     │
        Liquid: <polyline points="{{ row.points }}"/>
```

**The Worker is stateless — no KV, no D1, no cron.** Caching is handled at the
edge on the outbound fetch:

```js
fetch(url, { cf: { cacheTtl: 21600, cacheEverything: true } })
```

Frankfurter already serves `cache-control: max-age=86400` and sits behind
Cloudflare, so the upstream request is cheap and usually a cache hit. Nothing
needs to persist between requests because everything is re-derivable in one call.

The device does no arithmetic — the Worker emits SVG coordinates already scaled
to the sparkline box, so the template only interpolates strings.

### 2.1 Why the Worker at all

Frankfurter is a keyless `GET` returning JSON, which is exactly what TRMNL's
polling strategy consumes. There is no secret to hide and no request reshaping
that TRMNL strictly requires — so the Worker is **a deliberate choice, not a
technical necessity**. Recording why, because it will look arbitrary later.

**A no-Worker build genuinely works.** Every step was verified in the real Ruby
Liquid gem: date math for the polling URL
(`{{ "now" | date: "%s" | minus: 31536000 | date: "%Y-%m-%d" }}`), building the
symbol union from the free-text `pairs` field, cross-rating, min/max, stride
downsampling via `modulo`, scaling, and assembling the `points` string. All of it
runs. The plugin could poll `api.frankfurter.dev` directly with no infrastructure
at all.

**It was then tested against live data, and two things decided it.**

*Liquid fails silently and renders the wreckage.* Every pair involving USD
produced `NaN` and `Infinity` written straight into the SVG `points` attribute —
no error, no exception, just a sparkline that doesn't draw. The cause is
mundane: the upstream is `base=USD`, so there is no `USD` key to look up, and
`nil | divided_by` yields `0` or `Infinity` rather than raising. In JS that is a
one-line guard (`rf = from === "USD" ? 1 : row[from]`). In Liquid it is an
invisible blank row on a device with no console, discovered whenever someone
happens to notice.

*Cost scales badly with range:*

| Range | Payload to device | Liquid render (6 pairs) |
|---|---|---|
| 1Y | 24 KB | 114 ms |
| 5Y | 106 KB | 548 ms |

Against ~6 KB and zero device-side arithmetic via the Worker. That render cost is
paid every hour, forever, inside a TRMNL server-side render budget that is not
observable from here.

**What the Worker earns today:** failure containment and debuggability. A bad
upstream response becomes a clean `502` and the plugin keeps showing its last
good render; a `curl` against `/rates` shows exactly what is wrong. Neither is
possible inside a template render.

**What it no longer earns:** secret-hiding. That was the original justification
back when the data source needed a token, and it no longer applies. The bearer
token in §4.3 now protects only the Worker's own quota — a real but much weaker
reason.

**Revisit this if** the range menu is capped at 1Y *and* the Liquid is stable —
at that point deleting the Worker removes a deployment target for a modest
fragility cost. That trade is defensible; it is just not the one being made here.

---

## 3. Repo layout

```
trmnl-exchange-rates/
├── BUILD_PLAN.md
├── README.md
├── trmnl-worker/
│   ├── wrangler.toml           # no bindings needed
│   ├── package.json
│   ├── deploy.sh
│   └── src/
│       ├── index.js            # routing, auth, validation
│       ├── source.js           # Frankfurter client, range → date math
│       ├── series.js           # cross-rate, downsample, scale to SVG
│       └── shape.js            # response assembly, rounding rules
└── trmnl-plugin/
    ├── .trmnlp.yml             # sample data for offline preview
    ├── .env.example            # TRMNL_API_KEY + TRMNL_PLUGIN_ID
    ├── deploy.sh
    ├── refresh-sample.mjs
    ├── sample.json
    └── src/
        ├── settings.yml
        ├── full.liquid              # 6 rows
        ├── half_horizontal.liquid   # 3 rows
        ├── half_vertical.liquid     # 3 rows, narrow
        ├── quadrant.liquid          # 3 rows, half_vertical layout
        └── shared.liquid            # styles + framework workarounds
```

---

## 4. Worker

### 4.1 Endpoint

```
GET /rates?pairs=GBP/AUD,EUR/USD,USD/JPY&range=1Y&w=200&h=30
Authorization: Bearer <token>
```

| Param | Default | Notes |
|---|---|---|
| `pairs` | — | Comma-separated `FROM/TO`. Max 8. Both codes must be in the 30 |
| `range` | `1Y` | `1M`, `3M`, `6M`, `1Y`, `2Y`, `5Y` |
| `w` / `h` | `200` / `30` | Sparkline box; Worker scales points into it. Clamped |

Response:

```json
{
  "rows": [
    {
      "pair": "GBP/AUD", "from": "GBP", "to": "AUD",
      "rate": 1.9104,
      "change_pct": -7.24,
      "lo": 1.8634, "hi": 2.0936,
      "points": "0.0,21.4 4.3,19.8 …",
      "n": 48
    }
  ],
  "range": "1Y",
  "as_of": "2026-08-07",
  "generated_at": "2026-08-08T10:00:00Z"
}
```

### 4.2 Request pipeline

1. **Auth** — bearer token, constant-time compare. Reuse `timingSafeEqual` from
   `meetup_2026/trmnl-worker/src/index.js`; it's already correct.
2. **Validate** — parse `pairs`, reject codes outside the hardcoded 30, cap at 8
   pairs, clamp `w`/`h`.
3. **Date math** — `range` → `start` (today minus N) and `end` (today).
4. **One fetch** — union of all currencies as `symbols`, `base=USD`, with
   `cf.cacheTtl`.
5. **Cross-rate** — `rate = usd[TO] / usd[FROM]` per date. Iterate the `rates`
   object directly; JSON preserves insertion order, so dates arrive
   chronologically and need no sorting.
6. **Downsample** — even stride to `n = min(points, 48)`, always keeping first
   and last.
7. **Scale** — map into the `w × h` box, emit the `points` string.
8. **Round by magnitude** — `≥100` → 2dp, `≥1` → 4dp, else 6dp.
9. **`change_pct`** — first to last of the *full* series (not the downsampled
   one), so the number is exact and still agrees with the picture.
10. Respond with `Cache-Control: public, max-age=3600`.

Steps 5–8 are already prototyped and verified against live data in the layout
study; porting them to JS is mechanical.

### 4.3 Guards

- **Bearer token** — `wrangler secret put API_TOKEN`. Fail closed if unset.
  Note the upstream is keyless, so this guards the Worker's own quota rather than
  any secret — see §2.1.
- **Currency allowlist** — the 30 valid codes, hardcoded. Rejects typos early and
  stops the Worker being used as a general proxy.
- **Max 8 pairs**, clamped `w`/`h` — caps response size and CPU per request.
- `/` health endpoint stays public and data-free.
- **Upstream failure** — return `502` with a clear message rather than a partial
  screen. The plugin keeps showing the last successful render.

---

## 5. Build order

### 5.1 Worker skeleton — **done**
- [x] `npm init`, wrangler dep, `wrangler.toml` (no bindings)
- [x] `/` health endpoint, bearer auth, `/rates`
- [x] `npm run dev` + curl with the token → 200, verified in workerd

> **workerd constraint:** `src/index.js` must export *nothing but* the default
> handler. Every named export of the entrypoint is treated as a service
> entrypoint and must be a function or `ExportedHandler`, so a plain constant
> (`export const MAX_PAIRS = 8`) makes the runtime refuse to start with
> `Incorrect type for map entry`. Plain Node imports it fine, so `node --test`
> cannot catch this — there is now a test asserting the entrypoint has no named
> exports. Shared helpers live in `source.js`.

### 5.2 Source + series — **done**
- [x] `source.js`: range → dates, symbol union, fetch with `cf.cacheTtl`
- [x] `series.js`: cross-rate, downsample, scale
- [x] `shape.js`: rounding rules, response assembly
- [x] `/rates` returns `rate`, `points`, `change_pct`, `lo`, `hi`
- [x] Verified GBP/AUD 1Y = −7.24% against §1, live

### 5.3 Hardening — **done**
- [x] 5Y CPU measured at **3.71 ms** (255 dates: 3.16 ms), against the 10 ms
      free-tier limit. Cost barely grows with range because downsampling caps
      the plotting work — `5Y` is safe to offer
- [x] Bad input: unknown code, malformed pair, >8 pairs, `range=99Y` → 400
- [x] Upstream 503 → clean 502, no partial payload
- [x] Edge cases: flat series, single point, identical pair, gappy dates

**Test suite:** 44 offline tests (`npm test`) plus live checks (`npm run smoke`).

### 5.4 Plugin — **done**
- [x] `settings.yml` — polling URL, form fields (§6.1), `refresh_interval: 3600`
- [x] `full.liquid` — 6 rows, per the layout study
- [x] `refresh-sample.mjs` + `.trmnlp.yml` for offline preview
- [x] `trmnlp build` → all four views render; screenshotted at device size
- [x] `half_horizontal` (3 rows), `half_vertical` (6 rows, no LO/HI),
      `quadrant` (3 rows, same columns as half_vertical)
- [x] `deploy.sh` (§6.2)
- [x] `test-render.rb` — error state, empty rows, single pair, flat series

> **One response, four sizes.** TRMNL renders every view from a single polling
> response, so one `points` string must work at four widths. The Worker emits a
> fixed `200 × 30` coordinate space and each view rescales via `viewBox` +
> `preserveAspectRatio="none"`, with `vector-effect="non-scaling-stroke"` keeping
> the line weight constant. This is why `w`/`h` are fixed in the polling URL
> rather than varied per view.

> **`half_vertical` takes 6 rows, not 3** as originally sketched. The panel is
> 400×480 — the same *height* as the full view, so width is the constraint. What
> gets dropped is the LO/HI column and the endpoint dot (at 110px wide a
> `<circle>` renders as a visible ellipse), not the rows.

### 5.5 Ship
Two `deploy.sh` scripts, different argument contracts — run each from its own
directory:

```bash
cd trmnl-worker
npx wrangler login                  # first time only
npx wrangler secret put API_TOKEN   # paste the token from .dev.vars
./deploy.sh                         # no arguments

cd ../trmnl-plugin
cp .env.example .env.personal       # fill in TRMNL_API_KEY only
./deploy.sh personal --create       # takes a profile
```

- [ ] Worker: secret set and deployed
- [ ] Plugin: created via `--create` (writes `TRMNL_PLUGIN_ID` back to the profile)
- [ ] Add the plugin to a device playlist (the only manual step)
- [ ] Confirm on device

> **No UI setup needed.** `trmnlp push` with no plugin ID POSTs
> `/api/plugin_settings` to create a private plugin, then uploads `src/` as a
> zip — `settings.yml` carries the strategy, polling URL, bearer header and form
> fields, and `src/*.liquid` the markup for all four views. The new ID is written
> back into the profile, so later deploys are just `./deploy.sh personal`.
> A failed create is cleaned up by trmnlp itself.

---

## 6. Plugin detail

### 6.1 Form fields

```yaml
custom_fields:
- keyname: pairs
  field_type: string
  name: Currency pairs
  description: Comma-separated, max 8 — e.g. GBP/AUD, EUR/USD, USD/JPY
  default: 'GBP/AUD, EUR/USD, GBP/USD, USD/JPY, EUR/CHF, GBP/EUR'
- keyname: range
  field_type: select
  name: Sparkline range
  options: [1M, 3M, 6M, 1Y, 2Y, 5Y]
  default: '1Y'
```

One string field rather than N dropdowns: unlimited pairs, no combinatorial field
explosion, same field feeds every layout size. Cost is typo tolerance — an
unrecognised code must render an explicit `—` row, never a blank or a Liquid
error.

Polling URL:

```
https://<worker>.workers.dev/rates?pairs={{ pairs | url_encode }}&range={{ range }}&w=200&h=30
```

### 6.2 deploy.sh

Port from `meetup_2026/trmnl-plugin/deploy.sh`, keeping:

- **Per-account `.env.<profile>`** holding `TRMNL_API_KEY` + `TRMNL_PLUGIN_ID`.
- **The refusal to push without a plugin ID** — `trmnlp push` silently *creates*
  a new plugin instead of updating when the ID is missing.
- **The `EXIT` trap** restoring `src/settings.yml`, because `push` overwrites it
  with the server's copy including that account's `id`.
- **Bearer-token injection**, since the polling header carries `API_TOKEN` and it
  must stay out of git.

### 6.3 Rendering rules

Carried over from the meetup plugin, learned the hard way there:

- **No `label--inverted`, no bare `label label--small`** for text that must be
  readable. Framework 3.2.0 resolves those through `--framework-slot-*`
  variables that fall back to `transparent` under some palettes — text occupies
  its box but paints invisibly. Use `label--gray-out` / `label--outline`, or set
  colours explicitly in `shared.liquid`.
- **`title_bar` is a sibling of `.layout`, not a child**, or it renders inline
  instead of pinning to the bottom.
- **Direction is a glyph (▲/▼), never colour** — 1-bit panel.
- **The rate column is headed `LATEST`.** ECB publishes once per working day
  ~16:00 CET, so `TODAY` would be wrong for roughly three quarters of the week
  and `CURRENT` implies a live quote rather than a daily fixing. `as_of` in the
  title bar carries the date.
- **Pairs render as `GBP → AUD` with no column header.** `GBP/AUD` assumes the
  reader knows the second currency is the quoted one; misread, the rate is wrong
  by a large factor and a wall display gives no way to check. The arrow states
  the direction, which also makes a "PAIR" header redundant.
- **Each sparkline is scaled to its own range**, which is what makes a 0.67%
  mover and a 7.12% mover both readable. Row shapes are therefore *not*
  comparable to each other — the lo/hi column is what keeps that honest. Keep it.
- **Decimals follow magnitude** (2 / 4 / 6dp, in the Worker), and the rate cell
  is split into integer/fraction spans so the decimal points line up. Widths are
  measured in Liquid from the rows on screen rather than fixed at the worst case
  — 10ch for majors instead of 12ch — with the track set to `minmax(…, auto)` so
  a 5-digit rate widens it instead of overflowing.

### 6.4 Refresh interval

`3600`. ECB publishes once per weekday, so faster polling is wasted — and over a
weekend nothing will move at all. Put `as_of` on screen so a flat or stale-looking
rate explains itself.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Frankfurter is a single free service with no SLA | Stateless design means no data to lose. It's open source and self-hostable if it ever disappears; ECB publishes the same data as XML |
| A wanted pair is outside the 30 | See §8.2 — deliberate decision, not a bug |
| 5Y request is 123 KB upstream | Edge-cached; verify CPU headroom in §5.3. Drop `5Y` if it's tight |
| Weekend/holiday flatness looks like a bug | `as_of` on screen |
| TRMNL payload size ceiling | ~6 KB for 6 pairs, far under. Max-8-pairs cap holds the line |

---

## 8. Open questions

1. **Longest range** — `5Y` is offered because 10y of history exists. `10Y` is
   possible but pulls 245 KB upstream; worth it only if someone wants it.
2. **Pairs outside the 30** — if this comes up, the clean answer is a second
   source behind the same interface (fawazahmed0 covers 286 currencies but needs
   ~48 requests per range and caps at 2.4 years of history). Keeping `series.js`
   agnostic about where the date→rate map came from costs nothing now and makes
   that a drop-in rather than a rewrite.
3. **Change window** — `change_pct` currently tracks the selected range, so the
   number and the picture agree. An always-24h figure is the alternative, but
   then a 5Y sparkline sits next to a one-day number.
