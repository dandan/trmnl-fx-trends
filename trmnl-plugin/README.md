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
strings unaltered — a change cell that is not signless and 2dp fails the run.

## Design rules

These are constraints of the panel, not preferences:

- **Direction is the sign on the figure (`+0.38%`, `-8.79%`), never colour.**
  The display is 1-bit, so any tone between black and white is a halftone. A
  ▲/▼ glyph did this job first: alone it read as decoration rather than as a
  direction, and beside the sign it said the same thing twice for ~10px of
  sparkline in the narrow views.
- **The change sits in a pill: filled black for a fall, outlined for a rise.**
  It is the one derived number in a row of quoted ones, and the box marks it as
  such. The fill is the glance-level cue — from across the room the heavy marks
  are the pairs that dropped — and the sign inside stays as the fact. A change
  that rounds to zero is outlined, since no fall can be claimed for it. The
  fill is the framework's `bg--black text--white` utilities rather than
  literal colours, so it inverts with the panel in dark mode; the footer dates
  carry `text--default` for the same reason. Colour goes through the
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
- **The full view's type is scaled to the rate: 34px, with the pair at 26px.**
  The rate is the number the panel exists to show. The cost is sparkline width
  — the column floors are measured to these sizes, so the TREND track on TRMNL
  OG is 260px where the previous 23/19px scale left it 358px — and the row
  height, which is budgeted to the rate's line box at `line-height: 1`.
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
  year prints the year once: `5 Aug – 4 Sep 2026`.
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
  which is what keeps CHANGE from being taken for a daily move.

### Framework caveats

The markup targets the [TRMNL Framework 3.3](https://trmnl.com/framework/docs/3.3)
design system; its [TRMNL X guide](https://trmnl.com/framework/docs/3.3/trmnl_x_guide)
covers the larger 4-bit panel the v2 design was drawn for, and the
[Screen](https://trmnl.com/framework/docs/3.3/screen) and
[Title Bar](https://trmnl.com/framework/docs/3.3/title_bar) pages document the
classes and variables the views lean on.

Carried over from `meetup_2026`, learned the hard way there:

- **Don't use `label--inverted`, or a bare `label label--small`** for text that
  must be readable. Framework 3.2.0 resolves those through
  `--framework-slot-*` / `--framework-semantic-*` variables that fall back to
  `transparent` under some palettes: the text occupies its box but paints
  invisibly.
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

Two plugin instances live on my account. The **Recipe Master** is what every
installer of the published recipe runs; the **QA clone** is what my device
runs. Each has a deploy profile, and each polls its own Worker:

| Profile | Instance | Polls |
|---|---|---|
| `qa` | the clone, on my device | `exchange-rates-trmnl-qa.uezi.workers.dev` |
| `prod` | the Recipe Master, everyone else | `exchange-rates-trmnl.uezi.workers.dev` |

A change goes to `qa`, gets checked on the device, then goes to `prod`. When
the Worker changes too, it goes first, in the same order:

```bash
(cd ../trmnl-worker && ./deploy.sh qa)
./deploy.sh qa --force            # then check the device
(cd ../trmnl-worker && ./deploy.sh prod)
./deploy.sh prod --force
```

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

> **The one step that stays manual** is adding the plugin to a device playlist —
> trmnlp has no API for it. The script prints the link when it finishes.

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
