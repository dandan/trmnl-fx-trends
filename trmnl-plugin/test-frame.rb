#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Render every view the way TRMNL's screen generator does and assert the
# sparkline has a height.
#
#   ruby test-frame.rb
#   FIREFOX=/usr/bin/firefox ruby test-frame.rb
#
# test-render.rb checks the markup; this checks what a browser makes of it, in
# the one environment the markup editor and trmnlp do not reproduce. TRMNL
# draws each mashup slot in a frame of its own, sized to the slot, and in that
# frame the framework's --screen-h is `100%` rather than a pixel length. A plot
# height built on --screen-h resolved to 0px there: the device showed the end
# dot and no trace, while every preview looked right.
#
# The frame below is a reconstruction, not TRMNL's own page. A diagnostic
# printed by the generator (Firefox, November 2026) gave the frame size, the
# screen classes, --screen-h and the box heights for half_horizontal on an X;
# the frame here fills its window with the view the same way and lands within
# 1px of those heights (a 75px trace against the generator's 76px).
#
# The other slots were not measured on the generator, only seen: its images of
# all six X layouts, landscape and portrait, show the view filling its slot.
# In portrait the framework sizes a mashup view from --screen-h again
# (.screen--portrait resets --half_horizontal-h and its siblings), which in a
# frame would make the view half the slot; the generator's images show that
# does not happen, so the frame pins those variables to 100%. How the generator
# does it is not known. The check is the row spacing: in the X's portrait slots
# the rows here are 131, 151 and 133px apart, and in the generator's images
# 132, 152 and 133px. The OG slots have not been seen on the generator at all.
#
# Needs the network (the framework's CSS and JS come from trmnl.com) and a
# Firefox; selenium-webdriver arrives with the trmnl_preview gem.
gem "trmnl_preview"
require "selenium-webdriver"
require "liquid"
require "json"
require "tmpdir"
require "fileutils"

HERE = __dir__
SAMPLE = JSON.parse(File.read(File.join(HERE, "sample.json")))
SHARED = File.read(File.join(HERE, "src", "shared.liquid"))
FIREFOX = ENV["FIREFOX"] || "/snap/firefox/current/usr/lib/firefox/firefox"

# Only the three mashup views: a slot's frame is what the diagnostic described.
# How the generator frames a full view has not been observed, and the full view
# drew its traces on the device before this was fixed, so it is left out
# rather than tested against a guess.
# The generator's screen classes for each device, and the slot each view gets
# on it in CSS px: the screen less the mashup's gutters. Portrait is the same
# screen turned, with screen--portrait added.
DEVICES = {
  "TRMNL X" => {
    classes: "screen screen--v2 screen--4bit screen--density-2x screen--lg screen--fonts-trmnl",
    slots: { "half_horizontal" => [1020, 375],
             "half_vertical" => [505, 760], "quadrant" => [505, 375] },
  },
  "TRMNL X portrait" => {
    classes: "screen screen--v2 screen--4bit screen--density-2x screen--lg screen--fonts-trmnl screen--portrait",
    slots: { "half_horizontal" => [760, 505],
             "half_vertical" => [375, 1020], "quadrant" => [375, 505] },
  },
  "TRMNL OG" => {
    classes: "screen screen--og screen--1bit screen--md",
    slots: { "half_horizontal" => [780, 225],
             "half_vertical" => [385, 460], "quadrant" => [385, 225] },
  },
  "TRMNL OG portrait" => {
    classes: "screen screen--og screen--1bit screen--md screen--portrait",
    slots: { "half_horizontal" => [460, 385],
             "half_vertical" => [225, 780], "quadrant" => [225, 385] },
  },
}.freeze

# The shortest trace worth calling one. The smallest any layout budgets is
# 22px (half_horizontal on an OG); the failure this guards against is 0.
MIN_PLOT = 15

def frame(view, classes)
  body = Liquid::Template.parse(SHARED + File.read(File.join(HERE, "src", "#{view}.liquid"))).render(SAMPLE)
  <<~HTML
    <!doctype html>
    <html><head>
    <link rel="stylesheet" href="https://trmnl.com/css/latest/plugins.css"/>
    <script src="https://trmnl.com/js/latest/plugins.js"></script>
    <style>html, body { height: 100%; margin: 0; overflow: hidden; } .trmnl .screen.screen { --screen-w: 100%; --screen-h: 100%; --half_horizontal-w: 100%; --half_horizontal-h: 100%; --half_vertical-w: 100%; --half_vertical-h: 100%; --quadrant-w: 100%; --quadrant-h: 100%; padding: 0; transform: none; }</style>
    </head><body class="environment trmnl">
    <div class="#{classes}"><div class="view view--#{view}">#{body}</div></div>
    </body></html>
  HTML
end

MEASURE = <<~JS
  const doc = arguments[0].contentDocument;
  const rows = [...doc.querySelectorAll('.fx-row')].filter(e => e.offsetParent);
  const plots = rows.map(r => r.querySelector('.fx-plot').getBoundingClientRect().height);
  const bar = doc.querySelector('.title_bar').getBoundingClientRect();
  return {
    rows: rows.length,
    plot: Math.round(Math.min(...plots)),
    gap: Math.round(bar.top - rows[rows.length - 1].getBoundingClientRect().bottom),
    pitch: Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top),
    screen_h: getComputedStyle(doc.querySelector('.screen')).getPropertyValue('--screen-h').trim(),
  };
JS

failures = 0
check = lambda do |label, ok, detail|
  puts "  [#{ok ? 'PASS' : 'FAIL'}] #{label} — #{detail}"
  failures += 1 unless ok
end

# Under _build/ (git-ignored) rather than /tmp: a snap-packaged Firefox has a
# /tmp of its own and cannot read ours.
FileUtils.mkdir_p(File.join(HERE, "_build"))
Dir.mktmpdir("fx-frame", File.join(HERE, "_build")) do |dir|
  frames = DEVICES.flat_map do |device, spec|
    spec[:slots].map do |view, (w, h)|
      file = "#{device.downcase.tr(' ', '-')}-#{view}.html"
      File.write(File.join(dir, file), frame(view, spec[:classes]))
      { device: device, view: view, file: file, w: w, h: h }
    end
  end
  host = frames.map { |f| %(<iframe src="#{f[:file]}" width="#{f[:w]}" height="#{f[:h]}" frameborder="0"></iframe>) }.join("\n")
  File.write(File.join(dir, "host.html"), "<!doctype html><html><body>#{host}</body></html>")

  opts = Selenium::WebDriver::Firefox::Options.new
  opts.binary = FIREFOX if File.executable?(FIREFOX)
  opts.add_argument("-headless")
  driver = Selenium::WebDriver.for(:firefox, options: opts)
  begin
    driver.get("file://#{File.join(dir, 'host.html')}")
    sleep 3 # the framework's script lays the screen out after load
    puts "In a frame per slot, as TRMNL's screen generator draws them:"
    driver.find_elements(tag_name: "iframe").zip(frames).each do |el, f|
      m = driver.execute_script(MEASURE, el)
      name = "#{f[:device]} #{f[:view]} (#{f[:w]}x#{f[:h]})"
      check.call("#{name}: --screen-h is not a length here", m["screen_h"] == "100%", "got #{m['screen_h']}")
      check.call("#{name}: the trace has a height", m["plot"] >= MIN_PLOT, "#{m['plot']}px across #{m['rows']} rows, #{m['pitch']}px apart")
      check.call("#{name}: the rows stop short of the title bar", m["gap"] >= 0, "#{m['gap']}px to spare")
    end
  ensure
    driver.quit
  end
end

puts
if failures.zero?
  puts "All frame checks passed."
else
  puts "#{failures} frame check(s) FAILED."
  exit 1
end
