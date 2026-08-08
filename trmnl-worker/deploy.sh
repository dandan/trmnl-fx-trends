#!/usr/bin/env bash
#
# Deploy the Cloudflare Worker (the API).
# Runs from anywhere; always operates on this script's directory.
#
# Prereqs:
#   - npm install
#   - npx wrangler login          (first time only)
#   - npx wrangler secret put API_TOKEN
#
# Tests run first: the Worker has no staging environment, and a broken deploy
# shows up as a blank sparkline on the device rather than an error.
#
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Running tests..."
npm test

echo "==> Deploying Worker to Cloudflare..."
npm run deploy "$@"
