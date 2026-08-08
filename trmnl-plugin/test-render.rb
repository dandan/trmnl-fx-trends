#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Render every view against known merge variables and assert the output.
#
#   ruby test-render.rb
#
# `trmnlp build` proves the templates compile against real data; this covers the
# states a build can't reach — an upstream error, an empty list, fewer pairs than
# the view has room for. TRMNL prepends shared.liquid to every view, so we do the
# same here.
require "liquid"
require "json"

HERE = __dir__
VIEWS = {
  "full"            => 6,
  "half_horizontal" => 3,
  "half_vertical"   => 6,
  "quadrant"        => 2,
}.freeze
SPARKLINE_VIEWS = %w[full half_horizontal half_vertical].freeze
# half_vertical drops the LO/HI column for width; quadrant has no sparkline.
RANGE_VIEWS = %w[full half_horizontal].freeze

SHARED = File.read(File.join(HERE, "src", "shared.liquid"))
SAMPLE = JSON.parse(File.read(File.join(HERE, "sample.json")))

$failures = 0

def check(label, condition, detail = "")
  puts "  [#{condition ? 'PASS' : 'FAIL'}] #{label}#{detail.empty? ? '' : " — #{detail}"}"
  $failures += 1 unless condition
end

def render(view, vars)
  template = Liquid::Template.parse(SHARED + File.read(File.join(HERE, "src", "#{view}.liquid")))
  out = template.render(vars, strict_variables: false)
  [out, template.errors]
end

def count(haystack, needle)
  haystack.scan(needle).size
end

puts "Rendering #{VIEWS.size} views\n\n"

# ---------------------------------------------------------------- happy path
puts "With #{SAMPLE['rows'].size} pairs of live data:"
VIEWS.each do |view, limit|
  out, errors = render(view, SAMPLE)
  expected_rows = [SAMPLE["rows"].size, limit].min

  check("#{view}: renders without Liquid errors", errors.empty?, errors.join("; "))
  check("#{view}: #{expected_rows} rows", count(out, /class="fx-row"/) == expected_rows,
        "got #{count(out, /class="fx-row"/)}")
  check("#{view}: no NaN/Infinity", !out.match?(/NaN|Infinity/))
  check("#{view}: title_bar present", out.include?("title_bar"))
  # "LATEST", never "TODAY"/"CURRENT": ECB publishes once per working day around
  # 16:00 CET, so the newest figure is yesterday's or Friday's for roughly three
  # quarters of the week. Only "latest" is true in every case.
  if view != "quadrant"
    check("#{view}: rate column is labelled LATEST", out.include?(">LATEST<"))
    check("#{view}: no time-claim the data can't back",
          !out.match?(/>\s*(TODAY|CURRENT|LIVE)\b/i))
    # Headers name their column; the window governs change, trend AND lo/hi, so
    # it is stated once in the title bar instead of pinned to one of them.
    check("#{view}: change column is labelled CHANGE", out.include?(">CHANGE<"))
    check("#{view}: no bare range code in the header row",
          !out.match?(/>\s*\d[MY]\s*</))
  end
  check("#{view}: title bar states the window",
        out.include?(SAMPLE["range_label"]), "expected #{SAMPLE['range_label'].inspect}")
  check("#{view}: no unresolved Liquid", !out.include?("{{") && !out.include?("{%"))
  # Direction is stated explicitly: "GBP -> AUD" reads as "1 GBP buys N AUD".
  # The slash form relies on knowing which currency is being quoted.
  check("#{view}: pairs use the direction arrow", count(out, /&rarr;/) == expected_rows,
        "got #{count(out, /&rarr;/)}")
  check("#{view}: no slash-form pairs left", !out.include?("fx-slash"))

  # Rates split into integer/fraction spans so the decimals line up.
  check("#{view}: #{expected_rows} split rate cells",
        count(out, /class="fx-int"/) == expected_rows &&
        count(out, /class="fx-frac"/) == expected_rows)
  # The int/frac halves must reassemble into exactly the source rate.
  rendered = out.scan(%r{<span class="fx-int">([^<]*)</span><span class="fx-frac">([^<]*)</span>})
                .map { |i, f| "#{i}#{f}" }
  expected = SAMPLE["rows"].first(limit).map { |r| r["rate"].to_s }
  check("#{view}: split cells reassemble to the original rates",
        rendered == expected, "#{rendered.inspect} != #{expected.inspect}")

  # LO/HI are the sparkline's y-axis bounds, so HI must print above LO to match
  # where those values sit in the trace beside them. The original markup had
  # them the other way round, which reads as an upside-down axis.
  if RANGE_VIEWS.include?(view)
    pairs_hi_lo = out.scan(%r{<div class="fx-range"><span>([^<]*)</span><span>([^<]*)</span></div>})
    check("#{view}: HI is printed above LO",
          pairs_hi_lo.all? { |hi, lo| Float(hi) >= Float(lo) },
          pairs_hi_lo.reject { |hi, lo| Float(hi) >= Float(lo) }.inspect)
    expected_hi = SAMPLE["rows"].first(limit).map { |r| r["hi"].to_s }
    check("#{view}: top value is the row's hi", pairs_hi_lo.map(&:first) == expected_hi)
    # The header must read in the same order the values are stacked, or it
    # implies the top number is the low.
    check("#{view}: header reads HI / LO, matching the stacking order",
          out.include?("HI / LO") && !out.include?("LO / HI"))
  end

  if SPARKLINE_VIEWS.include?(view)
    check("#{view}: #{expected_rows} polylines", count(out, /<polyline/) == expected_rows)
    # Every points attribute must be pairs of finite numbers.
    pts = out.scan(/points="([^"]*)"/).flatten
    ok = pts.all? { |p| p.split(" ").all? { |xy| xy.split(",").size == 2 && xy.split(",").all? { |n| Float(n, exception: false) } } }
    check("#{view}: all points parse as coordinates", ok)
  else
    check("#{view}: no sparkline (by design)", count(out, /<polyline/).zero?)
  end
end

# ---------------------------------------------------------------- error state
puts "\nWith a Worker error response:"
error_vars = { "error" => "Frankfurter returned HTTP 503" }
VIEWS.each_key do |view|
  out, errors = render(view, error_vars)
  check("#{view}: renders without Liquid errors", errors.empty?, errors.join("; "))
  check("#{view}: shows the unavailable state", out.include?("Rates unavailable"))
  check("#{view}: no rows", count(out, /class="fx-row"/).zero?)
  check("#{view}: no NaN", !out.match?(/NaN/))
  # With no data there is no window or date to report, so the title bar must not
  # leave dangling separators behind ("· ECB").
  check("#{view}: title bar degrades cleanly", out.include?("No data"))
  check("#{view}: no orphaned separator", !out.match?(/&middot;\s*(ECB)?\s*<\/span>/))
end

# ---------------------------------------------------------------- empty rows
puts "\nWith an empty rows array:"
VIEWS.each_key do |view|
  out, = render(view, { "rows" => [] })
  check("#{view}: falls back to the unavailable state", out.include?("Rates unavailable"))
end

# ------------------------------------------------- fewer pairs than the view holds
puts "\nWith a single pair (fewer than any view's limit):"
one = { "rows" => [SAMPLE["rows"].first], "range" => SAMPLE["range"], "as_of" => SAMPLE["as_of"] }
VIEWS.each_key do |view|
  out, errors = render(view, one)
  check("#{view}: renders one row", count(out, /class="fx-row"/) == 1, errors.join("; "))
end

# ------------------------------------------------------------- negative zero
puts "\nWith an exactly-flat pair (change 0):"
flat = SAMPLE["rows"].first.merge("change_pct" => 0, "points" => "0,15 100,15 200,15")
out, = render("full", { "rows" => [flat], "range" => "1Y", "as_of" => SAMPLE["as_of"] })
check("full: zero change renders as up-arrow, not a minus sign", out.include?("&#9650;") || out.include?("▲"))
check("full: no negative-zero artefact", !out.include?("-0%"))

puts(($failures.zero? ? "\nAll render checks passed." : "\n#{$failures} render check(s) FAILED."))
exit($failures.zero? ? 0 : 1)
