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

Two parts of that are separable and worth knowing about, because they are the
slow one and the heavy one:

```sh
make places   # ~1 min   searchable place names (ONS)
make prices   # ~350 MB  the house price overlay (Land Registry, OS, UK HPI)
```

Both are cached in `data/raw/` and both are non-fatal: without `places.json` the
search covers stations only, and without `prices.json` the House prices button
says so. Neither is rebuilt by the weekly refresh — the data behind them moves
monthly at fastest, not weekly.

`make serve` serves `dist/` — `index.html` at the root with the generated data
beside it in `data/`, which is exactly what a static host serves in production.
Local and deployed therefore resolve identical paths.

## What you get

- **Real track geometry**, straight from OpenStreetMap — individual ways, not a
  schematic. Zoom in on Clapham Junction or Reading and the four-track
  formations, flyovers and platform loops are all there. Yards and sidings
  appear from zoom 12.
- **Colour by sector.** Every way is tagged with the London terminus it
  actually funnels into, so the Great Western, South Western and Kent networks
  read as distinct systems converging on London. Click a sector to isolate it.
- **Every station is drawn at every zoom**, sized in three tiers — terminals
  largest, then principal calling points and anything with 60+ departures a
  day, then the rest. Radius scales with zoom so the small ones stay visible
  when you are looking at the whole country.
- **Hover any station** for its time into its London terminus —
  *"Kemble — 1h 9m to London Paddington"*.
- **Click a station** and three things happen: its line lights up and the rest
  of the network recedes, the **inspector** slides in from the right with
  fastest/typical times and every terminus it reaches, and a **departure
  board** for the day loads underneath — real times, destinations, operators
  and platforms.
- **The service pattern**, above the board: **first train, last train** and
  trains per day, over a strip of departures per hour with the current hour
  picked out. Kemble is 05:41 to 23:55, 40 trains, typically two an hour;
  Paddington is 00:01 to 23:59 and 820. A station with one train an hour and a
  station with six are different propositions at the same journey time, and
  the last train is what actually decides whether a commute works.
- **Name a destination and the same strip is about your route, not the
  station.** 820 trains leave Paddington; sixteen of them go to Kemble, the
  first at 06:42 and the last at 21:50. Once you have said where you are going,
  the station's own total is the wrong number — so the planner shows the direct
  services between the two, with the fastest and typical time and who runs them.
- **One search box for stations and places.** Across the top, and it takes both
  vocabularies: 2,576 stations and 62,539 towns, suburbs and localities, each
  labelled with its local authority so the fourteen Newports are told apart.
  Stations are scored to win — typing "Hebden" offers Hebden Bridge station
  before the Dales hamlet called Hebden — and picking a place centres the map on
  it and lists what you could catch from there, nearest first, with the journey
  time on each.
- **House prices as a heatmap**, under the track rather than over it. Median of
  actual sales per postcode district across England and Wales over a rolling
  twelve months, from the Land Registry's Price Paid register; Scottish council
  areas from the UK House Price Index, because Price Paid is an English and
  Welsh register. Point at anywhere for the local figure, and every number says
  which of the two it is — *median of 419 sales* reads differently from
  *council average*, and the map never pretends otherwise. A station's own
  figure sits in the inspector next to its commute, because forty minutes is a
  different proposition at £240,000 than at £740,000.
- **Every view has a link.** A station, a planned journey with its departure
  time, a filtered network, the price overlay, a place on the map — all of it is
  in the URL, and
  **Share** copies it. Open someone else's link and the map rebuilds exactly
  what they were looking at, journey included.
- **Click any line** to name it on the map, or pick one from the **line
  filter** (2,300-odd named lines) to isolate it and zoom to its full extent.
- **Filter by terminus.** The legend dock lists all fourteen London terminals
  with a station count each, grouped under their sector: click Waterloo to see
  just the Waterloo network, or a sector heading for the whole group.
- **Greater London is outlined**, and the terminals label themselves from zoom
  12, so the busiest part of the map is navigable rather than a knot.
- **Satellite or dark map**, switchable from the dock. Over imagery the track
  gets a dark halo so it stays readable.
- **Nothing is permanently in the way.** The inspector appears only once you
  click something, the legend dock is collapsed until you open it, and the
  command card folds to its title bar.
- **Journey time mode** shades every station by how long it takes to reach
  London, so the commutable core stands out at a glance.
- **Start with where you are going.** The first field on the page is the
  destination, and naming one re-measures the whole country against it: every
  station is shaded by how long it takes to get there, and hovering gives the
  time and the last train that still makes it. This is the London map's
  journey-time shading with London replaced by somewhere that matters to you —
  the answer to *"where could I live and still be at work by nine?"*
- **Plan any journey**, not just to London. Add a starting station and it finds
  the trains, with changes and walking transfers between stations that sit next
  to each other, and draws the chosen one on the map **along the actual rails** —
  real OpenStreetMap alignment between every pair of stations, not a chord from
  one calling point to the next. Worcester to Sheffield, Penzance to Inverness,
  anywhere to anywhere. Clear the destination and the map is the London map it
  always was.
- **Search** by name, CRS code or place name, and a **table view** that needs no
  colour.

## The toolbar, and why it replaced the card

The page used to open on a command card at the top left whose two fields were
the ends of a journey. That is a good shape for planning a trip and the wrong
shape for arriving at a map of the country, because the first thing most people
want is *take me to Ely* — and with only those two boxes on screen, looking a
station up meant pretending to plan a journey to it. On a phone it was worse: the
card plus an open suggestion list covered most of the map, and the list only
closed when the input lost focus, which tapping the map does not reliably do. It
had no way out.

So the top of the screen is now a bar: a search box, with tools beside it.

| | what it is |
|---|---|
| **search** | always there, not a tool. Stations and places in one list. |
| **Plan a journey** | the old card's two fields, the time, and the results |
| **House prices** | the overlay, its colour scale and a live readout |

Three things make it behave on a touch screen:

- **One panel at a time.** Two open panels is two panels' worth of map covered
  up, which on a phone is all of it.
- **Everything is dismissable from outside itself.** A single capture-phase
  `pointerdown` on the document closes any open suggestion list the moment you
  tap away from it — capture phase, because Leaflet stops propagation on gestures
  inside the map, so a normal listener never hears them. That is the bug that
  made the old panel a trap, and it is the reason the fix is not `blur`.
  Suggestions are chosen on `pointerdown` too: `mousedown` is synthesised late on
  touch and only if the browser decides the tap was not a scroll, so a third of
  taps on a suggestion did nothing at all.
- **`Escape` unwinds one rung at a time** — table, legend, selection, journey,
  panel — so it never takes away more than the thing you are looking at.

The bottom dock keeps the legend, the colour mode, the table and the basemap
switch. It used to be hidden outright below 620 px, which left a phone with no
legend, no journey-time toggle, no station table and no satellite view; it is now
a bottom bar that scrolls sideways, and the inspector sits above it rather than
on top of it. Above 900 px the bar is capped so it always clears the inspector
card on the right, which is the window width that used to put one on top of the
other.

## Journey times

Two backends write the same file, so the app never changes:

| Source | How | Accuracy |
|---|---|---|
| `timetable` | the real National Rail DTD feed, parsed by `scripts/ingest_dtd.py` | exact fastest and typical times, trains per weekday, and every terminus a station reaches |
| `estimate` | per-corridor least-squares fit of `minutes` against along-track km, calibrated on the 84 published times in `scripts/seed_times.py` | median error 4–17% per terminus; every modelled value flagged *estimated* in the UI |

**Currently running on real timetable data**: 1,247 stations from the feed, 216
estimated where the feed has no London journey (heritage lines, and anywhere
needing two or more changes), and the 14 terminals themselves. The two are
mixed in one file and tagged separately in the UI, so nothing is ever blank and
nothing is ever passed off as exact when it isn't.

`make data` alone produces estimates, so the map works before you have
credentials. That fit is piecewise — inner suburban services and long-distance
expresses average very different speeds, and one curve fitted to both was wrong
at both ends.

Checked against 83 published times I'd noted independently, the feed agrees
within 12% or 5 minutes on 76. Where they disagree the feed wins: Richmond to
Waterloo really is 19 minutes rather than 26, and Willesden Junction has no
Paddington service at all.

### Switching to real times

Register for the free feed at <https://opendata.nationalrail.co.uk/>, then:

```sh
cat > .env <<'ENV'
NR_USER=you@example.com
NR_PASS=your-password
ENV
make timetable
```

`.env` is gitignored. `ingest_dtd.py` reads one representative weekday, keeps
passenger schedules, and takes the fastest direct service from each station to
each London terminus; stations with no through train get a one-change search.
Until it has run, the app only offers each station's own terminus — running the
distance model against all fourteen produces confident nonsense, because from
Kemble every London terminus is within 3% of the same track distance.

Which terminus gets headlined is a near-tie rule: the corridor's own terminus
wins when it is within 4 minutes or 15% of the fastest, so Clapham Junction
reads "8m to Waterloo" rather than shaving two minutes by switching to
Victoria; but a genuinely quicker route takes it, so Abbey Wood correctly reads
18 minutes to Liverpool Street on the Elizabeth line rather than 32 to Cannon
Street. Every reachable terminus is listed underneath, fastest first.

## Layout, and why the track got quieter

The page is three floating surfaces over an uninterrupted map: the command card
top-left (**starting station**, **destination station**, departure time), the
inspector on the right that appears only when you select something, and a dock
bottom-left holding the legend, the line filter and the map options. Nothing
sits on the map permanently, and the two questions people actually arrive with
— where am I starting, where am I going — are the first thing on the page.

The map itself had the figure and the ground the wrong way round. Against a
near-black canvas, fourteen saturated networks at full weight were the loudest
thing on screen, and a station drawn solid in its own sector colour vanished
into the line it sat on: same hue, same value, no edge. Three changes fix it.
The basemap is lifted off black to a soft slate, so colour has something to sit
on rather than glowing out of a void. Track strokes are about a third thinner
and run at roughly 0.6 alpha instead of 0.95, which is enough to read as a
network and not enough to dominate. And every station is now a light core
inside a ring of its line's colour — the core separates it from the track by
value, the ring keeps the colour coding, and the two are legible at every zoom
because the ring weight scales with the radius.

`scripts/preview.py` renders the same rules to a standalone SVG, so the
weighting can be checked without a browser.

## Why a line changes colour where it does

Colour is decided per *named line*, not per stretch of track, and that is a
deliberate correction. The corridor partition (below) is grown outward from
anchor stations, so its boundary falls wherever two anchors happen to meet —
usually open countryside. On the map that showed up as the Wessex Main Line
turning from Paddington-orange to Waterloo-purple somewhere between Warminster
and Salisbury, with no junction or station to explain it. Every named line now
takes a single terminus, by track length, so the colour can only change where
the line does, which is a real place. About 7,000 ways get recoloured to agree
with their line.

Unnamed track — sidings, connecting curves, the 16% of ways OSM has no route
relation for — still takes its own label, so a colour change on an anonymous
stub is possible and means only that the partition boundary runs through it.

## How the terminus is decided

Nearest-terminus-by-track does not work: Victoria sits a few hundred metres
closer to the South Western main line than Waterloo does, which is true and
operationally meaningless. Instead `build_network.py` grows a Voronoi partition
outward from 142 anchor stations, each labelled with the terminus its trains
really run to, and every other station inherits the nearest label. Against a
38-station spot check this gets 36 right; the two it "misses" — Clapham
Junction and Lewisham — are genuinely served by both.

## Colour choice

Fourteen termini cannot be given fourteen distinguishable colours, so they are
grouped into eight sectors. The sectors form a ring around London plus three
chords (HS1 into Kent, the West Coast meeting the East Coast across
Hertfordshire, and the Midland running parallel to the Great Eastern out to
Essex); `scripts/check_palette.mjs` searches hue assignments against exactly
those touching pairs and the chosen one clears both colourblind-safety gates —
worst CVD ΔE 8.4, worst normal-vision ΔE 19.3. Colour is never the only cue:
the legend is always visible, hovering names the terminus in words, one click
isolates a sector, and the table view needs no colour at all.

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

`make check` runs the data contract; `make palette` re-runs the colour search;
`make preview` writes `preview.svg`; `make dist` assembles the deployable site
(symlinks, so an edit under `web/` is live immediately).

Two test harnesses run on every PR and need no browser:

```sh
node scripts/test_journey.mjs                    # routing invariants
npm install --no-save jsdom && node scripts/test_ui.mjs   # boots the app in jsdom
```

`test_journey.mjs` checks that no itinerary contains a change shorter than the
operator's published minimum, that legs join end to end and that nothing runs
backwards, over 600 random station pairs. `test_ui.mjs` boots the real page and
drives it: the service pattern, the share links (built, cleared, restored from
the URL and copied), the search box and its dismissal, and the price overlay
down to the pixels it paints and the provenance label on each figure.

### Correctness guards

Two mistakes in this pipeline are silent rather than loud, so both are checked
on every build:

- **Graph gaps.** Excluding ways tagged `service=crossover` fragmented every
  large station throat and put Clapham Junction 37 km from Waterloo instead of
  6. `build_network.py` now reports any station whose track distance exceeds
  2.4× its straight-line distance.
- **Wrong CRS codes.** Hand-entered codes fail quietly — `ROC` is Roche in
  Cornwall, not Rochester. Every anchor is resolved against the OSM station set
  at build time and unresolved ones are named in the output.
- **CIF "0000" is not midnight.** In the timetable feed a public time of `0000`
  means "not a public stop", which is what every passing point carries. Reading
  it as 00:00 turned each one into a midnight call, wrecked the running order,
  and quietly cost most of Cornwall its London times — Penzance simply vanished
  from the results while everything still looked plausible. `hhmm()` returns
  `None` for it.
- **Schedule validity dates.** The feed holds schedules for many periods at
  once; only those whose date range covers the run date are actually running.
  Filtering on it cuts 87,000 candidate Tuesday schedules to 21,700 and stops
  withdrawn services setting records.

## The journey planner

Any station to any station, entirely in the browser. The routing is
[Connection Scan](https://arxiv.org/abs/1703.05997): the timetable is packed
into a list of *connections* — one train's hop between consecutive calling
points — sorted by departure time, so a query is a single forward sweep with an
early exit once nothing left can beat the arrival already found. 247,000
connections, 2,576 stations, and a query runs in **0.5 ms median, 1.2 ms p95**
over 600 random station pairs.

Walking transfers are included for stations within 900 m of each other, which
is what lets it route Bangor to Norwich via a 14-minute walk from Euston to
King's Cross. They are indexed by origin (CSR) rather than rescanned, which is
most of the difference between that figure and the old one.

### Changes take the time the operator says they take

The minimum interchange time is **per station, from the feed's own station
master file**, not a constant: 15 minutes at Euston, Paddington and Liverpool
Street, 12 at Birmingham New Street, 10 at Clapham Junction and Manchester
Piccadilly, against a median of 5. 633 of the 2,576 stations in the timetable
publish something other than 5.

A flat five minutes is not a rounding error, it is a wrong answer, and it is
wrong in the worst place — the big interchanges are exactly where a commuter
changes. Every itinerary is now checked against the published figure; across
1,419 generated journeys and 3,782 changes, none breaches it.

`timetable.bin` is 2.8 MB and is fetched only when you first open the planner,
so the map still starts in under a tenth of a second. There is no precomputed
matrix: all-pairs would be 2,599² entries and stale the moment the timetable
changed.

Two honest limits. It routes **one representative weekday**, the same day the
rest of the map uses — no date picker, no engineering works, no real-time
delays. And it optimises earliest arrival, so it will hand you a six-change
epic if that genuinely gets you there first; the alternatives listed underneath
are simply later departures, not a different trade-off between time and changes.

One subtlety worth recording, because it was silently producing unmakeable
changes. Connection Scan stops applying a change time once you are aboard a
train — correctly: you are not changing at the intermediate stops. But the
earliest arrival at one of those stops can afterwards be improved by a
different train, and a reconstruction that walks backwards "while still on the
same trip" then splits the leg there and reports you boarding at a station
where no change was ever validated. The scan now records the connection each
trip was *boarded* at, so the itinerary says what the scan actually proved.

## Rendering

Two things stop the map feeling sluggish.

**Geometry ships as a binary blob, not GeoJSON.** `network.bin` is a
self-describing little-endian file whose header carries every section offset,
so the browser maps it straight into typed arrays with no parsing. For the same
data GeoJSON cost about four times the bytes and roughly a second of
`JSON.parse`; the binary boots in well under a tenth of a second. Read it from
Python with `scripts/netbin.py`.

**The canvas layer extends `L.Renderer`, not `L.Layer`.** That matters more
than it sounds: `Renderer` owns the oversized canvas, the pan translation and
the `zoomanim` transform. A hand-rolled layer has to reimplement that last one
and, if it gets it wrong, the track sits frozen mid-zoom while the basemap
slides underneath — which is exactly what it did. Drawing also inlines the Web
Mercator projection rather than calling `latLngToLayerPoint`, because at close
to a million points the per-point `Point` allocation costs more than the
arithmetic.

Sidings are held back until zoom 12. They are in the graph at every zoom —
they have to be, or station throats fall apart — but they are noise on a map of
the country.

## Basemap

Esri's Dark Gray Canvas, which needs no API key and ships base and labels as
separate layers so place names sit above the track. (CARTO's keyless dark tiles
now come back stamped "API KEY REQUIRED".) To swap in Stadia's Alidade Smooth
Dark instead — darker, but a single combined layer, and keyless on localhost
only — change the tile URLs at the top of `web/app.js`.

## Coverage

Great Britain. The fetch box also catches the island of Ireland, which
`build_network.py` drops: it is a separate network with no London connection,
and no bounding box separates Northern Ireland from the Republic cleanly. The
Pas-de-Calais is dropped for the same reason — the graph will happily route
through the Channel Tunnel, and Abbeville turned up in the station list as
3h21 from St Pancras.

## Data

Railway geometry and stations © OpenStreetMap contributors,
[ODbL](https://www.openstreetmap.org/copyright). Basemap © Esri. Timetable data
© Rail Delivery Group, under the National Rail open data licence.

House prices and place names are Open Government Licence v3:

| | source |
|---|---|
| sale prices, England & Wales | HM Land Registry Price Paid Data |
| average prices, Scotland | UK House Price Index (HM Land Registry / ONS / Registers of Scotland) |
| postcode locations | Ordnance Survey Code-Point Open |
| place names and local authorities | ONS Index of Place Names in Great Britain |

Contains OS data © Crown copyright and database right. Contains public sector
information licensed under the Open Government Licence v3.0. The licence and the
source travel inside `prices.json` and `places.json` and are rendered in the
House prices panel, rather than living in a comment where an edit can drop them.

### Why a field rather than a choropleth

There are no free postcode-district boundaries, so the overlay draws an
inverse-distance field over the real district centroids instead of inventing
polygons. Each district carries an influence radius taken from how spread out
its own postcodes actually are — SW11 is two kilometres across, IV27 is sixty —
and the opacity is how deep inside the nearest area you are, so the field is
solid where there is something to say and fades to nothing where there is not.
That is what makes it stop at the coast without a landmask, sharply where the
districts are small and gently across the Highlands, and it means the map never
draws a hard edge the data cannot support.

Scotland is the honest exception. Price Paid covers England and Wales only, so
Scottish figures are council-wide averages: 32 areas against 2,208 postcode
districts. They are labelled `council average` wherever they appear, never
`median of N sales`, and the two are never averaged together.

## Hosting

The live map is at **<https://tracks.ojrg.dev>**. It's entirely static: `make
dist` assembles the site (`index.html`, the scripts, `vendor/`, and `data/`
beside them), and any static host can serve it. In production it sits in a
private object store behind a CDN; that infrastructure is managed separately
and isn't part of this repo.

There is no server and no API key in the client — which is what the two
sections below are about.

### How often the feed is actually touched

**The running application never calls National Rail.** Every byte the browser
fetches is a static file. The feed is downloaded by one scheduled GitHub
Actions job, once a week, in exactly two requests — one to authenticate, one to
pull the DTD extract — and that number does not move whether the site serves
ten visits or ten thousand. There is no per-user, per-session or per-search
request to anybody's API, and no API key in the client.

In production a scheduled job runs at 04:30 UTC on Tuesdays, after the overnight DTD
publication and before the morning commute. Weekly rather than nightly because
`ingest_dtd.py` pins `WEEKDAY = 1`: every figure the site shows describes a
representative *Tuesday*, so a nightly run rebuilt the same modelled day seven
times a week. Tuesday specifically so that the schedule-validity window and the
days-run mask describe the same day. It rebuilds journey times, 2,575 departure boards
and the routable timetable, runs `check_data.py`, and only then publishes —
so a bad feed leaves the previous good data serving rather than breaking the map.

The track geometry is not on that schedule. It comes from a ~50-minute Overpass
crawl and changes on the scale of months, so it is built locally and pushed to
the live site by hand.

### What a visitor actually downloads

The data is uploaded **pre-gzipped with a `Content-Encoding` header** rather
than relying on the CDN to compress it — `network.bin` is
`application/octet-stream`, which no CDN is obliged to compress, and it is the
single biggest file on the page.

| | raw | over the wire |
|---|---|---|
| first load (map, stations, times) | 5.68 MB | **1.86 MB** |
| `timetable.bin` + stops (planner, on first use) | 2.59 MB | 1.67 MB |
| `places.json` (search, on the first keystroke) | 2.27 MB | 783 KB |
| `prices.json` (overlay, on the first press) | 97 KB | 38 KB |
| one departure board | 17 KB | 3 KB |

Everything below the first row is fetched on demand, so a visitor who only looks
at the map pays for none of it. The place index is the one sizeable lazy load,
and the search does not wait for it: station matches render on the first
keystroke and the list repaints when places arrive, so the box is never blocked
on a 783 KB download.

Cached at the edge for a day and invalidated when the weekly refresh lands, so
a returning visitor on the same day pays for none of it.

`data/web/` also holds `network.geojson` (7.1 MB) and `times_timetable.json`,
which are intermediate build products the app never fetches.
Publish only the files `web/app.js`, `web/journey.js` and `web/prices.js`
actually request, pre-gzipped with `Content-Encoding: gzip`. `places.json` and
`prices.json` are optional: without them the search falls back to stations
only, and the House prices button says the overlay isn't available.

## Sharing a view

Everything that makes the page look the way it does lives in the URL fragment,
so a link is a view:

```
#st=YRK                                    a station
#from=RDG&to=YRK&at=0830                   a journey, leaving at 08:30
#from=RDG&to=YRK&at=0830&j=2               …the third option in the list
#term=WAT                                  just the Waterloo network
#line=Great+Western+Main+Line              one named line
#map=51.5074,-0.1278,12                    a place
#hp=1                                      the house price overlay, on
```

Three decisions worth recording. It is the **fragment**, not the query string,
so a shared link never reaches the CDN and cannot be broken by a cache-key
setting. The line is named rather than indexed, because the line index is
assigned when the geometry is rebuilt and an indexed link would quietly point at
a different line after the next OSM refresh. And `map=` is only written once
there is something to pin it to, or you have actually moved the map — otherwise
the `fitBounds` at startup would rewrite a clean URL with a viewport nobody
chose.

Written with `replaceState`, so panning does not fill the back button with map
positions.

## Commute mode

Naming a destination replaces London as the thing every station is measured
against. The map shades all 2,576 stations by how long it takes to reach that
destination, and hovering any of them gives the journey time and the last train
that still gets you there in time.

It is one backward sweep of the timetable, not 2,576 forward searches.
Connection Scan run *in reverse* — newest connection first, asking "can I still
make it from here?" — answers the question for every station in the country in a
single pass, which is why it runs on the keystroke that picks the destination
rather than behind a button.

```
Reading      24 min   leave 08:36        Kemble        79 min   leave 07:41
Slough       37 min   leave 08:23        Oxford        67 min   leave 07:53
Didcot       50 min   leave 08:10        Bristol TM   113 min   leave 07:07
```

The sweep and the planner now agree on **every one of the ~7,000 reachable
station-destination pairs** tested across six destinations. That is checked on
every PR by `scripts/test_journey.mjs`, because the two are independent
implementations of the same question and a divergence means one of them is
wrong. Anything you click is still re-run through the planner — it costs half a
millisecond — and the inspector labels the result with its provenance.

### What the disagreement found

Making the two agree took two bug fixes in the forward planner, both of which
had been losing real journeys since the planner shipped. Both come from the
same root cause: **a station can be reached by train or on foot, and the two
are not interchangeable.** Boarding after a train arrival costs that station's
published interchange time; boarding after a walk costs nothing, because the
walk already covered getting between platforms. Keeping only the earlier of the
two throws away the other option along with its boarding rule.

- **Walks that could not be taken.** Reaching Waterloo East on foot from
  Blackfriars at 08:40 blocked the onward walk (walks may not chain) *and* made
  the 08:48 train arrival look like no improvement, so it could not propagate
  one either. The seven-minute walk to Waterloo was never offered: the planner
  said 09:13 for a journey that takes until 08:55.
- **Walks that were discarded for being later.** Euston is a fifteen-minute
  interchange. Arrive by train at 07:30 and the 07:38 to Birmingham is out of
  reach; walk in from St Pancras, arriving 07:38, and you make it. The single
  clock kept 07:30 because it was earlier, then refused the train — so Acton
  Central to Birmingham came out **27 minutes worse than it really is**.

The scan now carries two arrival clocks per station and records, per trip,
whether it was boarded on foot, so the reconstruction says what the scan
actually proved. Stations reachable into Paddington by 09:00 went from 1,283 to
1,332, and Acton Central to Birmingham from 09:27 to 08:56.

## Drawing a route on the rails

A planned journey is drawn along the real alignment. `build_segments.py` ships
the track between each pair of stations that are neighbours on the network, and
`web/track.js` stitches them: consecutive calling points are usually *not*
neighbours — a fast train from Reading to Paddington passes four stations it
does not call at — so it walks the station-adjacency graph between them.

| | chord | on the rails |
|---|---|---|
| Reading → Paddington | 55 km | 61 km (+10%) |
| York → King's Cross | 277 km | 315 km (+14%) |
| Aberdeen → Plymouth | 1,038 km | 1,277 km (+23%) |

Across 190 random journeys, 98.5% of hops draw on real geometry; the rest fall
back to a chord, which is what the graph genuinely cannot connect.

Adjacency comes from a **Voronoi partition** of the track graph over the
stations — every node is assigned to its nearest station along the rails, and
two stations are neighbours exactly where their territories touch. The obvious
alternative, stopping a search at the first station node it meets, does not
work: a station is one node but its layout is many parallel ones, so the search
walks straight past on an adjacent track. That version produced 130,817 "adjacent"
pairs and an 86 MB file. The partition gives 3,629 pairs in 0.45 MB (0.30 MB
gzipped), builds in under three seconds, and puts each segment's endpoints a
median of 6 m from the station they belong to.

## Licence

Code: MIT (see [`LICENSE`](LICENSE)). [Leaflet](https://leafletjs.com) is
vendored under its own BSD-2-Clause licence. The data is not in this repo; each
source keeps its own licence, listed under [Data](#data), and the app shows the
attributions on the map itself.
