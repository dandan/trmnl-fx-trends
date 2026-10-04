#!/usr/bin/env bash
#
# Screenshot every layout on every device, orientation and mode, and write
# one markdown page per layout under ../docs/screenshots/.
#
#   ./screenshots.sh            # all 48 combinations
#   FIREFOX=/usr/bin/firefox ./screenshots.sh
#
# Starts `trmnlp serve` itself (via ./trmnlp-snap, see README) unless one is
# already answering on port 4567, and stops it again on exit. Renders come
# from the sample baked into .trmnlp.yml, so no token or network is needed
# beyond fetching the framework CSS and fonts.
#
# trmnlp's render route takes the screen classes as a query parameter, which
# is all a device is to the framework: a size class (md/lg), a bit depth and
# an orientation, plus the model's own class for its dimensions. The X's
# screen is transform-scaled 1.8x by the framework, so its window is the
# panel's physical size, not its CSS size.
#
set -euo pipefail
cd "$(dirname "$0")"

FIREFOX="${FIREFOX:-/snap/firefox/current/usr/lib/firefox/firefox}"
[ -x "$FIREFOX" ] || FIREFOX="$(command -v firefox)"
OUT="$(realpath -m ../docs/screenshots)"
PORT=4567

# device: classes / landscape window size (W,H)
DEVICES=(og ogv2 x)
declare -A CLASSES=(
  [og]="screen--og screen--md screen--1bit"
  [ogv2]="screen--ogv2 screen--md screen--2bit"
  [x]="screen--v2 screen--lg screen--4bit"
)
declare -A SIZES=( [og]=800,480 [ogv2]=800,480 [x]=1872,1404 )
declare -A NAMES=( [og]="TRMNL OG (1-bit)" [ogv2]="TRMNL OG (2-bit)" [x]="TRMNL X (4-bit)" )
LAYOUTS=(full half_horizontal half_vertical quadrant)

# --- preview server ---
if ! curl -fs "http://localhost:$PORT/" >/dev/null 2>&1; then
  # setsid puts trmnlp and the puma it spawns in their own process group,
  # so the trap can stop both; killing the wrapper alone leaves puma running.
  setsid ./trmnlp-snap serve >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill -- -"$SERVER" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    curl -fs "http://localhost:$PORT/" >/dev/null 2>&1 && break
    sleep 1
  done
fi

shoot() { # layout device orientation mode
  local layout=$1 dev=$2 orient=$3 mode=$4
  local classes="screen ${CLASSES[$dev]}" size="${SIZES[$dev]}"
  if [ "$orient" = portrait ]; then
    classes="$classes screen--portrait"
    size="${size#*,},${size%,*}"
  fi
  [ "$mode" = dark ] && classes="$classes screen--dark-mode"
  local url="http://localhost:$PORT/render/$layout.html?screen_classes=${classes// /%20}"
  local file="$OUT/$layout/$dev-$orient-$mode.png"
  local profile
  profile="$(mktemp -d)"
  timeout 90 "$FIREFOX" --headless --profile "$profile" --window-size="$size" \
    --screenshot "$file" "$url" >/dev/null 2>&1 || echo "FAILED: $file" >&2
  rm -rf "$profile"
  echo "$file"
}

for layout in "${LAYOUTS[@]}"; do
  mkdir -p "$OUT/$layout"
  page="$OUT/$layout.md"
  {
    echo "# $layout"
    echo
    echo "Rendered from the sample in \`.trmnlp.yml\` by \`trmnl-plugin/screenshots.sh\`."
    echo "Each image is the whole screen at the panel's pixel size; the half and"
    echo "quadrant layouts sit in the mashup frame the device would draw."
    echo
  } > "$page"
  for dev in "${DEVICES[@]}"; do
    echo "## ${NAMES[$dev]}" >> "$page"
    echo >> "$page"
    for orient in landscape portrait; do
      for mode in light dark; do
        shoot "$layout" "$dev" "$orient" "$mode"
        echo "### $orient, $mode" >> "$page"
        echo >> "$page"
        echo "![$layout on ${NAMES[$dev]}, $orient, $mode]($layout/$dev-$orient-$mode.png)" >> "$page"
        echo >> "$page"
      done
    done
  done
done

{
  echo "# Screenshots"
  echo
  echo "Every layout on every device, orientation and mode, as a record of what"
  echo "the plugin looks like at a given commit. Regenerate with"
  echo "\`trmnl-plugin/screenshots.sh\`."
  echo
  for layout in "${LAYOUTS[@]}"; do echo "- [$layout]($layout.md)"; done
} > "$OUT/README.md"
