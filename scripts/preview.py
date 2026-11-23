#!/usr/bin/env python3
"""Render data/web/network.bin to a standalone SVG.

A static snapshot of what the map draws, useful for eyeballing the geometry,
the sector colours and the track-versus-station weighting without opening a
browser:

    python3 scripts/preview.py preview.svg [south west north east]
"""
import json, math, os, sys
from xml.sax.saxutils import escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netbin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "data", "web")
W, H, PAD = 1800, 1500, 20

# Matches web/style.css and web/app.js: a lifted slate ground, muted track, and
# stations drawn as a light core inside a ring of their line's colour so they
# read on top of the track rather than dissolving into it.
BG = "#1b2027"
CORE = "#eef4fa"
UNREACHED = "#5a6472"
TRACK = {2: (0.62, 0.62), 1: (0.40, 0.36)}       # prominence -> (width, alpha)
DOT = {2: (4.2, 1.3), 1: (2.6, 1.0), 0: (1.3, 0.7)}   # tier -> (radius, ring)


def merc(lat, lon):
    x = (lon + 180) / 360
    s = math.sin(math.radians(max(-85, min(85, lat))))
    y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
    return x, y


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "preview.svg")
    sectors = json.load(open(os.path.join(WEB, "sectors.json")))
    keys = [s["key"] for s in sectors["sectors"]]
    palette = [UNREACHED] + [s["colour"] for s in sectors["sectors"]]
    colour_of = {s["key"]: s["colour"] for s in sectors["sectors"]}
    feats, meta = netbin.read(os.path.join(WEB, "network.bin"))
    stations = json.load(open(os.path.join(WEB, "stations.json")))["stations"]
    try:
        stats = json.load(open(os.path.join(WEB, "station_stats.json")))["departures"]
    except (OSError, KeyError):
        stats = {}
    termini = sectors["termini"]

    if len(sys.argv) > 5:
        bs, bw, bn, be = (float(v) for v in sys.argv[2:6])
    else:
        # A handful of ways run far past the fetched region (Overpass returns
        # whole ways), so auto-extent would leave most of the canvas empty.
        bs, bw, bn, be = 49.9, -6.0, 52.7, 1.9
    (x0, y1), (x1, y0) = merc(bs, bw), merc(bn, be)
    scale = min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0))
    ox = PAD + ((W - 2 * PAD) - (x1 - x0) * scale) / 2
    oy = PAD + ((H - 2 * PAD) - (y1 - y0) * scale) / 2

    def proj(lat, lon):
        x, y = merc(lat, lon)
        return (x - x0) * scale + ox, (y - y0) * scale + oy

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
             f'viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="{BG}"/>']

    # prominence 1 (freight/secondary) beneath prominence 2 (passenger lines);
    # yards and sidings are omitted, exactly as the app hides them below zoom 12
    for want in (1, 2):
        width, alpha = TRACK[want]
        for sec, prom, _line, pts, _term in feats:
            if prom != want or len(pts) < 2:
                continue
            if all(not (bs <= la <= bn and bw <= lo <= be) for la, lo in pts):
                continue
            d = " ".join(("M" if i == 0 else "L") + "%.1f %.1f" % proj(la, lo)
                         for i, (la, lo) in enumerate(pts))
            stroke = palette[sec] if sec < len(palette) else UNREACHED
            parts.append(f'<path d="{d}" fill="none" stroke="{stroke}" '
                         f'stroke-width="{width}" stroke-opacity="{alpha}" stroke-linecap="round"/>')

    # Stations last and in tier order, so the terminals land on top of the
    # suburban dots that crowd around them.
    def tier(st):
        if st.get("crs") in termini:
            return 2
        return 1 if st.get("major") or stats.get(st.get("crs"), 0) >= 60 else 0

    rows = [st for st in stations.values()
            if (st.get("crs") or st.get("terminus"))
            and bs <= st["lat"] <= bn and bw <= st["lon"] <= be]
    for want in (0, 1, 2):
        r, ring = DOT[want]
        for st in rows:
            if tier(st) != want:
                continue
            x, y = proj(st["lat"], st["lon"])
            c = colour_of.get(st.get("sector"), UNREACHED)
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" '
                         f'fill="{CORE}" stroke="{c}" stroke-width="{ring}"/>')

    # legend
    ly = 34
    parts.append('<g font-family="Helvetica,Arial" font-size="15">')
    for s in sectors["sectors"]:
        parts.append(f'<rect x="26" y="{ly-8}" width="20" height="3.5" rx="1.7" fill="{s["colour"]}"/>'
                     f'<text x="56" y="{ly}" fill="#a5b1bf">{escape(s["label"])}</text>')
        ly += 24
    parts.append('</g></svg>')

    with open(out, "w") as f:
        f.write("\n".join(parts))
    print(f"wrote {out} ({os.path.getsize(out)/1e6:.1f} MB) "
          f"— {meta['count']} ways, {len(rows)} stations in view")


if __name__ == "__main__":
    main()
