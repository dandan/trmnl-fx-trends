#!/usr/bin/env bash
#
# Deploy the Cloudflare Worker (the API).
# Runs from anywhere; always operates on this script's directory.
#
# Usage:
#   ./deploy.sh qa              # test, then deploy the QA Worker
#   ./deploy.sh prod            # test, then deploy the production Worker
#
# The environment is required: a bare `./deploy.sh` used to mean production,
# and once the plugin is a published recipe that is the one deploy every
# installer sees. QA is a wrangler environment (see wrangler.toml); your device
# polls it, nobody else does. Promotion order is in docs/build_multi_deploy.md.
#
# Prereqs:
#   - npm install
#   - npx wrangler login          (first time only)
#
# One secret per environment, set once (see wrangler.toml):
#   npx wrangler secret put FXRATES_API_KEY [--env qa]
# Without it the Worker serves the ECB series alone. Access control needs
# nothing: it is the TRMNL IP allowlist, fetched at runtime. See src/allowlist.js.
#
# Tests run first: the Worker has no staging environment, and a broken deploy
# shows up as a blank sparkline on the device rather than an error.
#
# The deploy is stamped with `git describe --tags --dirty` (e.g. v1.0.0,
# v1.0.0-3-gabc1234, or v1.0.0-dirty) and the Worker reports it at `/`, so
# "what is production running?" is a curl:
#   curl https://exchange-rates-trmnl.<subdomain>.workers.dev/ | grep version
# Before the first tag it reports the bare commit hash. Versioning is one tag
# per production promotion; see docs/build_multi_deploy.md §8.
#
set -euo pipefail
cd "$(dirname "$0")"

ENV="${1:-}"
case "$ENV" in
  qa)   DEPLOY=deploy:qa ;;
  prod) DEPLOY=deploy ;;
  *)
    echo "Usage: $0 qa|prod [wrangler deploy args...]" >&2
    exit 1 ;;
esac
shift

VERSION="$(git describe --tags --dirty --always)"

echo "==> Running tests..."
npm test

echo "==> Deploying Worker to Cloudflare (${ENV}, ${VERSION})..."
npm run "$DEPLOY" -- --var "VERSION:${VERSION}" "$@"
