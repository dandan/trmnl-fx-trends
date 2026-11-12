#!/usr/bin/env bash
#
# Screenshot every layout on every device, orientation and mode, and write
# one markdown page per layout under ../docs/screenshots/, plus index.html,
# an overview of all 24 layouts on one page, numbered 1-24.
#
#   ./screenshots.sh            # all 48 combinations
#   FIREFOX=/usr/bin/firefox ./screenshots.sh
#   PAGES_ONLY=1 ./screenshots.sh   # rewrite the pages, keep the images
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
if [ -n "${PAGES_ONLY:-}" ]; then
  :
elif ! curl -fs "http://localhost:$PORT/" >/dev/null 2>&1; then
  # setsid puts trmnlp and the puma it spawns in their own process group,
  # so the trap can stop both; killing the wrapper alone leaves puma running.
  setsid ./trmnlp-snap serve >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill -- -"$SERVER" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    curl -fs "http://localhost:$PORT/" >/dev/null 2>&1 && break
    sleep 1
  done
  # Firefox screenshots its own "unable to connect" page as readily as the
  # plugin, so without this a server that never started would overwrite all
  # 48 committed images with error pages.
  if ! curl -fs "http://localhost:$PORT/" >/dev/null 2>&1; then
    echo "The preview server did not answer on port $PORT; no screenshots taken." >&2
    exit 1
  fi
fi

FAILED=0

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
  [ -n "${PAGES_ONLY:-}" ] && return 0
  local profile
  profile="$(mktemp -d)"
  # Checked before each shot as well: a server that dies part-way would
  # otherwise turn every later image into an error page. Shot to a temporary
  # file, so a failure leaves the committed image as it was.
  if curl -fs -o /dev/null "$url" && timeout 90 "$FIREFOX" --headless --profile "$profile" \
      --window-size="$size" --screenshot "$file.new" "$url" >/dev/null 2>&1 && [ -s "$file.new" ]; then
    mv "$file.new" "$file"
    echo "$file"
  else
    rm -f "$file.new"
    echo "FAILED: $file" >&2
    FAILED=$((FAILED + 1))
  fi
  rm -rf "$profile"
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
  echo "[\`index.html\`](index.html) shows all 24 layouts on one page, numbered"
  echo "1-24, with a switch between light and dark. GitHub lists it as source, so"
  echo "open it from a checkout."
  echo
  for layout in "${LAYOUTS[@]}"; do echo "- [$layout]($layout.md)"; done
} > "$OUT/README.md"

# --- overview page ---
# A layout is a view on a device in an orientation: 4 x 3 x 2 = 24, numbered
# in the order of the loops above. Light and dark are the same layout, so they
# share a number and the page switches between them. Each device is a column,
# landscape above portrait, and a portrait image is as wide as its panel is
# tall, so both orientations of a device are drawn at one scale.
{
  cat <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FX Trends layouts</title>
<style>
  :root { color-scheme: light dark; --bg: #f2f2f0; --fg: #1a1a1a; --dim: #666; --line: #c8c8c4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1b1c; --fg: #ececec; --dim: #9a9a9a; --line: #444; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg);
         font: 15px/1.45 system-ui, sans-serif; }
  main { max-width: 1500px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; justify-content: space-between; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 17px; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  p { margin: 6px 0 0; color: var(--dim); max-width: 70ch; }
  label { cursor: pointer; white-space: nowrap; }
  .devices { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; align-items: start; }
  figure { margin: 0 0 20px; }
  figcaption { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; color: var(--dim); }
  figcaption b { color: var(--fg); font-size: 18px; font-variant-numeric: tabular-nums; min-width: 1.6em; }
  img { display: block; width: 100%; height: auto; border: 1px solid var(--line); }
  .portrait img { width: 60%; }
  .x .portrait img { width: 75%; }
</style>
</head>
<body>
<main>
<header>
  <div>
    <h1>FX Trends layouts</h1>
    <p>Every view on every device and orientation, from the sample in <code>.trmnlp.yml</code>.
       Written by <code>trmnl-plugin/screenshots.sh</code>. Select an image to open it at full size.</p>
  </div>
  <label><input type="checkbox" id="dark"> Dark mode screenshots</label>
</header>
HTML
  n=0
  for layout in "${LAYOUTS[@]}"; do
    echo "<h2>$layout</h2>"
    echo '<div class="devices">'
    for dev in "${DEVICES[@]}"; do
      cls=og; [ "$dev" = x ] && cls=x
      echo "  <div class=\"$cls\">"
      for orient in landscape portrait; do
        n=$((n + 1))
        src="$layout/$dev-$orient-light.png"
        echo "    <figure class=\"$orient\" id=\"layout-$n\"><figcaption><b>$n</b> ${NAMES[$dev]}, $orient</figcaption>"
        echo "      <a href=\"$src\"><img src=\"$src\" alt=\"Layout $n: $layout on ${NAMES[$dev]}, $orient\" loading=\"lazy\"></a></figure>"
      done
      echo "  </div>"
    done
    echo "</div>"
  done
  cat <<'HTML'
</main>
<script>
  document.getElementById("dark").addEventListener("change", (e) => {
    const [from, to] = e.target.checked ? ["-light.png", "-dark.png"] : ["-dark.png", "-light.png"];
    for (const img of document.images) {
      img.src = img.getAttribute("src").replace(from, to);
      img.parentElement.href = img.getAttribute("src");
    }
  });
</script>
</body>
</html>
HTML
} > "$OUT/index.html"

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED screenshot(s) failed; those images were left as they were." >&2
  exit 1
fi
