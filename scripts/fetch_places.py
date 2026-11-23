#!/usr/bin/env python3
"""Produce data/web/places.json — the towns, suburbs and localities you can search.

Station names are the wrong vocabulary for the question people arrive with.
"Somewhere near Hebden Bridge" is a place; so is Canary Wharf; and the station
for Stratford-upon-Avon is not called Stratford. So the search box takes places
as well as stations, and jumping to one puts the map over it with its stations
listed beside it.

Source: the ONS Index of Place Names in Great Britain (IPN), one paged query
against the Open Geography Portal. Open Government Licence v3.

This started out as an Overpass query for OSM `place` nodes, and that was the
wrong tool twice over. Overpass bills by how much of the planet the bounding box
touches, and the box that covers Kent also covers two hundred kilometres of
northern France — which has more place nodes inside it than the whole of Great
Britain — so the request timed out on every mirror no matter how it was tiled.
IPN's advantages are not mainly about speed: it is Great Britain and nothing
else, so there is no foreign data to filter out; every row already carries its
local authority, so the three Newports are told apart without a point-in-polygon
pass against a boundary file; and the coordinates are already WGS84.

What it gives up is OSM's city/town/village hierarchy. IPN classifies by what
kind of *thing* a name is, not by how big it is, so the ranking below is ONS's
own type and the UI prints ONS's own word for it. Calling a built-up area a
"town" would be a classification this data does not make.
"""
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
WEB = os.path.join(ROOT, "data", "web")

IPN = ("https://services1.arcgis.com/ESMARspQHYMw9BZ9/ArcGIS/rest/services"
       "/IPN_GB_2020_2022/FeatureServer/0/query")
PAGE = 2000             # the service's own maxRecordCount; asking for more is ignored

# IPN type code → the word shown in the search list, most significant first. The
# index into this list is the search rank, so "new" offers the Newcastle
# built-up area before a Highland locality called Newton.
#
#   BUA    Built-Up Area — a settlement, from a city down to a large village
#   BUASD  Built-Up Area Sub Division — a named part of one
#   LOC    Locality — every other named place, which is most of them
KINDS = [("BUA", "built-up area"), ("BUASD", "suburb"), ("LOC", "locality")]
CODES = [c for c, _ in KINDS]
RANKS = [label for _, label in KINDS]

FIELDS = "place20nm,descnm,lad20nm,ctyltnm,ctry20nm,lat,long"

# IPN names a built-up area "Hebden Bridge BUA" and a sub division "Abbotswood
# BUASD" — the type code is part of the name field, for 8,700 of the 70,795 rows.
# Nobody types that and nobody wants to read it in a list of suggestions, and
# leaving it on also defeats the deduplication below, because the BUA and the
# locality of the same place never compare equal.
TYPE_SUFFIX = re.compile(r"\s+(BUASD|BUA)$")


def fetch_page(offset):
    where = urllib.parse.quote(
        "descnm IN (" + ",".join(f"'{c}'" for c in CODES) + ")")
    url = (f"{IPN}?where={where}&outFields={urllib.parse.quote(FIELDS)}"
           f"&returnGeometry=false&orderByFields=placeid"
           f"&resultOffset={offset}&resultRecordCount={PAGE}&f=json")
    req = urllib.request.Request(url, headers={"User-Agent": "tracks/1.0 (+https://github.com/og124/tracks)"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                d = json.loads(res.read())
            if "features" not in d:
                raise RuntimeError(str(d)[:160])
            return d
        except Exception as exc:          # noqa: BLE001 — transient portal errors
            wait = 4 * (attempt + 1)
            print(f"    retry offset {offset} ({type(exc).__name__}: "
                  f"{str(exc)[:70]}), sleeping {wait}s", flush=True)
            time.sleep(wait)
    raise SystemExit(f"could not fetch IPN page at offset {offset}")


def fetch_all():
    """Every page, cached as one file so a re-run after a failure is free."""
    cache = os.path.join(RAW, "ipn_places.json")
    if os.path.exists(cache) and os.path.getsize(cache) > 1000:
        print(f"  reusing {cache}")
        return json.load(open(cache))
    os.makedirs(RAW, exist_ok=True)
    rows, offset = [], 0
    while True:
        d = fetch_page(offset)
        feats = d.get("features", [])
        rows += [f["attributes"] for f in feats]
        print(f"  {len(rows):6} rows", flush=True)
        if not feats:
            break
        # exceededTransferLimit is the portal's own "there is more"; trust it
        # first and treat a short page as the end.
        if not d.get("exceededTransferLimit") and len(feats) < PAGE:
            break
        offset += len(feats)
    with open(cache, "w") as fh:
        json.dump(rows, fh)
    return rows


def main():
    os.makedirs(WEB, exist_ok=True)
    print("ONS Index of Place Names in Great Britain")
    rows = fetch_all()
    print(f"  {len(rows)} rows fetched")

    rank_of = {c: i for i, c in enumerate(CODES)}
    groups = {}
    skipped = 0
    for r in rows:
        name = TYPE_SUFFIX.sub("", (r.get("place20nm") or "").strip()).strip()
        lat, lon = r.get("lat"), r.get("long")
        rank = rank_of.get(r.get("descnm"))
        if not name or rank is None or lat is None or lon is None:
            skipped += 1
            continue
        lat, lon = float(lat), float(lon)
        # IPN carries placeholder coordinates for a handful of rows with no fix.
        if not (49.8 <= lat <= 61.0 and -8.5 <= lon <= 2.0):
            skipped += 1
            continue
        # Prefer the local authority: it is the name people actually use to tell
        # two places apart. The lieutenancy county is the fallback for the rows
        # whose district shares the place's own name — "Reading, Reading" says
        # nothing, "Reading, Berkshire" does — and the country the last resort.
        lad = (r.get("lad20nm") or "").strip()
        area = lad or (r.get("ctyltnm") or "").strip() or (r.get("ctry20nm") or "").strip()
        if area == name:
            area = (r.get("ctyltnm") or r.get("ctry20nm") or "").strip() or area
        groups.setdefault(name.lower(), []).append(
            {"name": name, "lat": lat, "lon": lon, "rank": rank, "area": area,
             "principal": lad == name})

    def km(a, b):
        x = (a["lon"] - b["lon"]) * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
        return math.hypot(x, a["lat"] - b["lat"]) * 111.32

    # One name, one entry per actual place.
    #
    # IPN describes the same place more than once in two different ways, and both
    # arrive as duplicate suggestions. A built-up area that straddles several
    # districts gets a row per district — Reading came through five times, five
    # identical suggestions with five different county labels — and a settlement
    # is often both a built-up area and a locality. So rows sharing a name are
    # clustered by distance and each cluster becomes one place, described by its
    # most significant type. A grid of rounded coordinates was tried first and is
    # the wrong shape: the five Reading centroids sat either side of a cell
    # boundary, so it split what it was meant to join.
    MERGE_KM = 12
    rows = []
    merged = 0
    for cand in groups.values():
        clusters = []
        for row in cand:
            for cl in clusters:
                if km(row, cl[0]) <= MERGE_KM:
                    cl.append(row)
                    break
            else:
                clusters.append([row])
        merged += len(cand) - len(clusters)
        for cl in clusters:
            # Most significant type wins; among equals, the district the place is
            # the eponym of — Reading in Reading, not Reading in Wokingham.
            best = min(cl, key=lambda r: (r["rank"], not r["principal"]))
            # Four decimal places is eleven metres. The job is to centre a map on
            # a village, so the fifth digit was 200 kB of nothing.
            rows.append([best["name"], round(best["lat"], 4), round(best["lon"], 4),
                         best["rank"], best["area"]])

    rows.sort(key=lambda r: (r[3], r[0]))
    for i, label in enumerate(RANKS):
        print(f"  {label:18} {sum(1 for r in rows if r[3] == i)}")
    print(f"  {merged} duplicate descriptions of the same place merged")
    print(f"  {skipped} rows skipped (no name, no fix, or an unused type)")

    # 69,000 rows share 408 local authorities between them, so the name goes in a
    # table and the row carries an index into it. With the always-zero population
    # column dropped as well that is a megabyte off the download, for a file the
    # browser fetches on the first keystroke.
    areas = sorted({r[4] for r in rows})
    index = {a: i for i, a in enumerate(areas)}
    for r in rows:
        r[4] = index[r[4]]

    doc = {
        "built": time.strftime("%Y-%m-%d"),
        "ranks": RANKS,
        "areas": areas,
        "fields": ["name", "lat", "lon", "rank", "areaIndex"],
        "source": "ONS Index of Place Names in Great Britain (IPN), July 2020",
        "licence": "Open Government Licence v3",
        "places": rows,
    }
    dest = os.path.join(WEB, "places.json")
    with open(dest, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print(f"wrote {dest} — {len(rows)} places, "
          f"{os.path.getsize(dest) / 1024:.0f} kB")


if __name__ == "__main__":
    main()
