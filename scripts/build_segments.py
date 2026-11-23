#!/usr/bin/env python3
"""Track geometry between adjacent stations, so a drawn route follows the rails.

The journey planner knows a route's calling points, but a line drawn between
their coordinates is a chord across open country — it cuts the corner at every
curve and crosses the Pennines in a straight line. This writes the actual
alignment between each pair of stations that are neighbours on the track, and
web/app.js stitches them together to draw a route.

Reuses the graph build_network.py already constructs: every OSM way is an edge,
stations are snapped to the nearest running-line node. Adjacency then comes from
a Voronoi partition of the whole graph over those station nodes — every node is
assigned to its nearest station along the rails, and two stations are neighbours
exactly where their territories touch.

That indirection is the point. Stopping a search "at the first station node"
does not work: a station is one node but its layout is many parallel ones, so
the search walks straight past on an adjacent track and calls Aberdeen a
neighbour of Dundee. On the real data that produced 130,817 pairs and 86 MB.
The partition has no such hole — a boundary between two territories is a real
boundary — and it costs one multi-source Dijkstra rather than one per station.

    python3 scripts/build_segments.py        # needs data/raw from `make fetch`

Writes data/web/segments.bin + data/web/seg_stops.json.
"""
import datetime, heapq, json, math, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_network as B

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "web")

# A neighbour further than this is not a neighbour, it is a gap in the graph.
# The longest real gap in Britain is Georgemas Junction to Forsinard, ~50 km.
MAX_SEG_M = 70000
SIMPLIFY_M = 12          # the route is drawn over a basemap, not surveyed


def partition(g, sources):
    """Multi-source Dijkstra: every node's nearest station, distance and parent.

    build_network.Graph.voronoi returns labels only; the path back to the
    station is what draws the line, so this keeps the predecessor too.
    """
    n = len(g.coords)
    dist = [math.inf] * n
    label = [None] * n
    prev = [-1] * n
    pq = []
    for node, sid in sources.items():
        dist[node] = 0.0
        label[node] = sid
        pq.append((0.0, node))
    heapq.heapify(pq)
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, w, _way in g.adj[u]:
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                label[v] = label[u]
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    return label, dist, prev


def path_to_source(prev, node):
    """Node -> its station, walking the partition's parent pointers."""
    out, u, guard = [node], node, 0
    while prev[u] != -1 and guard < 200000:
        u = prev[u]
        out.append(u)
        guard += 1
    out.reverse()
    return out


def main():
    ways = B.load_ways()
    stations = B.load_stations()
    print(f"ways: {len(ways)}   stations: {len(stations)}")

    g = B.Graph()
    running = set()
    for w in ways.values():
        pts = [(p["lat"], p["lon"]) for p in w["geometry"]]
        idx = [g.node(la, lo) for la, lo in pts]
        for a, b, pa, pb in zip(idx, idx[1:], pts, pts[1:]):
            g.edge(a, b, B.haversine(pa, pb))
        if B.prominence(w.get("tags") or {}) == 2:
            running.update(idx)
    print(f"graph: {len(g.coords)} nodes, {len(running)} on running lines")

    snap = B.PointIndex(g.coords, running)
    station_node, station_of_node = {}, {}
    for key, st in stations.items():
        n, _d = snap.nearest(st["lat"], st["lon"], B.STATION_SNAP_M)
        if n is not None:
            station_node[key] = n
            station_of_node.setdefault(n, key)
    print(f"{len(station_node)} stations snapped onto the graph")

    # ---- partition the whole graph over the stations, once
    label, dist, prev = partition(g, {n: s for s, n in station_node.items()})
    labelled = sum(1 for x in label if x is not None)
    print(f"partition: {labelled}/{len(label)} nodes assigned to a station")

    # ---- two stations are neighbours where their territories touch. The
    # cheapest boundary edge between a pair gives the path: down one side, over
    # the edge, and back up the other.
    best = {}
    for u in range(len(g.coords)):
        lu = label[u]
        if lu is None:
            continue
        for v, w, _way in g.adj[u]:
            lv = label[v]
            if lv is None or lv == lu:
                continue
            total = dist[u] + w + dist[v]
            if total > MAX_SEG_M:
                continue
            key = (lu, lv) if lu < lv else (lv, lu)
            if key not in best or total < best[key][0]:
                best[key] = (total, u, v)

    segs = {}
    for (a, b), (d, u, v) in best.items():
        # u is on one side of the boundary, v on the other. The path runs
        # station_a -> ... -> u, across the edge to v, then v -> ... -> station_b.
        # path_to_source returns [station ... node], so the far side is reversed.
        side_u = path_to_source(prev, u)
        side_v = path_to_source(prev, v)
        if label[u] == a:
            nodes = side_u + side_v[::-1]
        else:
            nodes = side_v + side_u[::-1]
        pts = [g.coords[n] for n in nodes]
        # drop consecutive duplicates the join can introduce
        pts = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
        if len(pts) >= 2:
            segs[(a, b)] = (d, pts)
    print(f"{len(segs)} adjacent station pairs")

    # ---- pack
    keys = sorted({s for pair in segs for s in pair})
    idx = {s: i for i, s in enumerate(keys)}
    rows, coords = [], []
    dropped = 0
    for (a, b), (d, pts) in sorted(segs.items()):
        simple = B.simplify(pts, SIMPLIFY_M)
        if len(simple) < 2 or len(simple) > 65535:
            dropped += 1
            continue
        rows.append((idx[a], idx[b], len(coords), len(simple), min(65535, int(d))))
        coords.extend(simple)
    print(f"{len(rows)} segments, {len(coords)} points"
          + (f", {dropped} dropped" if dropped else ""))

    head = 24
    a4 = lambda x: (x + 3) & ~3
    off_rows = a4(head)
    off_pts = a4(off_rows + len(rows) * 12)
    total = off_pts + len(coords) * 8

    buf = bytearray(total)
    buf[0:4] = b"SEG1"
    struct.pack_into("<5I", buf, 4, len(keys), len(rows), off_rows, off_pts, total)
    for i, (a, b, start, n, d) in enumerate(rows):
        struct.pack_into("<HHIHH", buf, off_rows + i * 12, a, b, start, n, d)
    for i, (la, lo) in enumerate(coords):
        struct.pack_into("<ii", buf, off_pts + i * 8,
                         int(round(la * 1e5)), int(round(lo * 1e5)))

    with open(os.path.join(OUT, "segments.bin"), "wb") as f:
        f.write(buf)
    with open(os.path.join(OUT, "seg_stops.json"), "w") as f:
        json.dump({"generated": datetime.date.today().isoformat(), "stops": keys},
                  f, separators=(",", ":"))
    print(f"wrote segments.bin ({total/1e6:.2f} MB) and seg_stops.json")


if __name__ == "__main__":
    main()
