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
├── screenshots.sh         # every layout x device x orientation x mode -> docs/screenshots/
├── test-render.rb         # render assertions incl. the states a build can't reach
├── test-frame.rb          # the mashup views in a browser, framed as TRMNL's generator frames them
└── src/
    ├── settings.yml       # polling config + form-field definitions
    ├── full.liquid            # 6 rows
    ├── half_horizontal.liquid # 3 rows
    ├── half_vertical.liquid   # 6 rows, narrow — no LO/HI column
    ├── quadrant.liquid        # 3 rows, same columns as half_vertical
    └── shared.liquid      # the little CSS the framework has no utility for
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

Each trace ends in a round dot marking where LATEST sits on it. The dot is a
positioned `<span>` over the svg, not a `<circle>` inside it:
`preserveAspectRatio="none"` scales x and y independently, so anything drawn in
the svg squashes with it (an earlier `<line>` marker read as a rendering
artefact for that reason). The view places it from the `points` string itself —
x is always 100%, and y is the last point's y over the 30px box:

```liquid
{% assign fx_end = row.points | split: " " | last | split: "," %}
{% assign fx_end_y = fx_end[1] | times: 100.0 | divided_by: 30 %}
<span class="fx-dot" style="top: {{ fx_end_y }}%"></span>
```

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

The wrapper also fixes trmnlp's PNG mode, which is worth using regardless of
Firefox flavour: stock trmnlp 0.7.1 quantises the screenshot with its alpha
channel still on, which paints faint grey ellipses onto the white ground (only
in PNG mode — the HTML preview is unaffected) and logs `convert: Cannot write
image with defined png:bit-depth or png:color-type`. The wrapper drops the alpha
channel before the dither, which clears both. If you see the blobs, you are
running plain `trmnlp`.

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
strings unaltered — a change cell that is not signed and 2dp fails the run.
(The one substitution is the minus sign; see the design rules.)

```bash
ruby test-frame.rb
```

`test-frame.rb` loads the three mashup views in headless Firefox, each in a
frame of its slot's size where the framework's `--screen-h` is `100%`, which is
how TRMNL's screen generator draws a mashup and how neither the markup editor
nor trmnlp does. It covers the X and the OG, landscape and portrait. It asserts every sparkline has a height and the rows stop
short of the title bar. A plot height built on `--screen-h` passes every
preview and renders 0px tall on the device; this is the test that catches it.
It needs the network and a Firefox, so it is run by hand and not by `deploy.sh`.

## Design rules

These are constraints of the panel, not preferences:

- **Direction is the sign on the figure (`+0.38%`, `−8.79%`), never colour.**
  The display is 1-bit, so any tone between black and white is a halftone. A
  ▲/▼ glyph did this job first: alone it read as decoration rather than as a
  direction, and beside the sign it said the same thing twice for ~10px of
  sparkline in the narrow views. A fall prints with a true minus sign
  (`&minus;`), which each view swaps in for the Worker's hyphen: it is as wide
  as the plus, so the pills match.
- **The change is always three digits: `2.30`, `12.3`, `113`.** The pill sits
  in a fixed-width track, so a fourth digit would be clipped. The Worker drops
  precision as the figure grows; a two-year or five-year window makes
  double-digit changes ordinary.
- **The change sits in a pill: filled black for a fall, outlined for a rise.**
  It is the one derived number in a row of quoted ones, and the box marks it as
  such. The fill is the glance-level cue — from across the room the heavy marks
  are the pairs that dropped — and the sign inside stays as the fact. A change
  that rounds to zero is outlined, since no fall can be claimed for it. The
  pill is the framework's own `label label--filled` / `label label--outline`,
  not a hand-drawn border, so it takes the panel's radius, inset and face,
  inverts with the panel in dark mode, and steps up with `lg:label--large` on
  a TRMNL X; the footer dates carry `text--default` for the same reason.
  Colour goes through the
  framework's utility classes, never its `--framework-*` variables: those are
  undocumented, and the [theme docs](https://trmnl.com/framework/docs/3.3/theme_slots)
  say plugins should reach colour through the utilities.
- **Pairs read `GBP → AUD`, not `GBP/AUD`.** The slash form relies on knowing
  that the second currency is the one being quoted — misread, `1.9104` is wrong
  by a factor of ~3.6, and a wall display offers no way to check. The arrow
  says "1 GBP buys this many AUD" outright. The column is headed `PAIR` like
  every other; without it the header row reads as starting at LATEST. Every
  pair is exactly `XXX → XXX`, so the column width is fixed and can be declared
  rather than left to overflow.
- **Rules are solid, never dotted.** A 1px dotted line is a row of single
  pixels, which the panel's dither treats as noise and half of which vanish.
  The header rule is 2px so the header reads as a header, not a seventh row.
- **No opacity, no grey text.** Anything between black and white is dithered into
  a halftone, which turns 10px text into mush. Secondary information is made
  secondary by *size*.
- **Each sparkline is scaled to its own range**, which is what lets a 0.67% mover
  and a 7.12% mover both read clearly. Row shapes are therefore **not**
  comparable to each other — the LO/HI column is what keeps that honest, so
  don't drop it from the wide views.
- **Every piece of text is a framework tier.** The rate is the number the
  panel exists to show, so it takes the largest tier on the row (`value--base`
  on the full view) with the pair a clear step below (`value--small`); the
  change and the bounds step down again to `label` tiers, and the header is a
  bold `label`. The smaller views start lower and climb one tier under `lg:`
  on a TRMNL X. The full view does not: on an X only its pill steps up, and
  the extra width goes to the trace. No `font-size` is set anywhere: the
  framework resolves each tier to the right face and size for the panel.
- **The fixed columns are measured, and the trace takes the rest.** The rate
  track fits the widest nine-character rate at its tier and the change track
  the widest pill. The two narrow views, where width is shortest, cut the rate
  track to the longest rate actually on show (seven characters at least), so
  a panel of ordinary pairs is not paying for `0.0063521`. Each row is its own
  grid, so these tracks must be fixed widths: a track sized to its content
  would put one row's pill and trace out of line with the others.
- **Portrait puts each row on two lines.** No view has the width for a
  one-line row in portrait. On the full and half_horizontal views, and on the
  narrow views on a TRMNL X, the pair, rate and change share one line and the
  trace runs beneath; the header follows, with the trend label on a second,
  smaller line at the trace's left edge. On an OG the narrow views are 240px
  wide and drop the header altogether: pair and rate on one line, pill and
  trace on the next, and the window moves to the title bar as
  `1Y to 25 Sep 2026`.
- **The rate column is headed `LATEST`, never `TODAY` or `CURRENT`.** The ECB
  publishes once per working day around 16:00 CET, so the newest figure is
  yesterday's or Friday's for roughly three quarters of the week — a "today"
  label would be wrong most of the time, and "current" implies a live market
  quote rather than a daily reference fixing. The header answers *which* rate;
  the title bar's `5 Sep 2025 – 4 Sep 2026` answers *over what window*, and its
  last date is the same "as of when" the rate carries.
- **Footer dates print as `4 Sep 2026`, from ISO data.** The Worker sends
  `start_date` and `as_of` as `YYYY-MM-DD` and they stay that way in the JSON;
  the template formats them. ISO on a wall reads as a database field, and
  numeric day-month is the one form readers in different countries disagree
  on, so the month is a name. The ends are joined by an en dash, not the arrow,
  which already means "converts to" in the pair column. A window inside one
  year prints the year once: `5 Aug – 4 Sep 2026`. The two narrow views have
  no room for both ends and print the as-of date alone.
- **Rates and bounds carry five significant figures, not a fixed number of
  decimals.** That is what the source carries: ECB quotes to about five figures
  whatever the magnitude (`159.68` for JPY, `0.80426` for CHF), so a
  decimals-by-magnitude rule invents digits at the small end and discards them at
  the large end. Decided in the Worker (`sigFigs` in `shape.js`).
- **Every displayed figure arrives pre-formatted as a string** — `rate_str`,
  `lo_str`, `hi_str`, `change_str` — alongside its numeric form. JSON cannot
  carry a trailing zero, so `1.3450` would reach the device as `1.345` and render
  a character short of its neighbours. The views print the digits verbatim; any
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
- **The change is the exception: signed, fixed 2dp, always** (`change_str`). It
  is a percentage, so its magnitude says nothing about the precision available —
  `8.79%` and `0.64%` are good to the same 2dp — and a fixed width is what lets
  the column line up. The sign is set in the Worker, so the views print it
  verbatim like every other figure.
- **A change that rounds to zero takes no sign.** `change_pct` is rounded to 2dp
  upstream, so `0.00%` means "moved less than 0.005%", not "did not move";
  neither direction can be claimed for it. Nothing marks it either — a dash or
  bar beside the figure reads as *minus* 0.00%. The column is right-aligned, so
  the figure stays on the same edge and only the space ahead of it opens up.
- **The window is stated once, on the TREND header** (`1 YEAR TREND`). It governs
  three of the columns — the change figure, the sparkline and HI / LO are all
  measured over it — and a column header is read together with the numbers,
  which is what keeps CHANGE from being taken for a daily move. Where there is
  no header (the narrow views on an OG in portrait) the title bar states it
  instead.

### Framework caveats

The markup targets the [TRMNL Framework 3.3](https://trmnl.com/framework/docs/3.3)
design system; its [TRMNL X guide](https://trmnl.com/framework/docs/3.3/trmnl_x_guide)
covers the larger 4-bit panel the v2 design was drawn for, and the
[Screen](https://trmnl.com/framework/docs/3.3/screen) and
[Title Bar](https://trmnl.com/framework/docs/3.3/title_bar) pages document the
classes and variables the views lean on.

Carried over from `meetup_2026`, learned the hard way there:

- **Don't use `label--gray` without `1bit:text--black`**: the gray slot can
  resolve to `transparent` on a 1-bit palette and the text paints invisibly.
  (`label--inverted` is the deprecated name for `label--filled`; the pill
  uses the current one.)
- **Text Scale is honoured at small and regular only.** The device setting
  ([Text Scale](https://trmnl.com/framework/docs/3.4/text_scale)) multiplies
  the framework's fonts by 0.8, 1, 1.25 or 1.5 and leaves geometry alone. The
  tracks and plot heights are pixel budgets cut to the regular size, and the
  narrow slots have no room for larger text, so `shared.liquid` sets large and
  x-large back to 1 on `.screen`. The framework resolves font sizes there, so
  a rule lower down has no effect; the docs do not describe overriding it.
- **Prefer a framework tier to a custom rule.** TRMNL's recipe review flagged
  a `font-weight: 700` and a hand-drawn pill border as rewriting `text--bold`,
  `label--filled` and `label--outline`: the utilities exist, and only they
  take `lg:` / `portrait:` prefixes, which is what scales the plugin to a
  TRMNL X. `shared.liquid` keeps only what has no utility: the mixed-track
  grid columns, the rules, the header tracking and the sparkline geometry.
  The [TRMNL X guide](https://trmnl.com/framework/docs/trmnl_x_guide) and the
  [recipe publishing tips](https://trmnl.com/blog/plugin-recipe-publishing-tips)
  are the references.
- **`.title_bar` must be a sibling of `.layout`, placed after it**, or it renders
  inline instead of pinning to the bottom.
- `src/settings.yml` pins `framework_version: 3.3.1`, which is what
  `css/latest` served when it was set, so the device and `trmnlp serve` render
  the same CSS. **Don't rely on it** — the markup is written to render on any
  3.x version, and that is what actually protects the plugin.

> When previewing locally, the grey background is TRMNL's own
> `.environment { background-color: gray }` preview chrome, not the plugin. The
> panel itself is white.

## QA and production

Two plugin instances live on your account. The **Recipe Master** is what every
installer of the published recipe runs; the **QA clone** is what your device
runs. Each has a deploy profile, and each polls its own Worker:

| Profile | Instance | Polls |
|---|---|---|
| `qa` | the clone, on your device | `exchange-rates-trmnl-qa.uezi.workers.dev` |
| `prod` | the Recipe Master, everyone else | `exchange-rates-trmnl.uezi.workers.dev` |

A change goes to `qa`, gets checked on the device, is committed and tagged,
then goes to `prod`. When the Worker changes too, it goes first each time:

```bash
(cd ../trmnl-worker && ./deploy.sh qa)
./deploy.sh qa --force            # then check the device
git tag -a v1.2.0 -m "What changed"
(cd ../trmnl-worker && ./deploy.sh prod)
./deploy.sh prod --force
git push origin v1.2.0            # only once both prod deploys succeeded
(cd ../trmnl-worker && ./deploy.sh qa) && ./deploy.sh qa --force   # QA onto the tag too
```

Both deploys stamp themselves from the tag: the Worker reports it at `/`,
and the plugin's "About this plugin" text ends with it, so the dashboard
says which build each instance runs. Tag before the prod pushes, or they
read a bare commit hash.

The QA Worker names itself in its response (`env: "qa"`) and the title bar
prints it — `Exchange Rates (QA)` — so a glance at the device says which
Worker it is polling. Production sends no such field and the title is bare.

The clone was made once in the TRMNL UI with the copy icon (trmnlp has no
clone call, and `--create` makes an empty plugin, not a copy); its ID is in
`.env.qa`. The reasoning, and the rule that Worker changes must be additive
so old templates keep rendering between the two prod deploys, are in
[`../docs/build_multi_deploy.md`](../docs/build_multi_deploy.md).

## First-time setup on a new account

```bash
cp .env.example .env.thomas     # fill in TRMNL_API_KEY and WORKER_HOST
./deploy.sh thomas --create
```

That's the whole setup. `trmnlp push` with no plugin ID POSTs
`/api/plugin_settings` to create a private plugin, then uploads `src/` as a zip
— so `settings.yml` carries the strategy, polling URL and form fields, and
`src/*.liquid` carries the markup for all four views. Nothing is pasted into
the web UI. The new plugin ID is written back into `.env.thomas`, so every
subsequent deploy is just `./deploy.sh thomas`.

`--create` refuses to run if the profile already has a `TRMNL_PLUGIN_ID`, since
that would leave a duplicate plugin on the account. It is the mirror of the
existing guard that refuses to push *without* one.

### What is and isn't parameterised

`polling_url` is committed in [`src/settings.yml`](src/settings.yml) with the
**production** Worker host, because the committed file is what the published
recipe ships. Three values are held out of git, in `.env.<profile>`:

| Value | Why |
|---|---|
| `TRMNL_API_KEY` | A secret, and per account. |
| `TRMNL_PLUGIN_ID` | Per instance, *and* `trmnlp push` overwrites `settings.yml` with the server's copy including its `id`. |
| `WORKER_HOST` | Per instance: the QA clone polls the QA Worker. `deploy.sh` swaps it into `polling_url` for the upload only, inside the same backup/restore that already protects `settings.yml`, and refuses to run without it. |
| *(version)* | Not a profile value: the bio's `Version __VERSION__` is filled from `git describe --tags` at push time, so "About this plugin" in the dashboard says which build an instance runs. Tag before promoting. |
| `PLUGIN_NAME_SUFFIX` | Optional. `settings.yml` carries the plugin's `name:` and the push overwrites the server's copy with it, so the QA clone became a twin of the master in the dashboard. The QA profile sets `" (QA)"`, applied for the upload only. |

> **Two steps stay manual**, since trmnlp has no API for either: adding the
> plugin to a device playlist (the script prints the link when it finishes),
> and uploading the recipe's directory-card icon on the plugin's settings page.
> The icon lives in [`assets/`](assets/): `fx-trends-icon.svg` is the source,
> `fx-trends-icon.png` the 512px upload. Re-render with
> `inkscape fx-trends-icon.svg -w 512 -h 512 -o fx-trends-icon.png`.

If the upload fails partway, trmnlp deletes the plugin it just created, so a
failed `--create` doesn't leave an orphan behind.

## Deploy

```bash
./deploy.sh qa --force          # uploads settings.yml + all src/*.liquid
```

The script swaps the profile's `WORKER_HOST` into `settings.yml` only for the
upload and restores the committed file via an `EXIT` trap, so the QA host never
lands in git. It refuses to run without a `TRMNL_PLUGIN_ID`, because `trmnlp
push` silently *creates* a new plugin when the ID is missing rather than
updating the intended one. Pass `--force` to skip trmnlp's "overwrite?" prompt,
which is required when there is no terminal.
