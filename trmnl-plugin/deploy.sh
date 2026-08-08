#!/usr/bin/env bash
#
# Deploy the TRMNL plugin (settings + all Liquid views) via trmnlp.
# Runs from anywhere; always operates on this script's directory.
#
# Usage:
#   ./deploy.sh <profile> [trmnlp push args...]
#   ./deploy.sh <profile> --create        # first time on an account
#
#   ./deploy.sh personal            # push to an existing plugin
#   ./deploy.sh personal --create   # create the plugin, then push to it
#   ./deploy.sh personal --force    # extra args pass through to `trmnlp push`
#
# --create replaces the whole manual first-time setup. `trmnlp push` with no
# plugin ID POSTs /api/plugin_settings to create a private plugin, then uploads
# src/ as a zip — so settings.yml carries the strategy, polling URL, headers and
# form fields, and src/*.liquid carries the markup for all four views. Nothing
# needs pasting into the web UI. The new ID is written back into the profile.
#
# The one step that stays manual is adding the plugin to a device playlist;
# trmnlp has no API for that, and it prints a reminder.
#
# Each account gets a git-ignored profile file, .env.<profile>, holding the two
# values that differ per account (see .env.example):
#
#   TRMNL_API_KEY     that account's trmnlp key, from https://trmnl.com/account
#   TRMNL_PLUGIN_ID   that account's plugin settings ID (filled in by --create)
#
# TRMNL_API_KEY is exported so it overrides ~/.config/trmnlp/config.yml, which
# means switching accounts needs no `trmnlp login` and won't clobber the stored
# key. The Worker is shared between accounts, so API_TOKEN is NOT part of a
# profile — it comes from the environment or ../trmnl-worker/.prod.vars.
#
# The Worker host in polling_url is committed in src/settings.yml. It is not a
# secret, one Worker serves every account, and it only changes if the Worker is
# renamed — so it is not parameterised here.
#
# Prereqs:
#   - `gem install trmnl_preview`
#   - a .env.<profile> with TRMNL_API_KEY (TRMNL_PLUGIN_ID only for non-create)
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
  echo "Usage: $0 <profile> [--create] [trmnlp push args...]" >&2
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

# --- Pull --create out of the args; the rest pass through to trmnlp ---
CREATE=false
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--create" ]; then CREATE=true; else ARGS+=("$arg"); fi
done
set -- ${ARGS[@]+"${ARGS[@]}"}

# shellcheck source=/dev/null
set -a; . "./$PROFILE_FILE"; set +a

# Write a key back into the profile, replacing it if already present.
persist_kv() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$PROFILE_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$PROFILE_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$PROFILE_FILE"
  fi
}

if [ -z "${TRMNL_API_KEY:-}" ]; then
  echo "Error: TRMNL_API_KEY not set in $PROFILE_FILE." >&2
  exit 1
fi

if [ "$CREATE" = true ]; then
  # Refuse to create a second plugin for an account that already has one. This
  # is the mirror of the guard below: creation is only safe when there is no ID.
  if [ -n "${TRMNL_PLUGIN_ID:-}" ]; then
    echo "Error: TRMNL_PLUGIN_ID is already set in $PROFILE_FILE (${TRMNL_PLUGIN_ID})." >&2
    echo "Refusing to --create; that would leave a duplicate plugin on the account." >&2
    echo "Drop the line from the profile first if you really want a new one." >&2
    exit 1
  fi
else
  # An empty TRMNL_PLUGIN_ID makes `trmnlp push` silently CREATE a new plugin
  # rather than update the intended one — hence --create being explicit.
  if [ -z "${TRMNL_PLUGIN_ID:-}" ]; then
    echo "Error: TRMNL_PLUGIN_ID not set in $PROFILE_FILE." >&2
    echo "Refusing to push — trmnlp would create a brand new plugin instead." >&2
    echo "For a first-time setup on this account, run: $0 $PROFILE --create" >&2
    exit 1
  fi
fi

# --- Resolve the DEPLOYED Worker's bearer token (env wins, else .prod.vars) ---
#
# .prod.vars, not .dev.vars: the latter is wrangler's local-development file and
# every key in it is injected into `wrangler dev`, so the production token does
# not belong there. It is also not in .env.<profile>, because one Worker serves
# every TRMNL account — the token is project-scoped, not account-scoped.
#
# The same file feeds `../trmnl-worker/deploy.sh --set-secret`, so the value
# Cloudflare checks and the value in this polling header have one source.
TOKEN_FILE="../trmnl-worker/.prod.vars"
TOKEN="${API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(grep -E '^API_TOKEN=' "$TOKEN_FILE" | head -1 | cut -d= -f2-)"
fi
if [ -z "$TOKEN" ] || [ "$TOKEN" = "replace-me" ]; then
  echo "Error: no production API_TOKEN (checked \$API_TOKEN and $TOKEN_FILE)." >&2
  echo "       cp ../trmnl-worker/.prod.vars.example ../trmnl-worker/.prod.vars" >&2
  echo "       then set API_TOKEN=\$(openssl rand -hex 32) in it, and run" >&2
  echo "       ../trmnl-worker/deploy.sh --set-secret to push it to Cloudflare." >&2
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
#
# Only the token is substituted here. polling_url is committed with the real
# Worker host: it is not a secret, it is the same for every account (one Worker
# serves them all), and it changes only if the Worker is renamed — so it lives
# in settings.yml where it is used, not in a per-account profile.
awk -v tok="$TOKEN" '
  /^polling_headers:/ { print "polling_headers: \"Authorization: Bearer " tok "\""; next }
  { print }
' "$BACKUP" > "$SETTINGS"

if [ "$CREATE" = true ]; then
  echo "==> Creating a new plugin on TRMNL account '${PROFILE}'..."
  # No --id: trmnlp POSTs /api/plugin_settings to create a private plugin, then
  # uploads src/ as a zip. It deletes the new plugin itself if the upload fails.
  # Capture stdout to recover the new ID while still showing progress.
  OUT="$(trmnlp push "$@" 2>&1 | tee /dev/stderr)"
  NEW_ID="$(printf '%s\n' "$OUT" | grep -oE 'plugin_settings/[0-9]+/edit' | head -1 | grep -oE '[0-9]+')"

  if [ -z "$NEW_ID" ]; then
    echo "Error: plugin was pushed but no ID could be parsed from the output." >&2
    echo "Find it in the dashboard URL and add TRMNL_PLUGIN_ID to $PROFILE_FILE." >&2
    exit 1
  fi

  persist_kv TRMNL_PLUGIN_ID "$NEW_ID"

  echo
  echo "==> Created plugin ${NEW_ID}; wrote TRMNL_PLUGIN_ID into ${PROFILE_FILE}."
  echo "    From now on use: $0 $PROFILE"
  echo "    Remaining manual step — add it to a device playlist:"
  echo "    https://trmnl.com/playlists"
else
  echo "==> Pushing plugin ${TRMNL_PLUGIN_ID} to TRMNL account '${PROFILE}'..."
  trmnlp push --id "$TRMNL_PLUGIN_ID" "$@"
fi
