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
require "date"

HERE = __dir__
VIEWS = {
  "full"            => 6,
  "half_horizontal" => 3,
  "half_vertical"   => 6,
  "quadrant"        => 3,
}.freeze
SPARKLINE_VIEWS = VIEWS.keys.freeze
# Only the wide views carry HI/LO; half_vertical and quadrant drop it for width.
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

# The footer's date form: day without leading zero, three-letter month, year.
def fmt(iso, year: true)
  Date.parse(iso).strftime(year ? "%-d %b %Y" : "%-d %b")
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
  # The footer states the window the data covers, first business day to last,
  # printed as `5 Sep 2025 -> 4 Sep 2026`: month names rather than ISO, since
  # numeric day-month is the one form readers disagree on. The data stays ISO.
  check("#{view}: title bar spans start_date to as_of",
        out.include?("#{fmt(SAMPLE['start_date'])} &rarr; #{fmt(SAMPLE['as_of'])}"),
        out[%r{<span class="instance">(.*?)</span>}m, 1].to_s.gsub(/\s+/, " ").strip)
  check("#{view}: footer carries no raw ISO date", !out.match?(/\d{4}-\d{2}-\d{2}/))
  # "LATEST", never "TODAY"/"CURRENT": ECB publishes once per working day around
  # 16:00 CET, so the newest figure is yesterday's or Friday's for roughly three
  # quarters of the week. Only "latest" is true in every case.
  # The pair column is headed too, so the header row starts where the data does.
  check("#{view}: pair column is labelled PAIR", out.include?(">PAIR<"))
  check("#{view}: rate column is labelled LATEST", out.include?(">LATEST<"))
  check("#{view}: no time-claim the data can't back",
        !out.match?(/>\s*(TODAY|CURRENT|LIVE)\b/i))
  # Headers name their column; the window governs change, trend AND hi/lo, so
  # it is stated once, on TREND, and nowhere else.
  check("#{view}: change column is labelled CHANGE", out.include?(">CHANGE<"))
  check("#{view}: no bare range code in the header row",
        !out.match?(/>\s*\d[MY]\s*</))
  check("#{view}: TREND header states the window",
        out.include?(">#{SAMPLE['range_label']} TREND<"),
        "expected \">#{SAMPLE['range_label']} TREND<\"")
  check("#{view}: the window is stated once", count(out, /#{SAMPLE['range_label']}/) == 1,
        "got #{count(out, /#{SAMPLE['range_label']}/)}")
  check("#{view}: no unresolved Liquid", !out.include?("{{") && !out.include?("{%"))
  # Direction is stated explicitly: "GBP -> AUD" reads as "1 GBP buys N AUD".
  # The slash form relies on knowing which currency is being quoted.
  check("#{view}: pairs use the direction arrow",
        count(out, /class="fx-arrow"/) == expected_rows,
        "got #{count(out, /class=\"fx-arrow\"/)}")
  check("#{view}: no slash-form pairs left", !out.include?("fx-slash"))

  # The change is quoted signed, to a fixed 2dp, so the column lines up and reads
  # as arithmetic (see shape.js). The view must print change_str verbatim: `| abs`
  # or `| round` here would drop the sign, or the trailing zero it carries.
  # The figure sits in a .fx-pill (filled or outlined); the pill is styling, so it is
  # stripped here and the text inside it is what has to match.
  cells = out.scan(%r{<div class="fx-chg">(.*?)</div>}m).flatten
  check("#{view}: every change sits in a pill",
        cells.all? { |c| c.match?(%r{\A\s*<span class="fx-pill[^"]*">[^<]*</span>\s*\z}) })
  changes = cells.map { |c| c.gsub(/<[^>]+>/, "").strip }
  # A fall is a filled pill, a rise an outlined one; the sign decides, so the
  # two never disagree.
  check("#{view}: falls are filled and rises outlined",
        cells.zip(changes).all? { |c, f| c.include?("fx-pill--down") == f.start_with?("-") })
  # The fill is the framework's own black/white utilities, which dark mode
  # swaps; a literal colour here would not follow it.
  check("#{view}: filled pills use the framework's bg/text utilities",
        cells.all? { |c| !c.include?("fx-pill--down") || (c.include?("bg--black") && c.include?("text--white")) })
  check("#{view}: dates use text--default", out.include?('class="fx-dates text--default"'))
  fig = /\A([+-]?\d+\.\d{2})%\z/m
  check("#{view}: every change is signed and 2dp",
        changes.all? { |c| c.match?(fig) },
        changes.reject { |c| c.match?(fig) }.inspect)
  # The sign is the only direction marker: a ▲/▼ beside it would say the same
  # thing twice, in a mark that reads as decoration at this size.
  check("#{view}: no direction glyph beside the figure",
        !out.include?("&#9650;") && !out.include?("&#9660;") && !out.match?(/[\u25b2\u25bc]/))

  # One cell per rate, printed verbatim. The decimals are deliberately not
  # aligned (see shared.liquid), so there is no split markup to reassemble —
  # what matters is that the cell carries exactly what the Worker sent.
  rendered = out.scan(%r{<div class="fx-rate">([^<]*)</div>}).flatten.map(&:strip)
  expected = SAMPLE["rows"].first(limit).map { |r| r["rate_str"] }
  check("#{view}: #{expected_rows} rate cells", rendered.size == expected_rows,
        "got #{rendered.size}")
  check("#{view}: rate cells print rate_str unaltered",
        rendered == expected, "#{rendered.inspect} != #{expected.inspect}")

  # LO/HI are the sparkline's y-axis bounds, so HI must print above LO to match
  # where those values sit in the trace beside them. The original markup had
  # them the other way round, which reads as an upside-down axis.
  if RANGE_VIEWS.include?(view)
    pairs_hi_lo = out.scan(%r{<div class="fx-range"><span>([^<]*)</span><span>([^<]*)</span></div>})
    check("#{view}: HI is printed above LO",
          pairs_hi_lo.all? { |hi, lo| Float(hi) >= Float(lo) },
          pairs_hi_lo.reject { |hi, lo| Float(hi) >= Float(lo) }.inspect)
    expected_hi = SAMPLE["rows"].first(limit).map { |r| r["hi_str"] }
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
    # The end dot is positioned HTML, never an svg shape: a <circle> or <line>
    # inside a preserveAspectRatio="none" box is squashed with it.
    check("#{view}: no marker drawn inside the svg",
          !out.include?("<line") && !out.include?("<circle"))
    check("#{view}: one end dot per row", count(out, /class="fx-dot"/) == expected_rows)
    # The dot's y is the last point's y as a percentage of the 30px box; the
    # Worker pads the box by 2px, so every value lands strictly inside 0..100.
    tops = out.scan(/class="fx-dot" style="top: ([^"%]*)%"/).flatten
    check("#{view}: every dot lands inside the plot",
          tops.size == expected_rows && tops.all? { |t| (v = Float(t, exception: false)) && v > 0 && v < 100 },
          tops.inspect)
    last_ys = pts.map { |p| p.split(" ").last.split(",").last.to_f }
    check("#{view}: each dot sits on its trace's last point",
          tops.map(&:to_f).zip(last_ys).all? { |t, y| (t - y / 30 * 100).abs < 0.05 })
  else
    check("#{view}: no sparkline (by design)", count(out, /<polyline/).zero?)
  end
end

# A response can carry a single day (a fresh 1M window over a holiday week), and
# an older Worker sends no start_date at all. Neither may print a dangling arrow.
puts "\nWith one date, and with no start_date:"
as_of = fmt(SAMPLE["as_of"])
VIEWS.each_key do |view|
  same = SAMPLE.merge("start_date" => SAMPLE["as_of"])
  out, = render(view, same)
  check("#{view}: a single-day window prints one date",
        out.include?(as_of) && !out.include?("&rarr; #{as_of}"))

  out, = render(view, SAMPLE.reject { |k, _| k == "start_date" })
  check("#{view}: a missing start_date prints one date",
        out.include?(as_of) && !out.include?("&rarr; #{as_of}"))
end

# A window inside one year prints the year once, on the end date: a 1M window
# reads `5 Aug -> 4 Sep 2026`, not `5 Aug 2026 -> 4 Sep 2026`.
puts "\nWith a window inside one year:"
VIEWS.each_key do |view|
  one_month = SAMPLE.merge("start_date" => "2026-08-05")
  out, = render(view, one_month)
  check("#{view}: same-year window prints the year once",
        out.include?("#{fmt('2026-08-05', year: false)} &rarr; #{as_of}") &&
        !out.include?("#{fmt('2026-08-05')} &rarr;"))
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
  # With no data there is no date to report, so the title bar must not leave a
  # separator stranded at either end of the cell ("· ECB", or a leading dot).
  check("#{view}: title bar degrades cleanly", out.include?("No data"))
  instance = out[%r{<span class="instance">(.*?)</span>}m, 1].to_s.strip
  check("#{view}: no orphaned separator",
        !instance.match?(/\A&middot;/) && !instance.match?(/&middot;\s*(ECB)?\z/),
        instance)
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

# ---------------------------------------------------------------- flat pairs
# change_pct is rounded to 2dp upstream, so 0% means "moved less than 0.005%",
# not "did not move". Neither arrow can be claimed for that, in any view.
puts "\nWith an exactly-flat pair (change 0):"
flat = SAMPLE["rows"].first.merge("change_pct" => 0, "change_str" => "0.00",
                                  "points" => "0,15 100,15 200,15")
VIEWS.each_key do |view|
  out, = render(view, { "rows" => [flat], "range" => "1Y", "as_of" => SAMPLE["as_of"] })
  cell = out[%r{<div class="fx-chg">(.*?)</div>}m, 1].to_s.gsub(/<[^>]+>/, "").strip
  check("#{view}: zero change carries no sign", !cell.match?(/[+-]/))
  check("#{view}: zero change is outlined, not filled", !out.match?(/class="fx-pill[^"]*fx-pill--down/))
  # Nothing takes the arrow's place: a dash there reads as "minus 0%".
  check("#{view}: the change cell holds an unsigned figure alone",
        cell == "0.00%", cell.inspect)
  check("#{view}: no negative-zero artefact", !out.include?("-0%"))
end

# A rounded -0.00 arrives as the float -0.0, which is neither > 0 nor < 0, so it
# takes the flat branch too rather than falling through to a down arrow.
out, = render("full", { "rows" => [flat.merge("change_pct" => -0.0)],
                        "range" => "1Y", "as_of" => SAMPLE["as_of"] })
check("full: negative zero is flat, not a negative", !out.include?("-0.00"))

puts(($failures.zero? ? "\nAll render checks passed." : "\n#{$failures} render check(s) FAILED."))
exit($failures.zero? ? 0 : 1)
