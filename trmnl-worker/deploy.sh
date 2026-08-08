#!/usr/bin/env bash
#
# Deploy the Cloudflare Worker (the API).
# Runs from anywhere; always operates on this script's directory.
#
# Usage:
#   ./deploy.sh                 # test, then deploy
#   ./deploy.sh --set-secret    # also push API_TOKEN from .prod.vars first
#
# Prereqs:
#   - npm install
#   - npx wrangler login          (first time only)
#   - a .prod.vars holding the deployed Worker's API_TOKEN (see .prod.vars.example)
#
# Tests run first: the Worker has no staging environment, and a broken deploy
# shows up as a blank sparkline on the device rather than an error.
#
set -euo pipefail
cd "$(dirname "$0")"

# --set-secret is ours; everything else is forwarded to `wrangler deploy`.
SET_SECRET=false
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--set-secret" ]; then SET_SECRET=true; else ARGS+=("$arg"); fi
done
set -- ${ARGS[@]+"${ARGS[@]}"}

echo "==> Running tests..."
npm test

# Provision Cloudflare from the SAME file ../trmnl-plugin/deploy.sh reads, so the
# token this Worker checks against and the one in the plugin's polling header
# cannot drift. When they do drift the only symptom is a silent 401 behind
# "Rates unavailable" on the device, with nothing on screen to explain it.
if [ "$SET_SECRET" = true ]; then
  TOKEN_FILE=".prod.vars"
  if [ ! -f "$TOKEN_FILE" ]; then
    echo "Error: $TOKEN_FILE not found." >&2
    echo "       cp .prod.vars.example $TOKEN_FILE, then set" >&2
    echo "       API_TOKEN=\$(openssl rand -hex 32) in it." >&2
    exit 1
  fi
  TOKEN="$(grep -E '^API_TOKEN=' "$TOKEN_FILE" | head -1 | cut -d= -f2-)"
  if [ -z "$TOKEN" ] || [ "$TOKEN" = "replace-me" ]; then
    echo "Error: API_TOKEN in $TOKEN_FILE is empty or still the placeholder." >&2
    exit 1
  fi
  echo "==> Setting the Cloudflare secret from $TOKEN_FILE..."
  # printf, not echo: echo would append a newline and store it in the secret,
  # so the header sent by the plugin would no longer match byte for byte.
  printf '%s' "$TOKEN" | npx wrangler secret put API_TOKEN
fi

echo "==> Deploying Worker to Cloudflare..."
npm run deploy "$@"
