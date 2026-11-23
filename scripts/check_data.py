#!/usr/bin/env python3
"""Assert that the generated data has every field web/app.js reads.

Cheap insurance against a renamed key silently blanking the map: the browser
would just show empty tooltips, whereas this fails loudly in the build.
"""
import json, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netbin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "data", "web")
errors, warnings = [], []


def need(cond, msg):
    if not cond:
        errors.append(msg)


def warn(msg):
    """Note something the build can live with. Printed, never fatal.

    This existed only as calls, never as a definition — the one call site sat in
    an `else` branch that a complete build never takes, so the NameError waited
    for the first run without segments.bin to surface it.
    """
    warnings.append(msg)


def load(name):
    path = os.path.join(WEB, name)
    if not os.path.exists(path):
        errors.append(f"{name} is missing — run make data")
        return None
    return json.load(open(path))


sectors = load("sectors.json")
stations = load("stations.json")
times = load("times.json")
paths = load("paths.json")
try:
    feats, netmeta = netbin.read(os.path.join(WEB, "network.bin"))
except (FileNotFoundError, ValueError) as exc:
    errors.append(f"network.bin: {exc}")
    feats, netmeta = [], {"count": 0, "points": 0, "bytes": 0}
if errors:
    print("\n".join("  ✗ " + e for e in errors))
    sys.exit(1)

# --- sectors.json
need(len(sectors["sectors"]) == 8, "expected 8 sectors")
for s in sectors["sectors"]:
    need(all(k in s for k in ("key", "label", "colour", "termini")),
         f"sector {s.get('key')} missing a field")
need(len(sectors["termini"]) == 14, "expected 14 London termini")
for crs, t in sectors["termini"].items():
    need(all(k in t for k in ("name", "sector", "lat", "lon")), f"terminus {crs} incomplete")
    need(t["sector"] in {s["key"] for s in sectors["sectors"]}, f"terminus {crs} has an unknown sector")
need("unreached" in sectors, "sectors.json has no unreached colour")

# --- network.bin
keys = {s["key"] for s in sectors["sectors"]}
nsec = len(sectors["sectors"])
lines = sectors.get("lines") or [""]
need(len(feats) > 10000, f"only {len(feats)} track features — expected tens of thousands")
need(all(0 <= f[0] <= nsec for f in feats), "a feature has a sector index out of range")
need(all(f[1] in (0, 1, 2) for f in feats), "a feature has a bad prominence flag")
need(all(f[2] < len(lines) for f in feats), "a feature points at a line index that does not exist")
need(all(len(f[3]) >= 2 for f in feats), "a feature has a degenerate geometry")
need(lines[0] == "", "line index 0 must be the empty 'unnamed' slot")
unlabelled = sum(1 for f in feats if f[0] == 0)
named = sum(1 for f in feats if f[2])
if unlabelled > len(feats) * 0.20:
    warnings.append(f"{unlabelled} of {len(feats)} features reach no terminus")
if named < len(feats) * 0.15:
    warnings.append(f"only {named} of {len(feats)} features carry a line name")

# --- paths.json (drives the click-to-highlight route)
if paths:
    need(all(isinstance(v.get("f"), list) and v["f"] for v in paths.values()),
         "a path chain has no segments")
    bad_idx = sum(1 for v in paths.values() for i in v["f"] if not (0 <= i < len(feats)))
    need(bad_idx == 0, f"{bad_idx} path segments point outside the feature list")
    need(all(v.get("first", -1) >= 0 for v in paths.values()),
         "a path chain has no recorded first segment")
    dangling = [k for k, v in paths.items() if v.get("next") and v["next"] not in paths]
    if len(dangling) > len(paths) * 0.1:
        warnings.append(f"{len(dangling)} path chains point at a station with no chain")

# --- stations.json
sts = stations["stations"]
need(len(sts) > 1000, f"only {len(sts)} stations")
for sid, st in sts.items():
    need(st.get("id") == sid, f"station {sid} id mismatch")
    need(isinstance(st.get("name"), str) and st["name"], f"station {sid} has no name")
    need(isinstance(st.get("lat"), (int, float)) and isinstance(st.get("lon"), (int, float)),
         f"station {sid} has no position")
    need("major" in st and "terminus" in st and "sector" in st and "dist" in st,
         f"station {sid} missing a computed field")
    if st.get("sector"):
        need(st["sector"] in keys, f"station {sid} has an unknown sector")

# --- times.json
need(times.get("source") in ("estimate", "timetable"), "times.json has no valid source")
need("generated" in times, "times.json has no generated date")
n_missing = 0
for crs, rec in times["stations"].items():
    if crs not in sts:
        n_missing += 1
        continue
    need("best" in rec and "all" in rec, f"times for {crs} incomplete")
    b = rec["best"]
    need(isinstance(b.get("mins"), int) and (b["mins"] > 0 or b.get("src") == "terminus"),
         f"times for {crs} has a bad duration")
    need(b.get("terminus") in sectors["termini"], f"times for {crs} names an unknown terminus")
    need("est" in b, f"times for {crs} does not say whether it is estimated")
need(n_missing == 0, f"{n_missing} time entries refer to stations that do not exist")

# ---- segments.bin: the track geometry a drawn route follows.
# Optional, because the map works without it (routes fall back to chords), but
# if it is present it must be readable and must agree with the station set —
# a stale file silently draws last month's railway.
seg_path = os.path.join(WEB, "segments.bin")
n_seg = 0
if os.path.exists(seg_path):
    raw = open(seg_path, "rb").read()
    need(raw[:4] == b"SEG1", "segments.bin has the wrong magic — rerun make segments")
    if raw[:4] == b"SEG1":
        n_st, n_seg, off_rows, off_pts, total = struct.unpack_from("<5I", raw, 4)
        need(total == len(raw),
             f"segments.bin claims {total} bytes but is {len(raw)}")
        seg_stops = json.load(open(os.path.join(WEB, "seg_stops.json")))["stops"]
        need(len(seg_stops) == n_st,
             f"seg_stops.json lists {len(seg_stops)} stations, segments.bin says {n_st}")
        unknown = [k for k in seg_stops if k not in sts]
        need(not unknown,
             f"{len(unknown)} segment stations are not in stations.json "
             f"({', '.join(unknown[:5])}) — rebuild both together")
        # spot-check the last row addresses real points
        if n_seg:
            a, b, start, cnt, _m = struct.unpack_from("<HHIHH", raw, off_rows + (n_seg - 1) * 12)
            need(cnt >= 2, "a segment has fewer than two points")
            need(off_pts + (start + cnt) * 8 <= len(raw),
                 "a segment's points run past the end of the file")
else:
    warn("no segments.bin — planned routes will be drawn as straight chords")

# ---- prices.json: the house price overlay. Optional — the button says so when
# it is absent — but a present file that lies is worse than a missing one, since
# the UI labels every figure in it as a published measurement.
prices_path = os.path.join(WEB, "prices.json")
n_prices = 0
if os.path.exists(prices_path):
    pr = json.load(open(prices_path))
    need(isinstance(pr.get("points"), list) and pr["points"],
         "prices.json has no points")
    need(pr.get("fields") == ["label", "lat", "lon", "price", "sales", "radiusKm", "kind"],
         "prices.json field order has changed — web/prices.js unpacks it positionally")
    kinds = pr.get("kinds") or []
    need(len(kinds) == 2 and [k.get("key") for k in kinds] == ["district", "council"],
         "prices.json must declare the district and council kinds, in that order")
    for k in kinds:
        need(all(k.get(f) for f in ("stat", "source", "licence", "provenance")),
             f"price kind {k.get('key')} is missing its provenance fields")
    rng = pr.get("range") or {}
    need(all(isinstance(rng.get(f), int) for f in ("min", "max", "p5", "p95", "median")),
         "prices.json has no usable range — web/prices.js scales the ramp from it")
    n_prices = len(pr["points"])
    bad = [p for p in pr["points"] if len(p) != 7]
    need(not bad, f"{len(bad)} price points do not have seven fields")
    # Great Britain, and a price nobody could mistake for a typo.
    out = [p for p in pr["points"]
           if not (49.8 <= p[1] <= 61.0 and -8.5 <= p[2] <= 2.0)]
    need(not out, f"{len(out)} price points fall outside Great Britain")
    silly = [p for p in pr["points"] if not (10_000 <= p[3] <= 20_000_000)]
    need(not silly, f"{len(silly)} price points have an implausible price")
    need(all(0 < p[5] <= 100 for p in pr["points"]),
         "a price point has an influence radius outside 0-100 km")
    if not any(p[6] == 1 for p in pr["points"]):
        warn("prices.json has no Scottish council areas — Scotland will be blank")
else:
    warn("no prices.json — the House prices button will say it is unavailable")

# ---- places.json: what the search box can jump to besides stations.
places_path = os.path.join(WEB, "places.json")
n_places = 0
if os.path.exists(places_path):
    pl = json.load(open(places_path))
    need(pl.get("fields") == ["name", "lat", "lon", "rank", "areaIndex"],
         "places.json field order has changed — web/app.js unpacks it positionally")
    ranks = pl.get("ranks") or []
    areas = pl.get("areas") or []
    need(len(ranks) >= 2, "places.json needs at least two ranks to order a search")
    need(len(areas) > 100, f"only {len(areas)} local authorities — expected ~400")
    rows = pl.get("places") or []
    n_places = len(rows)
    need(n_places > 5000, f"only {n_places} places — expected tens of thousands")
    need(all(len(r) == 5 for r in rows), "a place row does not have five fields")
    need(all(0 <= r[3] < len(ranks) for r in rows),
         "a place has a rank index that does not exist")
    need(all(0 <= r[4] < len(areas) for r in rows),
         "a place points at an area index that does not exist")
    out = [r for r in rows if not (49.8 <= r[1] <= 61.0 and -8.5 <= r[2] <= 2.0)]
    need(not out, f"{len(out)} places fall outside Great Britain")
    # The whole point of carrying the local authority is telling the Newports
    # apart. An empty string in the table would put them back together.
    need(all(a.strip() for a in areas), "an area name in places.json is blank")
else:
    warn("no places.json — search will cover stations only")

with_times = sum(1 for sid in sts if sid in times["stations"])
print(f"  sectors   {nsec}, termini {len(sectors['termini'])}, named lines {len(lines)-1}")
print(f"  network   {netmeta['count']} features, {netmeta['points']} points, "
      f"{netmeta['bytes']/1e6:.1f} MB, {unlabelled} unlabelled, {named} named")
print(f"  paths     {len(paths)} station chains")
print(f"  segments  {n_seg} station-to-station alignments"
      if n_seg else "  segments  none (routes drawn as chords)")
print(f"  stations  {len(sts)} total, {with_times} with a journey time")
print(f"  times     source={times['source']}, generated {times['generated']}, "
      f"{sum(1 for r in times['stations'].values() if not r['best']['est'])} exact")
print(f"  prices    {n_prices} areas" if n_prices else "  prices    none (overlay unavailable)")
print(f"  places    {n_places} searchable" if n_places else "  places    none (stations only)")
for w in warnings:
    print(f"  ! {w}")
if errors:
    print("\n".join("  ✗ " + e for e in errors))
    sys.exit(1)
print("  data contract OK")
