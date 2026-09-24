# Build plan — QA and production deploys

A way to see a change on my own device before every installer of the recipe
sees it. Today there is one Worker and one plugin instance, and once the plugin
is published as a recipe both are live for everyone the moment they deploy.

Status: built 2026-09-24. Sections 3–4 describe what is in place; §5 is the
working rule; §6 is kept as the record of how it was set up.

---

## 1. What publishing changes

Publishing a private plugin as a recipe makes my instance the **Recipe
Master**. Every later change to that instance — settings, polling URL, Liquid —
propagates to everyone who installed it. TRMNL's own advice is to clone the
plugin, test on the clone, then update the master.

The Worker has the same shape without the badge: its URL is baked into the
recipe's polling URL, so a `wrangler deploy` is live for every install at once.

So there are two things to stage, and they need different mechanisms:

| Thing | Isolation today | Isolation needed |
|---|---|---|
| Plugin (Liquid + settings) | one instance per account, chosen by `.env.<profile>` | a second instance on my account: the clone |
| Worker | one deployment | a second deployment: a wrangler environment |

## 2. Environments

Two, named `qa` and `prod`. Not `dev`: `wrangler dev` and `trmnlp serve` are
already the local loop, and this is the step after that.

|  | qa | prod |
|---|---|---|
| Worker name | `exchange-rates-trmnl-qa` | `exchange-rates-trmnl` (unchanged) |
| Worker URL | `exchange-rates-trmnl-qa.uezi.workers.dev` | `exchange-rates-trmnl.uezi.workers.dev` (unchanged) |
| Plugin instance | the clone, on my device's playlist | the Recipe Master |
| Plugin profile | `.env.qa` | `.env.prod` (today's `.env.personal`, renamed) |
| Who sees it | my device | every installer |

`thomas` stays a separate profile pointing at prod's Worker; it is another
account's install, not an environment.

## 3. Worker: a wrangler environment

`wrangler.toml` gains one stanza:

```toml
[env.qa]
name = "exchange-rates-trmnl-qa"
```

That is the whole change. Environments inherit `main`, `compatibility_date`,
`workers_dev` and `[observability]` from the top level; only the name differs,
and the name is what sets the URL. There are no bindings or secrets to
duplicate — the Worker is stateless and the IP allowlist is fetched at runtime.

`deploy.sh` takes the environment as its first argument and refuses to run
without one, so `./deploy.sh` alone can no longer mean prod:

```
./deploy.sh qa      # npm test, then wrangler deploy --env qa
./deploy.sh prod    # npm test, then wrangler deploy
```

`package.json` gets `deploy:qa` alongside `deploy` for the same reason.

The smoke test (`tests/smoke.mjs`) runs the handler in-process against the
live upstream, so it has no host to point at and is unaffected.

## 4. Plugin: a clone and a host per profile

### 4.1 The clone

Made once, in the TRMNL UI: clone the master with the copy icon, name the copy
"Exchange Rates (QA)", put it on the device playlist in place of the master.
Its ID goes into `.env.qa`. `deploy.sh --create` is not the right tool here —
the clone must be a clone so it keeps the master's form-field values.

The master stays installed on the account but off the device: it is the thing
everyone else runs, and the device is for checking what comes next.

### 4.2 The polling URL

`src/settings.yml` commits the prod host in `polling_url`. That has to stay:
it is what the recipe ships, and the committed file must be what installers
get. So the qa host is substituted at push time and never committed.

The profile file gains one key:

```
WORKER_HOST=exchange-rates-trmnl-qa.uezi.workers.dev    # .env.qa
WORKER_HOST=exchange-rates-trmnl.uezi.workers.dev       # .env.prod
```

`deploy.sh` already copies `settings.yml` aside and restores it on exit,
because `trmnlp push` overwrites it with the server's copy. The substitution
slots into that same window: after the backup, `sed` the committed host to
`$WORKER_HOST`; the existing trap puts the committed file back. A missing
`WORKER_HOST` is an error, not a default — a profile that silently pushed the
prod host to the clone would defeat the point.

The committed host is matched literally (`exchange-rates-trmnl.uezi.workers.dev`),
not by pattern, so a typo in the profile fails loudly rather than pushing a
half-substituted URL.

### 4.3 Profiles

```
.env.qa       TRMNL_API_KEY, TRMNL_PLUGIN_ID=<clone>,  WORKER_HOST=<qa host>
.env.prod     TRMNL_API_KEY, TRMNL_PLUGIN_ID=<master>, WORKER_HOST=<prod host>
.env.thomas   TRMNL_API_KEY, TRMNL_PLUGIN_ID=<his>,    WORKER_HOST=<prod host>
```

`.env.example` documents `WORKER_HOST`. Renaming `personal` to `prod` is a
`git mv` of a git-ignored file, i.e. a plain `mv`; the name should say what a
push to it does.

### 4.4 Local preview

`refresh-sample.mjs` runs the Worker's handler in-process, so it needs no host
and is unaffected. `trmnlp serve` polls whatever `polling_url` says and gets
403 either way (the allowlist rejects non-TRMNL IPs), so that is unaffected
too. Nothing local changes.

## 5. Promotion order

A change touching both halves goes out in this order, and the order is the
whole versioning scheme:

1. `trmnl-worker/deploy.sh qa`
2. `trmnl-plugin/deploy.sh qa --force` — check the device (allow one refresh
   interval, or force a refresh from the playlist)
3. `trmnl-worker/deploy.sh prod`
4. `trmnl-plugin/deploy.sh prod --force`

`--force` skips trmnlp's "overwrite?" prompt, which needs a terminal.

Between steps 3 and 4 — and for any installer whose device polls before its
template is refreshed — old Liquid runs against the new Worker response. So:

**Worker changes must be additive.** New fields, yes. Renamed, removed or
re-shaped fields, no. A field that has to change shape gets a new name, the old
one keeps being emitted until no template reads it, and it is dropped in a
later release. `test-render.rb` already renders the templates against
`sample.json`; a check that the *previous* commit's templates also render
against the current sample would make this rule mechanical, and is worth
adding when the first non-trivial Worker change comes.

Plugin-only changes skip steps 1 and 3. Worker-only changes skip 2 and 4 but
still go through qa first: the device is polling qa, so a broken Worker shows
up there as a blank sparkline before it can show up for anyone else.

## 6. Steps

1. **Worker** — `[env.qa]` in `wrangler.toml`; `deploy.sh` takes `qa|prod`;
   `deploy:qa` script; smoke test takes a host. Deploy qa, confirm the URL
   answers 403 from here and 200 from a TRMNL poller (the device, once step 3
   is done).
2. **Plugin profiles** — `WORKER_HOST` in `.env.example`; rename
   `.env.personal` to `.env.prod` and add the host; `deploy.sh` substitutes the
   host inside the existing backup/restore window and errors without it.
3. **Clone** — in the UI: clone the master, put the clone on the device, write
   its ID and the qa host into `.env.qa`. Push once with `deploy.sh qa` and
   confirm the device shows data from the qa Worker (`wrangler tail --env qa`
   shows the poll).
4. **Docs** — READMEs: the environment table, the promotion order, the
   additive rule. Retire the "one Worker serves every account" wording in
   `deploy.sh` and the plugin README, which is no longer true.
5. **Publish** — only after 1–4 are in and one full promotion has been walked
   through on a trivial change. Before submitting: demo data for the
   marketplace preview, and the "Chef" linter's checks (see the recipe
   publishing checklist on the TRMNL blog).

## 7. Not doing

- **A second TRMNL account for qa.** The clone gives the same isolation, the
  profile mechanism already exists, and a second account means a second device
  or constant playlist swapping.
- **A feature flag or query parameter on one Worker.** Every installer's device
  hits that Worker; a slip in the flag leaks half-finished behaviour to all of
  them. Two deployments cannot leak into each other.
- **Versioned API paths (`/v2/rates`).** The additive rule covers every change
  foreseeable now. Paths are the fallback for a change that cannot be made
  additive, and would be a separate plan.
- **Automating the clone.** `trmnlp` has no clone call and `--create` makes an
  empty plugin, not a copy. It is a one-off in the UI.
