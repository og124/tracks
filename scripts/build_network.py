#!/usr/bin/env python3
"""Turn the raw Overpass tiles into the files the web app loads.

  data/web/sectors.json     the terminus/sector/colour table
  data/web/network.bin      simplified track geometry, each way tagged with the
                            London terminus its shortest along-track path reaches
  data/web/stations.json    de-duplicated stations snapped onto the track graph,
                            with along-track distance to every reachable terminus

Two things matter for correctness here:

* Every way goes into the graph, sidings and crossovers included. Big station
  throats are tied together by ways tagged service=crossover/spur, and dropping
  them fragments the network -- with them excluded, Clapham Junction came out
  37 km from Waterloo instead of 6. They are still kept off the map at low zoom
  via the prominence flag.
* Stations and terminus anchors snap only to *running lines*, never to a siding
  that happens to be a few metres closer.

The detour report at the end is the guard against both classes of bug: if
along-track distance is wildly out of line with straight-line distance, the
graph is broken somewhere and it says so instead of shipping bad numbers.
"""
import datetime, glob, heapq, json, math, os, re, struct, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from termini import (LONDON_TERMINI, SECTORS, SECTOR_OF_CRS,
                     TERMINUS_NAME, UNREACHED_COLOUR)
from seed_times import SEED, ANCHOR_TERMINUS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "web")

SNAP = 1e6              # coordinate quantisation for node identity (~0.1 m)
STATION_SNAP_M = 500    # how far a station may sit from a running line
TERMINUS_SNAP_M = 900
SIMPLIFY_M = 5          # Douglas-Peucker tolerance, metres. At 12 m the
                        # curves visibly facet once you are zoomed past z15;
                        # 5 m is about a pixel there and costs little, because
                        # most OSM rail ways are short junction-to-junction
                        # segments that simplify to two points either way.
DETOUR_FLAG = 2.4       # track_km / crow_km above this is reported as suspect

# Stations drawn at every zoom level. SEED is the curated list of principal
# calling points, which is exactly the set worth showing on a zoomed-out map.
PRINCIPAL = set(SEED) | {t[0] for t in LONDON_TERMINI}

SERVICE_TAGS = {"siding", "yard", "spur", "crossover", "industrial"}

# The fetch bbox has to reach lon 1.45 to take in Ramsgate and Deal, which also
# scoops up the Pas-de-Calais, and the graph happily runs through the Channel
# Tunnel -- Abbeville turned up in the station list as 3h21 from St Pancras.
# Nothing British lies south of 51.05 and east of 1.30 (Dover is 51.13, 1.31).
EXCLUDE = [
    (-90.0, 1.30, 51.05, 180.0),     # Pas-de-Calais, reachable via the tunnel
    (51.30, -11.0, 55.50, -5.40),    # the island of Ireland: a separate network
]


def excluded(lat, lon):
    return any(s <= lat <= n and w <= lon <= e for s, w, n, e in EXCLUDE)


# ---------------------------------------------------------------- geometry --

def haversine(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    p = math.pi / 180
    dlat, dlon = (lat2 - lat1) * p, (lon2 - lon1) * p
    x = (math.sin(dlat / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(dlon / 2) ** 2)
    return 6371000 * 2 * math.asin(math.sqrt(x))


def perp_m(pt, a, b):
    ky = 111320.0
    kx = ky * math.cos(a[0] * math.pi / 180)
    px, py = (pt[1] - a[1]) * kx, (pt[0] - a[0]) * ky
    bx, by = (b[1] - a[1]) * kx, (b[0] - a[0]) * ky
    d2 = bx * bx + by * by
    if d2 == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / d2))
    return math.hypot(px - t * bx, py - t * by)


def simplify(pts, tol_m):
    """Iterative Douglas-Peucker; recursion overflows on the longest ways."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        worst, wi = -1.0, -1
        for k in range(i + 1, j):
            d = perp_m(pts[k], pts[i], pts[j])
            if d > worst:
                worst, wi = d, k
        if worst > tol_m:
            keep[wi] = True
            stack.append((i, wi))
            stack.append((wi, j))
    return [p for p, k in zip(pts, keep) if k]


# ------------------------------------------------------------------- input --

def prominence(tags):
    """2 = passenger running line, 1 = freight/secondary, 0 = yard or siding."""
    if tags.get("service") in SERVICE_TAGS:
        return 0
    if tags.get("railway") in ("light_rail", "narrow_gauge"):
        return 1
    if tags.get("passenger") == "no" or tags.get("usage") in ("industrial", "freight"):
        return 1
    if tags.get("usage") in ("main", "branch") or not tags.get("usage"):
        return 2
    return 1


def load_ways():
    ways = {}
    for path in sorted(glob.glob(os.path.join(RAW, "lines_*.json"))):
        with open(path) as f:
            for el in json.load(f)["elements"]:
                if el.get("type") == "way" and el.get("geometry"):
                    if all(excluded(p["lat"], p["lon"]) for p in el["geometry"]):
                        continue
                    ways[el["id"]] = el
    return ways


def load_routes():
    """way id -> line name, from OSM's route relations ("West of England Line").

    Relations are the good source: they name a whole line end to end, where the
    name tag on an individual way is patchy and often just a local section.
    """
    out = {}
    for path in sorted(glob.glob(os.path.join(RAW, "routes_*.json"))):
        with open(path) as f:
            for el in json.load(f)["elements"]:
                tags = el.get("tags") or {}
                name = tags.get("name")
                if not name or el.get("type") != "relation":
                    continue
                for m in el.get("members", ()):
                    if m.get("type") == "way":
                        # first relation wins; they are processed in a stable
                        # order so a way's line name does not flip between runs
                        out.setdefault(m["ref"], name)
    return out


CRS_KEYS = ("ref:crs", "naptan:CrsCode", "ref:CRS", "crs")

# Metro/tram stops share the railway=station tag but not the network. A CRS code
# is not enough to tell them apart -- the Underground issues its own CRS-shaped
# codes (Kilburn is "ZKI"), which is how a Jubilee line station turned up as a
# South Western one. Keep a metro stop only where it is also a National Rail
# station, i.e. a genuine shared interchange.
NON_RAIL_KINDS = {"subway", "light_rail", "tram", "monorail", "funicular"}
NON_RAIL_NETWORKS = ("london underground", "docklands light railway", "tramlink",
                     "london trams", "tyne and wear metro")


def load_stations():
    out = {}
    for path in sorted(glob.glob(os.path.join(RAW, "stations_*.json"))):
        with open(path) as f:
            for el in json.load(f)["elements"]:
                tags = el.get("tags") or {}
                name = tags.get("name")
                if not name:
                    continue
                if el["type"] == "node":
                    lat, lon = el.get("lat"), el.get("lon")
                else:
                    c = el.get("center") or {}
                    lat, lon = c.get("lat"), c.get("lon")
                if lat is None or lon is None or excluded(lat, lon):
                    continue
                crs = next((tags[k].strip().upper() for k in CRS_KEYS if tags.get(k)), None)
                if crs and not re.fullmatch(r"[A-Z]{3}", crs):
                    crs = None
                if tags.get("station") in NON_RAIL_KINDS:
                    who = f"{tags.get('network','')} {tags.get('operator','')}".lower()
                    if not crs or "national rail" not in who:
                        if any(x in who for x in NON_RAIL_NETWORKS) or not crs:
                            continue
                key = crs or f"osm{el['type'][0]}{el['id']}"
                if key in out and (out[key].get("crs") or not crs):
                    continue
                out[key] = {
                    "id": key, "name": name, "crs": crs, "lat": lat, "lon": lon,
                    "kind": tags.get("station", "rail"),
                    "operator": tags.get("operator"),
                    "network": tags.get("network"),
                    "tiploc": tags.get("ref:tiploc"),
                }
    return out


# ------------------------------------------------------------------- graph --

class PointIndex:
    """Grid index over a subset of graph nodes, for nearest-node snapping."""

    def __init__(self, coords, subset, cell=0.0025):
        self.coords = coords
        self.cell = cell
        self.grid = defaultdict(list)
        for i in subset:
            la, lo = coords[i]
            self.grid[(math.floor(la / cell), math.floor(lo / cell))].append(i)

    def nearest(self, lat, lon, max_m):
        best, bestd = None, max_m
        cy, cx = math.floor(lat / self.cell), math.floor(lon / self.cell)
        rings = int(max_m / (self.cell * 78000)) + 1
        for r in range(0, rings + 1):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if r and max(abs(dy), abs(dx)) != r:
                        continue          # only the new ring
                    for i in self.grid.get((cy + dy, cx + dx), ()):
                        d = haversine((lat, lon), self.coords[i])
                        if d < bestd:
                            best, bestd = i, d
            if best is not None and r >= 1:
                break
        return best, (bestd if best is not None else None)


class Graph:
    def __init__(self):
        self.index = {}
        self.coords = []
        self.adj = defaultdict(list)

    def node(self, lat, lon):
        key = (int(round(lat * SNAP)), int(round(lon * SNAP)))
        i = self.index.get(key)
        if i is None:
            i = len(self.coords)
            self.index[key] = i
            self.coords.append((lat, lon))
        return i

    def edge(self, a, b, w, way=-1):
        if a != b:
            self.adj[a].append((b, w, way))
            self.adj[b].append((a, w, way))

    def voronoi(self, sources):
        """Multi-source Dijkstra that propagates each source's label outward.

        Gives every node the label of the nearest labelled station along the
        rails, which is how a station's London terminus is decided.
        """
        dist = [math.inf] * len(self.coords)
        label = [None] * len(self.coords)
        pq = []
        for n, lab in sources.items():
            dist[n] = 0.0
            label[n] = lab
            heapq.heappush(pq, (0.0, n))
        heapq.heapify(pq)
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for v, w, _way in self.adj[u]:
                nd = d + w
                if nd < dist[v]:
                    dist[v] = nd
                    label[v] = label[u]
                    heapq.heappush(pq, (nd, v))
        return label

    def dijkstra(self, src):
        dist = [math.inf] * len(self.coords)
        dist[src] = 0.0
        pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for v, w, _way in self.adj[u]:
                nd = d + w
                if nd < dist[v]:
                    dist[v] = nd
                    heapq.heappush(pq, (nd, v))
        return dist


# ------------------------------------------------------------------ output --

def write_network_bin(path, feats):
    """Self-describing binary geometry. Header carries every section offset, so
    the reader never has to recompute alignment.

    JSON cost about 2.5x the bytes and roughly a second of JSON.parse for the
    whole of Britain; this drops straight into typed arrays.
    """
    n = len(feats)
    npts = sum(len(f["pts"]) for f in feats)

    sector = bytearray(n)
    term = bytearray(n)
    prom = bytearray(n)
    line = bytearray(n * 2)
    counts = bytearray(n * 2)
    coords = bytearray(npts * 8)
    ci = 0
    for i, f in enumerate(feats):
        sector[i] = f["sector"]
        term[i] = f["term"]
        prom[i] = f["prom"]
        struct.pack_into("<H", line, i * 2, f["line"])
        struct.pack_into("<H", counts, i * 2, len(f["pts"]))
        for la, lo in f["pts"]:
            struct.pack_into("<ii", coords, ci, int(round(la * 1e5)), int(round(lo * 1e5)))
            ci += 8

    head = 40
    def align4(x):
        return (x + 3) & ~3
    off_sector = align4(head)
    off_term = align4(off_sector + n)
    off_prom = align4(off_term + n)
    off_line = align4(off_prom + n)
    off_counts = align4(off_line + n * 2)
    off_coords = align4(off_counts + n * 2)
    total = off_coords + npts * 8

    buf = bytearray(total)
    buf[0:4] = b"TRK2"
    struct.pack_into("<9I", buf, 4, n, npts, off_sector, off_term, off_prom,
                     off_line, off_counts, off_coords, total)
    buf[off_sector:off_sector + n] = sector
    buf[off_term:off_term + n] = term
    buf[off_prom:off_prom + n] = prom
    buf[off_line:off_line + n * 2] = line
    buf[off_counts:off_counts + n * 2] = counts
    buf[off_coords:off_coords + npts * 8] = coords
    with open(path, "wb") as f:
        f.write(buf)
    return total, npts


def trace_paths(g, dists, stations_at_node, station_node, station_term):
    """For each station, the run of track between it and the next station on the
    way to London, plus which station that is.

    Stored as a chain rather than a full route per station: the browser walks
    from a station down to the terminus, collecting segments. Full paths would
    repeat the same trunk thousands of times -- Reading to Paddington would be
    stored once per station west of Reading.
    """
    chains = {}
    for sid, node in station_node.items():
        term = station_term.get(sid)
        if term is None or node is None or term not in dists:
            continue
        dist = dists[term]
        if dist[node] == math.inf:
            continue
        seen, feats, u, nxt, first = {node}, [], node, None, -1
        for _step in range(20000):
            best = None
            for v, _w, way in g.adj[u]:
                if v in seen or dist[v] >= dist[u]:
                    continue
                if best is None or dist[v] < dist[best[0]]:
                    best = (v, way)
            if best is None:
                break
            v, way = best
            if way >= 0:
                if first < 0:
                    first = way          # the segment leaving this station
                feats.append(way)
            seen.add(v)
            u = v
            other = stations_at_node.get(v)
            if other and other != sid:
                nxt = other
                break
        if feats:
            # "f" is sorted for compactness, so the first segment is recorded
            # separately -- the app reads it to find which named line the
            # station sits on, and sorted order would hand back an arbitrary one
            chains[sid] = {"f": sorted(set(feats)), "next": nxt, "first": first}
    return chains


# -------------------------------------------------------------------- main --

def main():
    os.makedirs(OUT, exist_ok=True)
    ways = load_ways()
    route_of = load_routes()
    stations = load_stations()
    print(f"ways: {len(ways)}   stations: {len(stations)} "
          f"({sum(1 for s in stations.values() if s['crs'])} with a CRS code)")

    g = Graph()
    way_nodes, way_prom, running = {}, {}, set()
    order = list(ways)
    findex = {wid: i for i, wid in enumerate(order)}     # stable feature index
    for fidx, (wid, w) in enumerate(ways.items()):
        pts = [(p["lat"], p["lon"]) for p in w["geometry"]]
        idx = [g.node(la, lo) for la, lo in pts]
        for a, b, pa, pb in zip(idx, idx[1:], pts, pts[1:]):
            g.edge(a, b, haversine(pa, pb), fidx)
        way_nodes[wid] = idx
        prom = prominence(w.get("tags") or {})
        way_prom[wid] = prom
        if prom == 2:
            running.update(idx)
    print(f"graph: {len(g.coords)} nodes, {len(running)} of them on running lines")

    snap_index = PointIndex(g.coords, running)

    dists = {}
    for crs, name, lat, lon in LONDON_TERMINI:
        src, d = snap_index.nearest(lat, lon, TERMINUS_SNAP_M)
        if src is None:
            print(f"  !! {crs} {name}: no running line within {TERMINUS_SNAP_M} m")
            continue
        dists[crs] = g.dijkstra(src)
        print(f"  {crs}  anchored {d:.0f} m from the platform centroid")

    # ---- which terminus does each stretch of railway actually serve?
    # Nearest-terminus-by-track is not good enough on its own: Victoria sits a
    # few hundred metres closer to the South Western main line than Waterloo
    # does, so pure geometry hands the Waterloo network to Victoria. Instead
    # grow a partition outward from the principal stations, each labelled with
    # the terminus its trains really run to, and let everything else inherit the
    # nearest label.
    #
    # The termini label themselves too, and both halves are needed. Without the
    # station anchors, near-ties in south London go to the wrong terminus; but
    # without the termini, inner London has no nearby anchor at all and the
    # partition floods it from whichever suburban station happens to be closest
    # -- which turned the Paddington, Euston and St Pancras approaches into
    # South Western track. Station anchors sit at distance zero on their own
    # corridor, so they still win the near-ties that matter.
    anchor_nodes = {}
    unresolved = []
    for crs, term in ANCHOR_TERMINUS.items():
        st = stations.get(crs)
        if st is None:
            unresolved.append(crs)
            continue
        n, _d = snap_index.nearest(st["lat"], st["lon"], STATION_SNAP_M)
        if n is not None:
            anchor_nodes[n] = term
    for crs, _name, lat, lon in LONDON_TERMINI:
        n, _d = snap_index.nearest(lat, lon, TERMINUS_SNAP_M)
        if n is not None:
            anchor_nodes[n] = crs
    serves = g.voronoi(anchor_nodes)
    print(f"corridor labelling: {len(anchor_nodes)} anchors"
          + (f", {len(unresolved)} unresolved ({', '.join(sorted(unresolved))})" if unresolved else "")
          + f", {sum(1 for x in serves if x)} of {len(serves)} nodes labelled")

    # ---- tag every way with the terminus it funnels into, and name its line
    sector_index = {k: i + 1 for i, (k, _l, _c, _t) in enumerate(SECTORS)}   # 0 = unreached
    term_index = {crs: i + 1 for i, (crs, _n, _la, _lo) in enumerate(LONDON_TERMINI)}
    line_names = [""]
    line_index = {}

    # pass 1: a terminus per way, from the corridor partition
    raw = []
    for wid, w in ways.items():
        idx = way_nodes[wid]
        votes = defaultdict(int)
        for i in idx:
            if serves[i]:
                votes[serves[i]] += 1
        if votes:
            best_crs = max(votes, key=votes.get)
        else:
            best_crs, best_d = None, math.inf
            for crs, dist in dists.items():
                d = min(dist[i] for i in idx)
                if d < best_d:
                    best_crs, best_d = crs, d

        tags = w.get("tags") or {}
        name = route_of.get(wid) or tags.get("name") or ""
        if name and name not in line_index:
            line_index[name] = len(line_names)
            line_names.append(name)

        pts = [(p["lat"], p["lon"]) for p in w["geometry"]]
        length = sum(haversine(a, b) for a, b in zip(pts, pts[1:]))
        raw.append({"wid": wid, "crs": best_crs, "line": line_index.get(name, 0),
                     "len": length, "pts": pts})

    # pass 2: give every named line a single terminus, by length.
    #
    # The partition is grown from anchor stations, so its boundary lands wherever
    # two anchors happen to meet -- which is usually open country. On the ground
    # that showed up as the Wessex Main Line turning from Paddington-orange to
    # Waterloo-purple somewhere between Warminster and Salisbury, with no
    # junction or station to explain it. Deciding per line instead means the
    # colour can only change where the line does, which is a real place.
    by_line = defaultdict(lambda: defaultdict(float))
    for r in raw:
        if r["line"] and r["crs"]:
            by_line[r["line"]][r["crs"]] += r["len"]
    line_crs = {li: max(v, key=v.get) for li, v in by_line.items()}
    changed = sum(1 for r in raw
                  if r["line"] and line_crs.get(r["line"]) not in (None, r["crs"]))

    feats = []
    for r in raw:
        crs = line_crs.get(r["line"], r["crs"]) if r["line"] else r["crs"]
        feats.append({
            "sector": sector_index.get(SECTOR_OF_CRS.get(crs), 0),
            "term": term_index.get(crs, 0),
            "prom": way_prom[r["wid"]],
            "line": r["line"],
            "pts": simplify(r["pts"], SIMPLIFY_M),
        })
    print(f"one colour per named line: {changed} ways recoloured to match their line")

    with open(os.path.join(OUT, "sectors.json"), "w") as f:
        json.dump({
            "sectors": [{"key": k, "label": l, "colour": c, "termini": codes}
                        for k, l, c, codes in SECTORS],
            "termini": {crs: {"name": TERMINUS_NAME[crs], "sector": SECTOR_OF_CRS[crs],
                               "lat": la, "lon": lo}
                         for crs, _n, la, lo in LONDON_TERMINI},
            "terminusOrder": [crs for crs, _n, _la, _lo in LONDON_TERMINI],
            "lines": line_names,
            "unreached": UNREACHED_COLOUR,
        }, f, indent=1)

    size, npts = write_network_bin(os.path.join(OUT, "network.bin"), feats)
    by_prom = defaultdict(int)
    for pr in way_prom.values():
        by_prom[pr] += 1
    print(f"wrote network.bin ({size/1e6:.1f} MB, {len(feats)} ways, {npts} points) — "
          f"{by_prom[2]} running, {by_prom[1]} freight/secondary, {by_prom[0]} yard/siding")
    print(f"named lines: {len(line_names)-1}; "
          f"{sum(1 for f in feats if f['line'])} of {len(feats)} ways carry one")


    # ---- snap stations, record along-track distance to every terminus
    out_st, detours = {}, []
    station_node, stations_at_node = {}, {}
    for key, st in stations.items():
        n, d = snap_index.nearest(st["lat"], st["lon"], STATION_SNAP_M)
        if n is not None:
            station_node[key] = n
            stations_at_node.setdefault(n, key)
        st = dict(st)
        st["snap_m"] = round(d) if n is not None else None
        st["dist"] = {}
        if n is not None:
            for crs, dist in dists.items():
                if dist[n] < math.inf:
                    st["dist"][crs] = round(dist[n] / 1000, 2)
        served = serves[n] if n is not None else None
        if served and served in st["dist"]:
            st["terminus"] = served
        else:
            st["terminus"] = min(st["dist"], key=st["dist"].get) if st["dist"] else None
        st["sector"] = SECTOR_OF_CRS.get(st["terminus"])
        st["major"] = st["crs"] in PRINCIPAL
        out_st[key] = st

        if st["terminus"]:
            t = next(x for x in LONDON_TERMINI if x[0] == st["terminus"])
            crow = haversine((st["lat"], st["lon"]), (t[2], t[3])) / 1000
            track = st["dist"][st["terminus"]]
            if crow > 8 and track / crow > DETOUR_FLAG:
                detours.append((track / crow, st["name"], st["terminus"], track, crow))

    with open(os.path.join(OUT, "stations.json"), "w") as f:
        json.dump({"generated": datetime.date.today().isoformat(),
                    "stations": out_st}, f, separators=(",", ":"))
    reach = sum(1 for s in out_st.values() if s["terminus"])
    print(f"wrote stations.json — {len(out_st)} stations, {reach} reach a terminus")

    chains = trace_paths(g, dists, stations_at_node, station_node,
                         {k: v["terminus"] for k, v in out_st.items()})
    with open(os.path.join(OUT, "paths.json"), "w") as f:
        json.dump(chains, f, separators=(",", ":"))
    seg = sum(len(c["f"]) for c in chains.values())
    print(f"wrote paths.json — {len(chains)} stations, {seg} segments "
          f"({os.path.getsize(os.path.join(OUT,'paths.json'))/1e6:.1f} MB)")

    if detours:
        detours.sort(reverse=True)
        print(f"\n  !! {len(detours)} stations have track distance > {DETOUR_FLAG}x "
              f"straight-line — likely gaps in the graph:")
        for ratio, name, crs, track, crow in detours[:12]:
            print(f"     {ratio:4.1f}x  {name[:32]:<32} {crs} {track:7.1f} km track "
                  f"vs {crow:6.1f} km direct")
    else:
        print("\n  detour check: clean — no station exceeds "
              f"{DETOUR_FLAG}x straight-line distance")


if __name__ == "__main__":
    main()
