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
  check("#{view}: no unresolved Liquid", !out.include?("{{") && !out.include?("{%"))
  # Direction is stated explicitly: "GBP -> AUD" reads as "1 GBP buys N AUD".
  # The slash form relies on knowing which currency is being quoted.
  check("#{view}: pairs use the direction arrow", count(out, /&rarr;/) == expected_rows,
        "got #{count(out, /&rarr;/)}")
  check("#{view}: no slash-form pairs left", !out.include?("fx-slash"))

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
