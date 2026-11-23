#!/usr/bin/env python3
"""Fetch the Greater London administrative boundary for the map's London outline.

Writes data/web/london.json: the relation's member ways, simplified, as plain
coordinate rings. No polygon assembly — the map only draws an outline, so the
ways can stay as separate strokes and the fiddly multipolygon stitching is
avoided entirely.
"""
import json, os, sys, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_network import simplify

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "web", "london.json")
REL = 175342          # Greater London, admin_level 5
TOL_M = 60            # an administrative outline needs no more detail than this

MIRRORS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter"]
QUERY = f"[out:json][timeout:60];rel({REL});out geom;"


def main():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for url in MIRRORS:
        try:
            req = urllib.request.Request(url, data=body,
                                         headers={"User-Agent": "tracks/1.0 (+https://github.com/og124/tracks)"})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read())
            break
        except Exception as exc:
            last = exc
    else:
        sys.exit(f"could not fetch the London boundary: {last}")

    rings, name = [], "Greater London"
    for el in data.get("elements", []):
        name = (el.get("tags") or {}).get("name", name)
        for m in el.get("members", ()):
            geom = m.get("geometry")
            if not geom or m.get("type") != "way":
                continue
            pts = simplify([(p["lat"], p["lon"]) for p in geom], TOL_M)
            if len(pts) >= 2:
                rings.append([[round(la, 5), round(lo, 5)] for la, lo in pts])

    if not rings:
        sys.exit("relation returned no member geometry")
    with open(OUT, "w") as f:
        json.dump({"name": name, "rings": rings}, f, separators=(",", ":"))
    pts = sum(len(r) for r in rings)
    print(f"wrote london.json — {name}, {len(rings)} ways, {pts} points, "
          f"{os.path.getsize(OUT)/1024:.0f} kB")


if __name__ == "__main__":
    main()
