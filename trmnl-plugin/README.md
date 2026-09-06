# trmnl-plugin

The [TRMNL](https://usetrmnl.com) private-plugin project — the display side. It
renders currency pairs as rows with a rate, a change figure and a sparkline,
from the JSON served by [`../trmnl-worker`](../trmnl-worker). Managed with
[`trmnlp`](https://github.com/usetrmnl/trmnlp), TRMNL's official local renderer.

```
trmnl-plugin/
├── .trmnlp.yml            # trmnlp config + captured sample for offline preview
├── .env.example           # template for a per-account deploy profile
├── .env.<profile>         # per-account key + plugin ID (git-ignored)
├── deploy.sh              # push to one account: ./deploy.sh <profile>
├── sample.json            # data snapshot (regenerate with refresh-sample.mjs)
├── refresh-sample.mjs     # rebuild sample.json + .trmnlp.yml from the Worker
├── trmnlp-snap            # trmnlp wrapper for Ubuntu's snap Firefox
├── test-render.rb         # render assertions incl. the states a build can't reach
└── src/
    ├── settings.yml       # polling config + form-field definitions
    ├── full.liquid            # 6 rows
    ├── half_horizontal.liquid # 3 rows
    ├── half_vertical.liquid   # 6 rows, narrow — no LO/HI column
    ├── quadrant.liquid        # 3 rows, same columns as half_vertical
    └── shared.liquid      # shared styles + framework workarounds
```

## One response, four view sizes

TRMNL renders all four views from a **single** polling response, so one
`points` string has to work at four different widths. The Worker emits
coordinates in a fixed `200 × 30` space (`w=200&h=30` in the polling URL) and
each view rescales with `viewBox`:

```html
<svg viewBox="0 0 200 30" width="110" height="24" preserveAspectRatio="none">
  <polyline points="{{ row.points }}" vector-effect="non-scaling-stroke"/>
</svg>
```

`non-scaling-stroke` keeps the line 2px however much the box is squashed.

The wide views mark the latest value with a short vertical `<line>`, not a
`<circle>`: `preserveAspectRatio="none"` scales x and y independently, so a
circle renders as a visible ellipse, while a vertical line stays vertical under
any horizontal stretch. `half_vertical` and `quadrant` drop the marker
altogether — at ~110px their traces are compressed enough that it reads as a
kink in the line rather than as an endpoint.

## Local preview

```bash
gem install trmnl_preview
trmnlp serve            # http://localhost:4567 — live-reloads on save
trmnlp build            # or: write static HTML to _build/ (git-ignored)
```

Previews render from the sample baked into `.trmnlp.yml` (`variables:`), so they
work offline with no token. trmnlp still polls the Worker on startup and logs a
`403 {"error": "Forbidden"}` — expected, since the Worker only answers TRMNL's
own IPs (see `../trmnl-worker/src/allowlist.js`). It does not affect the render.

On Ubuntu, `/usr/bin/firefox` is a shell wrapper around the snap, which
geckodriver rejects with `binary is not a Firefox executable`, failing every
screenshot. Run [`./trmnlp-snap`](trmnlp-snap) in place of `trmnlp` there — it
is the same CLI with Selenium pointed at the snap's real binary.

### Refresh the sample data

```bash
node refresh-sample.mjs "GBP/AUD, EUR/USD, USD/JPY" 1Y
```

Runs the **Worker's own handler** against live Frankfurter data — no deployed
Worker and no token needed — then rewrites `sample.json` and the `variables:` in
`.trmnlp.yml`. The preview therefore exercises the real response shape rather
than a hand-maintained fixture.

## Tests

```bash
ruby test-render.rb
```

`trmnlp build` proves the templates compile against real data. `test-render.rb`
covers what a build cannot reach: the Worker returning an error, an empty `rows`
array, fewer pairs than a view has room for, and a perfectly flat series (both
`0` and a rounded `-0.0`). It also asserts every `points` attribute parses as
finite coordinate pairs, and that each view prints the Worker's pre-formatted
strings unaltered — a change cell that is not signless and 2dp fails the run.

## Design rules

These are constraints of the panel, not preferences:

- **Direction is a glyph (▲/▼), never colour.** The display is 1-bit.
- **Pairs read `GBP → AUD`, not `GBP/AUD`, and the column has no header.** The
  slash form relies on knowing that the second currency is the one being quoted
  — misread, `1.9104` is wrong by a factor of ~3.6, and a wall display offers no
  way to check. The arrow says "1 GBP buys this many AUD" outright, which also
  makes a "PAIR" header redundant. Every pair is exactly `XXX → XXX`, so the
  column width is fixed and can be declared rather than left to overflow.
- **No opacity, no grey text.** Anything between black and white is dithered into
  a halftone, which turns 10px text into mush. Secondary information is made
  secondary by *size*.
- **Each sparkline is scaled to its own range**, which is what lets a 0.67% mover
  and a 7.12% mover both read clearly. Row shapes are therefore **not**
  comparable to each other — the LO/HI column is what keeps that honest, so
  don't drop it from the wide views.
- **The rate column is headed `LATEST`, never `TODAY` or `CURRENT`.** The ECB
  publishes once per working day around 16:00 CET, so the newest figure is
  yesterday's or Friday's for roughly three quarters of the week — a "today"
  label would be wrong most of the time, and "current" implies a live market
  quote rather than a daily reference fixing. The header answers *which* rate;
  the title bar's `as_of` answers *as of when*.
- **Rates and bounds carry five significant figures, not a fixed number of
  decimals.** That is what the source carries: ECB quotes to about five figures
  whatever the magnitude (`159.68` for JPY, `0.80426` for CHF), so a
  decimals-by-magnitude rule invents digits at the small end and discards them at
  the large end. Decided in the Worker (`sigFigs` in `shape.js`).
- **Every displayed figure arrives pre-formatted as a string** — `rate_str`,
  `lo_str`, `hi_str`, `change_str` — alongside its numeric form. JSON cannot
  carry a trailing zero, so `1.3450` would reach the device as `1.345` and render
  a character short of its neighbours. The views print the string verbatim; any
  `| round` or `| abs` in a template puts the ragged edge back.
- **Rates are right-aligned, and their decimal points deliberately do not line
  up.** Rates from different pairs are not a comparable series — `159.68`
  JPY-per-USD and `1.8782` AUD-per-GBP measure different things — so there is
  nothing to gain by scanning down the point, and the fixed-width spans that
  decimal alignment needs cost real width in the narrow views. Tabular figures
  keep the digits from shifting between refreshes.
- **Each column track carries a pixel floor** (see each view's
  `grid-template-columns`). Every row is its own grid, so an `auto` track is
  resolved per row: the widest rate would set only its own row's column and push
  CHANGE and TREND out of line with the rows above. The floor is sized to the
  widest string the column can hold, so `auto` never has to grow.
- **The change is the exception: fixed 2dp, always** (`change_str`). It is a
  percentage, so its magnitude says nothing about the precision available —
  `8.79%` and `0.64%` are good to the same 2dp — and a fixed width is what lets
  the column line up.
- **A change that rounds to zero gets no glyph at all.** `change_pct` is rounded
  to 2dp upstream, so `0.00%` means "moved less than 0.005%", not "did not move";
  neither arrow can be claimed for it. Nothing takes the arrow's place — a dash
  or bar beside the figure reads as *minus* 0.00%. The column is right-aligned,
  so the figure stays on the same edge and only the space ahead of it opens up.
- **The window is stated once, on the TREND header** (`1 YEAR TREND`). It governs
  three of the columns — the change figure, the sparkline and HI / LO are all
  measured over it — and a column header is read together with the numbers,
  which is what keeps CHANGE from being taken for a daily move.

### Framework caveats

Carried over from `meetup_2026`, learned the hard way there:

- **Don't use `label--inverted`, or a bare `label label--small`** for text that
  must be readable. Framework 3.2.0 resolves those through
  `--framework-slot-*` / `--framework-semantic-*` variables that fall back to
  `transparent` under some palettes: the text occupies its box but paints
  invisibly.
- **`.title_bar` must be a sibling of `.layout`, placed after it**, or it renders
  inline instead of pinning to the bottom.
- `src/settings.yml` pins `framework_version: 3.1.6`, but **don't rely on it** —
  the markup is written to render on any version, and that is what actually
  protects the plugin. `trmnlp serve` always loads `css/latest` regardless.

> When previewing locally, the grey background is TRMNL's own
> `.environment { background-color: gray }` preview chrome, not the plugin. The
> panel itself is white.

## First-time setup on a new account

```bash
cp .env.example .env.personal   # fill in TRMNL_API_KEY only
./deploy.sh personal --create
```

That's the whole setup. `trmnlp push` with no plugin ID POSTs
`/api/plugin_settings` to create a private plugin, then uploads `src/` as a zip
— so `settings.yml` carries the strategy, polling URL, bearer header and form
fields, and `src/*.liquid` carries the markup for all four views. Nothing is
pasted into the web UI. The new plugin ID is written back into
`.env.personal`, so every subsequent deploy is just `./deploy.sh personal`.

`--create` refuses to run if the profile already has a `TRMNL_PLUGIN_ID`, since
that would leave a duplicate plugin on the account. It is the mirror of the
existing guard that refuses to push *without* one.

### What is and isn't parameterised

`polling_url` carries the real Worker host and is committed in
[`src/settings.yml`](src/settings.yml). It is not a secret, one Worker serves
every account, and it only changes if the Worker is renamed — so it lives where
it is used rather than being injected at deploy time.

Only two values are held out of git, and each for a specific reason:

| Value | Where it lives | Why |
|---|---|---|
| `API_TOKEN` | `../trmnl-worker/.prod.vars` | A secret. Injected into `settings.yml` for the upload, reverted by an `EXIT` trap. |
| `TRMNL_PLUGIN_ID` | `.env.<profile>` | Account-specific, *and* `trmnlp push` overwrites `settings.yml` with the server's copy including its `id`. |

The token is read from `.prod.vars` rather than `.dev.vars` because the latter
is wrangler's local-development file — every key in it is injected into
`wrangler dev`. And not from `.env.<profile>`, because one Worker serves every
TRMNL account, so the token is project-scoped rather than account-scoped.

`../trmnl-worker/deploy.sh --set-secret` reads the same file to provision
Cloudflare, so the token the Worker checks and the token in this polling header
cannot drift apart.

> **The one step that stays manual** is adding the plugin to a device playlist —
> trmnlp has no API for it. The script prints the link when it finishes.

If the upload fails partway, trmnlp deletes the plugin it just created, so a
failed `--create` doesn't leave an orphan behind.

## Deploy

```bash
./deploy.sh personal            # uploads settings.yml + all src/*.liquid
```

The script injects the Worker's bearer token into `settings.yml` only for the
upload and restores the placeholder via an `EXIT` trap, so the token never lands
in git. It refuses to run without a `TRMNL_PLUGIN_ID`, because `trmnlp push`
silently *creates* a new plugin when the ID is missing rather than updating the
intended one.
