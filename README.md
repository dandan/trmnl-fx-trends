# TRMNL FX Trends

A [TRMNL](https://usetrmnl.com) plugin that shows exchange rates for the
currency pairs you choose, each as a sparkline with the latest rate and the
percentage change over a window of one month to five years. Daily ECB reference
rates via [Frankfurter](https://frankfurter.dev); no account or API key needed.

![Full view on a TRMNL OG](docs/images/full-og.png)

Six pairs by default, from 30 supported currencies. Every view size is
provided, including TRMNL X in portrait and dark mode.

## How it works

Two parts, deployed separately:

| Part | What it does |
|---|---|
| [`trmnl-worker/`](trmnl-worker/) | A Cloudflare Worker. One request to Frankfurter serves every pair; the Worker cross-rates, downsamples and returns plot-ready SVG coordinates, so the device does no arithmetic. |
| [`trmnl-plugin/`](trmnl-plugin/) | The TRMNL private plugin: Liquid templates for all four layouts, the settings form, and a local preview and test setup. |

The Worker answers only TRMNL's own poller addresses, so it needs no token
and nothing secret ships in the recipe.

## Install

Install it from the TRMNL recipe directory, pick your pairs and a window, and
add it to a playlist. To run your own copy instead, each part's README covers
setup and deployment:

- [Worker README](trmnl-worker/README.md) — endpoint, local development, tests, deploy
- [Plugin README](trmnl-plugin/README.md) — local preview, design rules, deploy profiles

## Design notes

The panel is 1-bit e-paper, and most of the plugin's decisions follow from
that: direction is the sign on the figure rather than a colour, secondary
information is smaller rather than greyer, and each sparkline is scaled to its
own range with the high and low printed beside it so the shapes stay honest.
The full list, with reasons, is in the plugin README's
[design rules](trmnl-plugin/README.md#design-rules).

[`BUILD_PLAN.md`](BUILD_PLAN.md) records how the architecture was chosen, and
[`docs/build_multi_deploy.md`](docs/build_multi_deploy.md) how changes are
staged on one device before they reach every installer.

## Licence

[MIT](LICENSE).
