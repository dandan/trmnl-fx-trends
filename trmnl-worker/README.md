# exchange-rates-trmnl-worker

A Cloudflare Worker that turns currency pairs into **plot-ready sparkline data**
for a [TRMNL](https://usetrmnl.com) private plugin. Rates come from
[Frankfurter](https://frankfurter.dev) (ECB reference data) — keyless, no signup.

The device does no arithmetic: `points` is an SVG coordinate string already
scaled to the requested box, so the plugin's Liquid is just
`<polyline points="{{ row.points }}"/>`. See [`../BUILD_PLAN.md`](../BUILD_PLAN.md)
§2.1 for why this runs in a Worker rather than polling the API directly.

## Endpoint

```
GET /rates?pairs=GBP/AUD,EUR/USD&range=1Y&w=200&h=30
```

| Param | Default | Notes |
|---|---|---|
| `pairs` | — | Comma-separated `FROM/TO`, max 8. Both codes must be among the 30 supported |
| `range` | `1Y` | `1M`, `3M`, `6M`, `1Y`, `2Y`, `5Y` |
| `w` / `h` | `200` / `30` | Sparkline box. Clamped to 40–800 / 10–200 |

```json
{
  "rows": [{
    "pair": "GBP/AUD", "from": "GBP", "to": "AUD",
    "rate": 1.9104, "change_pct": -7.24,
    "lo": 1.8634, "hi": 2.0937,
    "points": "0.0,21.4 4.3,19.8 …", "n": 48
  }],
  "range": "1Y", "as_of": "2026-08-07", "generated_at": "2026-08-08T…"
}
```

`/` is a public, data-free health endpoint.

### Design notes

- **One upstream request serves every pair.** Everything is fetched as
  `base=USD` and cross-rated locally, so pair count doesn't affect fetch count.
- **The same request supplies the current rate.** Frankfurter clamps `end` to the
  latest publication, so the last point of the series *is* today's rate.
- **`lo`/`hi` come from the full series**, not the downsampled one, so the labels
  match the y-scale the line was drawn against.
- **Stateless** — no KV, no cron. Upstream responses are edge-cached for 6h via
  `cf.cacheTtl`.

## Supported currencies (30)

```
AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK
JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR
```

Anything else returns `400`. See BUILD_PLAN §8.2 for the long-tail options.

## Local development

```bash
npm install
npm run dev                        # http://localhost:8787

curl "http://localhost:8787/rates?pairs=GBP/AUD,USD/JPY&range=1Y"
```

`wrangler dev` sets `CF-Connecting-IP` to loopback, which the allowlist treats as
"no origin" and allows — so local requests work untouched. To exercise the check
itself, send the header yourself (this fetches the real list from trmnl.com):

```bash
curl -so /dev/null -w '%{http_code}\n' -H "CF-Connecting-IP: 1.2.3.4" \
  "http://localhost:8787/rates?pairs=GBP/AUD"   # 403
curl -so /dev/null -w '%{http_code}\n' -H "CF-Connecting-IP: 78.46.130.97" \
  "http://localhost:8787/rates?pairs=GBP/AUD"   # 200
```

## Tests

```bash
npm test      # 60 unit + handler tests, fully offline
npm run smoke # live checks against the real API
```

`npm test` needs no network: the handler is exercised through a stubbed upstream
using a captured fixture, and Node 22 supplies `fetch`/`Request`/`Response`/
`crypto.subtle`, so no wrangler or miniflare is involved.

Three regression tests are worth keeping:

- **The entrypoint has no named exports.** workerd treats each named export of
  `index.js` as a service entrypoint and requires a function or
  `ExportedHandler`, so `export const MAX_PAIRS = 8` stops the runtime booting
  with `Incorrect type for map entry`. Plain Node imports it without complaint,
  so only this test catches it. Shared helpers belong in `source.js`.

- **USD pairs stay finite.** A `base=USD` response has no `USD` key, so a naive
  lookup yields `undefined` → `NaN`/`Infinity` and paints a blank sparkline with
  no error at all. This is the bug that settled the Worker-vs-Liquid question.
- **Points stay inside the box** and contain no `NaN`, for every pair and range.

Measured CPU (excluding network), against the 10ms free-tier limit:

| Range | Dates | Parse + build |
|---|---|---|
| 1Y | 255 | 3.16 ms |
| 5Y | 1,282 | 3.71 ms |

## Deploy

```bash
npx wrangler login    # first time only
./deploy.sh qa        # tests, then deploys the QA Worker
./deploy.sh prod      # tests, then deploys production
```

Two deployments of the same code, from one `wrangler.toml`: `[env.qa]` sets a
second name, and the name sets the URL. My device's plugin (the QA clone) polls
QA; the published recipe polls production, so a production deploy is live for
every installer at once. A change therefore goes to QA first, is checked on
the device, then goes to production — and it must be **additive**, because the
recipe's templates are updated in a separate step and old Liquid meets the new
response in between. Details in
[`../docs/build_multi_deploy.md`](../docs/build_multi_deploy.md).

No secrets to provision: the Worker fetches the allowlist itself at runtime, so
there is nothing to keep in sync between here and the plugin's polling config.

| | URL | Logs |
|---|---|---|
| QA | `https://exchange-rates-trmnl-qa.<subdomain>.workers.dev/rates` | `npm run tail:qa` |
| Production | `https://exchange-rates-trmnl.<subdomain>.workers.dev/rates` | `npm run tail` |

Each deploy is stamped with `git describe --tags`, and `/` reports it as
`version` alongside `env`, so either environment can be asked what it is
running. Versioning is one annotated tag per production promotion, described
in [`../docs/build_multi_deploy.md`](../docs/build_multi_deploy.md).

## Access control

`/rates` allows a request when its `CF-Connecting-IP` appears in TRMNL's
published poller list ([`trmnl.com/api/ips`](https://trmnl.com/api/ips)); `/`
(health) is unconditionally public. There is no bearer token — see below.

TRMNL does not sign its polling requests, so source IP is the only property of a
poll that cannot be forged. It proves *a* TRMNL server, not *this* plugin
instance: every TRMNL user polls from the same handful of addresses, so this is
a coarse filter rather than per-tenant authentication.

The list is fetched lazily on the request path and memoised in a module global
for 24h, so a warm isolate serves thousands of requests per fetch. No KV binding
and no cron trigger: the refresh has no work to do except when a request
arrives. A failed refresh keeps serving the last-known-good list and backs off
for a minute.

A miss against a list older than a minute triggers one re-check before the
request is rejected. Without it, a poller IP that TRMNL added after the last
refresh would 403 every poll until the TTL expired — blanking the device for up
to a day, which is the failure the fail-open exists to prevent.

**This check fails open.** If the list has never been fetched successfully in
this isolate, requests are allowed. The payload is public exchange-rate data,
and a TRMNL API outage that also blanked the device would be a worse failure
than briefly serving an unknown caller. `wrangler dev` and the unit tests see no
`CF-Connecting-IP` (or a loopback one) and are likewise allowed.

### Why there is no bearer token

There was one, removed when this became publishable. A token shipped inside a
public plugin recipe is public by definition: every installer holds the same
secret, so it secures nothing. What it guarded — this Worker's own quota — is
now covered by the IP allowlist, plus the currency allowlist, the max-8-pairs
cap and the `w`/`h` clamps that were always there.

The cost is worth naming: while the allowlist is failing open, `/rates` is open
to anyone. That is a quota exposure on public data, not a data one, which is why
the fail-open stays.

Existing installs are unaffected. They keep sending the old `Authorization`
header and the Worker ignores it — an unread header is inert, not rejected. A
regression test in `tests/worker.test.js` holds that line.
