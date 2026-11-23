# Tracks

An interactive map of the railway network of Great Britain — every physical
line from Penzance to Thurso — with each stretch of track coloured by the
London terminus it runs into, a journey time to London on every station, a
departure board for the day, a journey planner that routes in the browser, and
a house price overlay to read next to the commute.

```sh
make data     # fetch OSM geometry and build everything (~55 min, one off)
make serve    # then open http://localhost:8765/
```

## Journey times

| Source | How | Accuracy |
|---|---|---|
| `timetable` | the real National Rail DTD feed, parsed by `scripts/ingest_dtd.py` | exact fastest and typical times, trains per weekday, and every terminus a station reaches |
| `estimate` | per-corridor least-squares fit of `minutes` against along-track km, calibrated on the 84 published times in `scripts/seed_times.py` | median error 4–17% per terminus; every modelled value flagged *estimated* in the UI |

**Currently running on real timetable data**: 1,247 stations from the feed, 216
estimated where the feed has no London journey (heritage lines, and anywhere
needing two or more changes), and the 14 terminals themselves. The two are
mixed in one file and tagged separately in the UI.

### Switching to real times

Register for the free feed at <https://opendata.nationalrail.co.uk/>, then:

```sh
cat > .env <<'ENV'
NR_USER=you@example.com
NR_PASS=your-password
ENV
make timetable
```

## Layout

```
scripts/fetch_osm.py       Overpass download, tiled and resumable
scripts/build_network.py   track graph, terminus labelling, station snapping
scripts/build_segments.py  track alignment between adjacent stations
scripts/build_times.py     publishes times.json from whichever backend exists
scripts/ingest_dtd.py      National Rail timetable parser
scripts/seed_times.py      published times + corridor anchors
scripts/termini.py         the 14 termini, grouped into 8 colour sectors
scripts/check_palette.mjs  validates those 8 colours against the map's adjacency
scripts/check_data.py      asserts the data has every field the app reads
scripts/build_departures.py per-station departure boards
scripts/build_timetable.py  routable timetable for the journey planner
scripts/names.py           readable station names (the feed's are all caps)
scripts/fetch_london.py    the Greater London outline
scripts/fetch_places.py    searchable places, from the ONS place-name index
scripts/build_prices.py    the house price overlay: Price Paid + UK HPI
scripts/preview.py         static SVG snapshot, no browser needed
scripts/netbin.py          reader for the binary geometry format
scripts/test_journey.mjs   routing invariants, no browser and no dependencies
scripts/test_ui.mjs        boots the real page in jsdom and drives it
web/journey.js             Connection Scan routing + the commute sweep
web/track.js               stitches real track geometry under a drawn route
web/prices.js              the house price field: scale, lookup, canvas layer
web/                       the app: Leaflet + a custom canvas renderer
data/web/                  generated: network.bin, stations.json, times.json,
                           paths.json, timetable.bin, london.json,
                           places.json, prices.json, departures/<CRS>.json
```

## Licence

Code: MIT (see [`LICENSE`](LICENSE)). [Leaflet](https://leafletjs.com) is
vendored under its own BSD-2-Clause licence. The data is not in this repo; each
source keeps its own licence, listed under [Data](#data), and the app shows the
attributions on the map itself.
