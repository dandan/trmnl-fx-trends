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
Authorization: Bearer <API_TOKEN>
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
cp .dev.vars.example .dev.vars     # then set a real token
npm run dev                        # http://localhost:8787

curl -H "Authorization: Bearer $(grep API_TOKEN .dev.vars | cut -d= -f2)" \
  "http://localhost:8787/rates?pairs=GBP/AUD,USD/JPY&range=1Y"
```

`wrangler dev` sets `CF-Connecting-IP` to loopback, which the allowlist treats as
"no origin" and allows — so local requests work untouched. To exercise the check
itself, send the header yourself (this fetches the real list from trmnl.com):

```bash
T=$(grep API_TOKEN .dev.vars | cut -d= -f2)
curl -so /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" \
  -H "CF-Connecting-IP: 1.2.3.4"      "http://localhost:8787/rates?pairs=GBP/AUD"   # 403
curl -so /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" \
  -H "CF-Connecting-IP: 78.46.130.97" "http://localhost:8787/rates?pairs=GBP/AUD"   # 200
```

## Tests

```bash
npm test      # 58 unit + handler tests, fully offline
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
npx wrangler login                       # first time only
cp .prod.vars.example .prod.vars         # then: API_TOKEN=$(openssl rand -hex 32)
./deploy.sh --set-secret                 # pushes the secret, then deploys
./deploy.sh                              # subsequent deploys
```

`.prod.vars` holds the **deployed** Worker's token, deliberately separate from
`.dev.vars` — the latter is wrangler's local-development file and every key in
it is injected into `wrangler dev`, so a production secret has no business
there. Both this script (`--set-secret`) and `../trmnl-plugin/deploy.sh` read
`.prod.vars`, so the value Cloudflare checks and the value in the plugin's
polling header come from one source and cannot drift. When they do drift the
only symptom is a silent `401` behind "Rates unavailable" on the device.

Endpoint: `https://exchange-rates-trmnl.<subdomain>.workers.dev/rates`.
Logs: `npm run tail`.

The token is not protecting a secret — the upstream is keyless — it guards this
Worker's own quota so it can't be used as a general-purpose proxy.

## Access control

`/rates` applies two independent checks; `/` (health) applies neither.

1. **Source IP** must appear in TRMNL's published poller list
   ([`trmnl.com/api/ips`](https://trmnl.com/api/ips)), compared against
   `CF-Connecting-IP`. TRMNL does not sign its polling requests, so this is the
   only property of a poll that cannot be forged. It proves *a* TRMNL server,
   not *this* plugin instance — every TRMNL user polls from the same handful of
   addresses — which is why it supplements the token rather than replacing it.
2. **Bearer token**, as above.

The list is fetched lazily on the request path and memoised in a module global
for 24h, so a warm isolate serves thousands of requests per fetch. No KV binding
and no cron trigger: the refresh has no work to do except when a request
arrives. A failed refresh keeps serving the last-known-good list and backs off
for a minute.

**This check fails open.** If the list has never been fetched successfully in
this isolate, requests are allowed. The payload is public exchange-rate data,
and a TRMNL API outage that also blanked the device would be a worse failure
than briefly serving an unknown caller. `wrangler dev` and the unit tests see no
`CF-Connecting-IP` and are likewise allowed.
