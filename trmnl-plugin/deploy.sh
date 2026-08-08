#!/usr/bin/env bash
#
# Deploy the TRMNL plugin (settings + all Liquid views) via trmnlp.
# Runs from anywhere; always operates on this script's directory.
#
# Usage:
#   ./deploy.sh <profile> [trmnlp push args...]
#
#   ./deploy.sh personal          # push to the personal account
#   ./deploy.sh personal --force  # extra args pass through to `trmnlp push`
#
# Each account gets a git-ignored profile file, .env.<profile>, holding the two
# values that differ per account (see .env.example):
#
#   TRMNL_API_KEY     that account's trmnlp key, from https://trmnl.com/account
#   TRMNL_PLUGIN_ID   that account's plugin settings ID
#
# TRMNL_API_KEY is exported so it overrides ~/.config/trmnlp/config.yml, which
# means switching accounts needs no `trmnlp login` and won't clobber the stored
# key. The Worker is shared between accounts, so API_TOKEN is NOT part of a
# profile — it comes from the environment or ../trmnl-worker/.dev.vars.
#
# Prereqs:
#   - `gem install trmnl_preview`
#   - the plugin already created in the TRMNL UI on that account
#   - a .env.<profile> for each account you deploy to
#
# The plugin ID is not a secret, but it IS account-specific and `trmnlp push`
# overwrites src/settings.yml with the server's copy — so the ID lives in the
# profile, not in git. The bearer token IS a secret: it's injected into
# src/settings.yml only for the upload, then reverted so it never lands in git.
#
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  local found
  found="$(ls .env.* 2>/dev/null | grep -v '^\.env\.example$' | sed 's/^\.env\./  /' || true)"
  echo "Usage: $0 <profile> [trmnlp push args...]" >&2
  if [ -n "$found" ]; then
    echo "Profiles found here:" >&2
    echo "$found" >&2
  else
    echo "No .env.<profile> files here yet — copy .env.example to get started." >&2
  fi
  exit 1
}

# --- Resolve the profile (argument wins, else $TRMNL_PROFILE) ---
PROFILE="${1:-${TRMNL_PROFILE:-}}"
[ -n "$PROFILE" ] || usage
[ $# -gt 0 ] && shift

PROFILE_FILE=".env.${PROFILE}"
if [ ! -f "$PROFILE_FILE" ]; then
  echo "Error: no such profile '$PROFILE' ($PROFILE_FILE not found)." >&2
  usage
fi

# shellcheck source=/dev/null
set -a; . "./$PROFILE_FILE"; set +a

# Guard both values: an empty TRMNL_PLUGIN_ID makes `trmnlp push` silently
# CREATE a new plugin rather than update the intended one.
if [ -z "${TRMNL_PLUGIN_ID:-}" ]; then
  echo "Error: TRMNL_PLUGIN_ID not set in $PROFILE_FILE." >&2
  echo "Refusing to push — trmnlp would create a brand new plugin instead." >&2
  exit 1
fi
if [ -z "${TRMNL_API_KEY:-}" ]; then
  echo "Error: TRMNL_API_KEY not set in $PROFILE_FILE." >&2
  exit 1
fi

# --- Resolve the Worker's bearer token (env wins, else the Worker's .dev.vars) ---
ENV_FILE="../trmnl-worker/.dev.vars"
TOKEN="${API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  TOKEN="$(grep -E '^API_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
fi
if [ -z "$TOKEN" ]; then
  echo "Error: API_TOKEN not set (checked env and $ENV_FILE)." >&2
  exit 1
fi

SETTINGS="src/settings.yml"

# Restore the committed (placeholder) settings.yml no matter how we exit, so the
# real token never persists in the working tree — even if push writes it back.
# push also rewrites the file with the server's copy, including that account's
# `id`, so this restore is what keeps the repo account-agnostic too.
BACKUP="$(mktemp)"
cp "$SETTINGS" "$BACKUP"
trap 'mv "$BACKUP" "$SETTINGS"' EXIT

# Inject the real token into the polling_headers line (token only in the
# replacement text, so no regex-escaping needed).
awk -v tok="$TOKEN" '
  /^polling_headers:/ { print "polling_headers: \"Authorization: Bearer " tok "\""; next }
  { print }
' "$BACKUP" > "$SETTINGS"

echo "==> Pushing plugin ${TRMNL_PLUGIN_ID} to TRMNL account '${PROFILE}'..."
trmnlp push --id "$TRMNL_PLUGIN_ID" "$@"
