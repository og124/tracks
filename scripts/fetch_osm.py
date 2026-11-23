#!/usr/bin/env python3
"""Fetch railway line geometry + stations from OSM Overpass for southern England.

Writes one JSON file per tile into data/raw/. Idempotent: existing non-empty
tile files are skipped, so the script can be re-run after a failure.
"""
import json, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")

# Great Britain: Penzance to Thurso, Fishguard to Lowestoft.
# The box also catches the island of Ireland, which build_network.py drops --
# it is a separate network with no London connection, and no bounding box
# separates Northern Ireland from the Republic cleanly.
BBOX = (49.85, -6.60, 58.70, 1.85)   # south, west, north, east
COLS, ROWS = 4, 5

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

# No service filter: sidings, crossovers and spurs are excluded from the *map*
# later, but they must be in the *graph*. Station throats are tied together by
# ways tagged service=crossover/spur, and dropping them fragments every big
# junction -- Clapham Junction ended up 37 km from Waterloo instead of 6.
LINES_Q = """[out:json][timeout:600];
way["railway"~"^(rail|light_rail|narrow_gauge)$"]({s},{w},{n},{e});
out geom tags;
"""

STATIONS_Q = """[out:json][timeout:600];
(
  node["railway"~"^(station|halt)$"]({s},{w},{n},{e});
  way["railway"~"^(station|halt)$"]({s},{w},{n},{e});
);
out center tags;
"""

# Named physical lines ("Great Western Main Line"). Members only, no geometry:
# the way ids are enough to attach a line name to track we already have.
ROUTES_Q = """[out:json][timeout:600];
relation["type"="route"]["route"~"^(railway|tracks)$"]({s},{w},{n},{e});
out body;
"""


def tiles():
    s, w, n, e = BBOX
    dlat = (n - s) / ROWS
    dlon = (e - w) / COLS
    for r in range(ROWS):
        for c in range(COLS):
            yield (r, c, s + r * dlat, w + c * dlon, s + (r + 1) * dlat, w + (c + 1) * dlon)


def post(url, query, timeout=640):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "tracks/1.0 (+https://github.com/og124/tracks) (rail map build)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch(name, query):
    path = os.path.join(RAW, name)
    if os.path.exists(path) and os.path.getsize(path) > 2000:
        print(f"  skip {name} (have {os.path.getsize(path)/1e6:.1f} MB)", flush=True)
        return
    for attempt in range(10):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            body = post(url, query)
            if body.lstrip()[:1] != b"{":
                raise RuntimeError(body[:200].decode("utf8", "replace"))
            obj = json.loads(body)
            if "elements" not in obj:
                raise RuntimeError("no elements key")
            with open(path, "wb") as f:
                f.write(body)
            print(f"  ok   {name}  {len(obj['elements'])} elements  {len(body)/1e6:.1f} MB  via {url.split('/')[2]}", flush=True)
            return
        except Exception as exc:
            # long runs get rate limited; back off geometrically, capped
            wait = min(90, 5 * (2 ** min(attempt, 4)))
            print(f"  retry {name} attempt {attempt+1}: {type(exc).__name__}: {exc} (sleep {wait}s)", flush=True)
            time.sleep(wait)
    raise SystemExit(f"failed to fetch {name}")


def main():
    os.makedirs(RAW, exist_ok=True)
    for r, c, s, w, n, e in tiles():
        box = {"s": round(s, 4), "w": round(w, 4), "n": round(n, 4), "e": round(e, 4)}
        print(f"tile r{r}c{c} {box}", flush=True)
        fetch(f"lines_r{r}c{c}.json", LINES_Q.format(**box))
        fetch(f"stations_r{r}c{c}.json", STATIONS_Q.format(**box))
        fetch(f"routes_r{r}c{c}.json", ROUTES_Q.format(**box))
    print("done", flush=True)


if __name__ == "__main__":
    main()
