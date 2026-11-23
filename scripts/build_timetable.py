#!/usr/bin/env python3
"""Pack the timetable into a form the browser can route over.

Produces data/web/timetable.bin — a time-sorted list of connections (one
train's hop from one calling point to the next) plus short walking transfers
between stations that sit next to each other. That is everything the Connection
Scan Algorithm in web/journey.js needs to answer "leave Worcester at 09:00,
when do I reach Sheffield, and where do I change".

Loaded only when the journey planner is first used, so the map still starts in
under a tenth of a second.

    python3 scripts/build_timetable.py          # uses the cached feed zip
"""
import argparse, datetime, json, math, os, struct, sys, zipfile
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ingest_dtd as D
import names

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "data", "web")
ZIP = os.path.join(ROOT, "data", "raw", "dtd-timetable.zip")

WALK_MAX_M = 900        # how far a same-town change may be
WALK_SPEED = 75.0       # metres a minute, allowing for streets and crossings
WALK_MIN = 4            # nobody changes station in under this


def haversine(a, b):
    p = math.pi / 180
    dlat, dlon = (b[0] - a[0]) * p, (b[1] - a[1]) * p
    x = (math.sin(dlat / 2) ** 2
         + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin(dlon / 2) ** 2)
    return 6371000 * 2 * math.asin(math.sqrt(x))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", default=ZIP)
    ap.add_argument("--weekday", type=int, default=D.WEEKDAY)
    args = ap.parse_args()
    if not os.path.exists(args.zip):
        sys.exit(f"{args.zip} not found — run scripts/ingest_dtd.py first")

    zf = zipfile.ZipFile(args.zip)
    mca = next(n for n in zf.namelist() if n.upper().endswith(".MCA"))
    msn = next(n for n in zf.namelist() if n.upper().endswith(".MSN"))
    msn_text = zf.read(msn).decode("latin-1")
    tiploc_crs, crs_name = D.parse_msn(msn_text)
    change_times = D.parse_msn_change_times(msn_text)

    on_date = datetime.date.today()
    saved = D.WEEKDAY
    D.WEEKDAY = args.weekday
    trips, tocs = D.parse_mca(zf.read(mca).decode("latin-1"), tiploc_crs, on_date,
                              with_toc=True)
    D.WEEKDAY = saved
    day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][args.weekday]
    print(f"{len(trips)} passenger schedules running on a {day}, valid {on_date}")

    # ---- stop table: only stations that actually appear in a service
    used = sorted({crs for t in trips for crs, _a, _d in t})
    idx = {crs: i for i, crs in enumerate(used)}
    print(f"{len(used)} stations appear in the timetable")

    # ---- connections
    conns = []
    for tid, stops in enumerate(trips):
        stops = D.unwrap(stops)
        for (ca, _aa, da), (cb, ab, _db) in zip(stops, stops[1:]):
            if da is None or ab is None or ab < da:
                continue
            conns.append((int(da), int(ab), idx[ca], idx[cb], tid))
    conns.sort(key=lambda c: c[0])
    print(f"{len(conns)} connections")

    # ---- walking transfers between stations that are practically the same place
    try:
        with open(os.path.join(WEB, "stations.json")) as f:
            known = json.load(f)["stations"]
    except FileNotFoundError:
        known = {}
    pos = {c: (known[c]["lat"], known[c]["lon"]) for c in used if c in known}
    cell = {}
    for c, (la, lo) in pos.items():
        cell.setdefault((round(la / 0.01), round(lo / 0.01)), []).append(c)
    walks, seen = [], set()
    for (cy, cx), members in cell.items():
        near = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                near += cell.get((cy + dy, cx + dx), [])
        for a in members:
            for b in near:
                if a == b or (a, b) in seen:
                    continue
                d = haversine(pos[a], pos[b])
                if d <= WALK_MAX_M:
                    seen.add((a, b))
                    mins = max(WALK_MIN, int(round(d / WALK_SPEED)) + 2)
                    walks.append((idx[a], idx[b], mins))
    # Sorted by origin so web/journey.js can build a CSR index over them and
    # look up "what can I walk to from here" in O(degree). Unsorted, the prefix
    # sum addresses the wrong slice — this sort is load-bearing, not tidiness.
    walks.sort(key=lambda w: w[0])
    print(f"{len(walks)} walking transfers within {WALK_MAX_M} m")

    # ---- pack
    n_conn, n_walk = len(conns), len(walks)
    head = 36
    a4 = lambda x: (x + 3) & ~3
    off_conn = a4(head)
    off_walk = a4(off_conn + n_conn * 10)
    off_toc = a4(off_walk + n_walk * 6)
    off_chg = a4(off_toc + len(trips) * 2)
    total = off_chg + len(used)

    buf = bytearray(total)
    # TTB2 adds the per-station minimum change times. web/journey.js refuses an
    # older file by magic rather than reading the new section out of a header
    # that does not have one.
    buf[0:4] = b"TTB2"
    struct.pack_into("<8I", buf, 4, len(used), n_conn, n_walk,
                     off_conn, off_walk, off_toc, off_chg, total)
    for i, (dep, arr, a, b, tid) in enumerate(conns):
        struct.pack_into("<HHHHH", buf, off_conn + i * 10, dep, arr, a, b, tid)
    for i, (a, b, m) in enumerate(walks):
        struct.pack_into("<HHH", buf, off_walk + i * 6, a, b, m)
    # One uint16 per trip holding the two ATOC letters, low byte first. The
    # header has always reserved this section; nothing ever wrote it, so every
    # leg in the planner was operated by nobody.
    named = 0
    for i, toc in enumerate(tocs):
        code = (toc or "  ")[:2].ljust(2)
        if toc:
            named += 1
        struct.pack_into("<H", buf, off_toc + i * 2,
                         ord(code[0]) | (ord(code[1]) << 8))
    print(f"{named}/{len(tocs)} schedules carry an operator code")
    # One byte per station: the operator's own minimum interchange time. The
    # planner used a flat 5 minutes everywhere, which is 10 minutes optimistic
    # at Euston and produces changes nobody could make.
    got = 0
    for i, crs in enumerate(used):
        v = change_times.get(crs)
        if v:
            got += 1
        buf[off_chg + i] = min(255, v or D.MIN_CONNECTION)
    nondefault = sum(1 for c in used if change_times.get(c, 5) != 5)
    print(f"{got}/{len(used)} stations publish a change time "
          f"({nondefault} of them are not the 5-minute default)")

    path = os.path.join(WEB, "timetable.bin")
    with open(path, "wb") as f:
        f.write(buf)
    nice = names.load(WEB, {c: crs_name.get(c, c) for c in used})
    with open(os.path.join(WEB, "tt_stops.json"), "w") as f:
        json.dump({"day": day, "date": on_date.isoformat(), "stops": used,
                    "names": nice}, f, separators=(",", ":"))
    print(f"wrote timetable.bin ({total/1e6:.1f} MB) and tt_stops.json")


if __name__ == "__main__":
    main()
