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
# installer sees. QA is a wrangler environment (see wrangler.toml); my device
# polls it, nobody else does. Promotion order is in docs/build_multi_deploy.md.
#
# Prereqs:
#   - npm install
#   - npx wrangler login          (first time only)
#
# No secrets to provision: access control is the TRMNL IP allowlist, which the
# Worker fetches at runtime. See src/allowlist.js.
#
# Tests run first: the Worker has no staging environment, and a broken deploy
# shows up as a blank sparkline on the device rather than an error.
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

echo "==> Running tests..."
npm test

echo "==> Deploying Worker to Cloudflare (${ENV})..."
npm run "$DEPLOY" -- "$@"
