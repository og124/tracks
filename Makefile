PY ?= python3
PORT ?= 8765

.PHONY: all data fetch london network times departures planner segments timetable places prices dist serve check preview palette clean

all: data

## download OSM geometry, then build everything the web app reads
data: fetch london network times departures planner segments places prices

fetch:
	$(PY) scripts/fetch_osm.py

## Greater London outline, drawn as a border on the map
london:
	-$(PY) scripts/fetch_london.py

network:
	$(PY) scripts/build_network.py

times:
	$(PY) scripts/build_times.py
	$(PY) scripts/check_data.py

## real journey times — needs NR_USER / NR_PASS in .env
timetable:
	$(PY) scripts/ingest_dtd.py
	$(PY) scripts/build_times.py
	$(PY) scripts/build_departures.py
	$(PY) scripts/build_timetable.py
	$(PY) scripts/check_data.py

## per-station departure boards (needs the timetable feed already downloaded)
departures:
	-$(PY) scripts/build_departures.py

## routable timetable for the any-to-any journey planner
planner:
	-$(PY) scripts/build_timetable.py

## track geometry between adjacent stations, so a drawn route follows the rails
segments:
	$(PY) scripts/build_segments.py

## towns, villages and suburbs the search box can jump to.
##
## Twenty Overpass requests, a few minutes each, cached per tile. Like the track
## geometry this is months-stale at worst, so it belongs here and not in the
## weekly refresh. Non-fatal: the app falls back to searching stations only.
places:
	-$(PY) scripts/fetch_places.py

## the house price overlay — Land Registry Price Paid + Code-Point Open + UK HPI.
##
## ~350 MB of one-off downloads, cached in data/raw/prices/. House prices are
## published monthly, so this is a local, one-off build. Non-fatal: without prices.json the
## House prices button says so and the rest of the app is unaffected.
prices:
	-$(PY) scripts/build_prices.py

## assert the generated data has every field the app reads
check:
	$(PY) scripts/check_data.py

## static SVG snapshot of the network, no browser needed
preview:
	$(PY) scripts/preview.py preview.svg

## assemble the deployable site: index.html at the root, data/ beside it.
##
## Symlinks throughout, not copies. dist/ is a *view* of the repo in the shape
## a static host serves it, so editing web/app.js is live immediately — copying
## meant a running `make serve` quietly served the previous version until you
## remembered to rebuild.
dist:
	@rm -rf dist
	@mkdir -p dist
	@for f in index.html app.js journey.js track.js prices.js style.css robots.txt sitemap.xml vendor; do \
		ln -snf ../web/$$f dist/$$f; \
	done
	@ln -snf ../data/web dist/data
	@echo "dist/ assembled — index.html, app.js, journey.js, prices.js, style.css, vendor/, data/"

serve: dist
	@echo "→ http://localhost:$(PORT)/"
	@cd dist && $(PY) -m http.server $(PORT)

## re-check the sector colours against the touching-pair gates
palette:
	node scripts/check_palette.mjs

clean:
	rm -rf data/web dist preview.svg
