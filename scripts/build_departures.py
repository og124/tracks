#!/usr/bin/env python3
"""Per-station departure boards from the DTD timetable feed.

Writes data/web/departures/<CRS>.json — one small file per station, fetched by
the app only when you click that station, so the map pays nothing for it up
front. A single combined file would be several megabytes for data you mostly
never look at.

    python3 scripts/build_departures.py            # uses the cached feed zip
    python3 scripts/build_departures.py --zip x.zip
"""
import argparse, collections, datetime, json, os, shutil, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ingest_dtd as D
import names

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "data", "web")
OUT = os.path.join(WEB, "departures")
ZIP = os.path.join(ROOT, "data", "raw", "dtd-timetable.zip")

# No practical cap. An earlier limit of 240 kept the *earliest* 240 departures,
# which at Waterloo meant the board stopped at about 05:30 and the app, looking
# for the next train from now, always fell back to "all of today's services have
# gone". Even the busiest terminus is only tens of kilobytes.
MAX_PER_STATION = 4000


def parse_boards(text, tiploc_crs, on_date, weekday):
    """crs -> [[dep_minutes, destination_crs, toc, platform], ...]

    Walks the MCA once. Same schedule filter as the journey-time ingest, so the
    board and the times agree about what is running.
    """
    boards = collections.defaultdict(list)
    keep, stops, toc = False, [], None

    def flush():
        if not (keep and len(stops) >= 2):
            return
        dest = stops[-1][0]
        for crs, dep, plat in stops[:-1]:
            if dep is not None and crs != dest:
                boards[crs].append([int(dep), dest, toc, plat or None])

    for line in text.splitlines():
        rid = line[:2]
        if rid == "BS":
            flush()
            stops, keep, toc = [], False, None
            if len(line) < 80:
                continue
            days, status, category, stp = line[21:28], line[29], line[30:32], line[79]
            rf, rt = D.cif_date(line[9:15]), D.cif_date(line[15:21])
            keep = (stp != "C" and status in D.PASSENGER_STATUS
                    and len(days) == 7 and days[weekday] == "1"
                    and category[:1] in ("O", "X")
                    and rf is not None and rt is not None and rf <= on_date <= rt)

        elif rid == "BX" and keep:
            toc = line[11:13].strip() or None

        elif rid == "LO" and keep:
            crs = tiploc_crs.get(line[2:9].strip())
            dep = D.hhmm(line[15:19])
            if crs:
                stops.append((crs, dep, line[19:22].strip()))

        elif rid == "LI" and keep:
            crs = tiploc_crs.get(line[2:9].strip())
            dep = D.hhmm(line[29:33])
            if crs and dep is not None:
                stops.append((crs, dep, line[33:36].strip()))

        elif rid == "LT" and keep:
            crs = tiploc_crs.get(line[2:9].strip())
            arr = D.hhmm(line[15:19])
            if crs and arr is not None:
                stops.append((crs, None, line[19:22].strip()))

    flush()
    return boards


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
    tiploc_crs, crs_name = D.parse_msn(zf.read(msn).decode("latin-1"))

    on_date = datetime.date.today()
    boards = parse_boards(zf.read(mca).decode("latin-1"), tiploc_crs, on_date, args.weekday)
    day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][args.weekday]
    print(f"built boards for {len(boards)} stations ({day}, valid {on_date})")

    # only keep stations this map actually shows
    try:
        with open(os.path.join(WEB, "stations.json")) as f:
            known = set(json.load(f)["stations"])
    except FileNotFoundError:
        known = set(boards)
        print("note: stations.json missing — writing every station")

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    written = total = 0
    for crs, rows in boards.items():
        if crs not in known:
            continue
        rows.sort(key=lambda r: r[0])
        if len(rows) > MAX_PER_STATION:
            rows = rows[:MAX_PER_STATION]
        with open(os.path.join(OUT, f"{crs}.json"), "w") as f:
            json.dump({"crs": crs, "name": crs_name.get(crs, crs), "day": day,
                        "date": on_date.isoformat(), "dep": rows},
                       f, separators=(",", ":"))
        written += 1
        total += len(rows)

    # Destinations are named by CRS and often lie outside the mapped area, so
    # the app needs the national name table, plus a size signal for the dots.
    with open(os.path.join(WEB, "crs_names.json"), "w") as f:
        json.dump(names.load(WEB, crs_name), f, separators=(",", ":"))
    stats = {crs: len(rows) for crs, rows in boards.items() if crs in known}
    with open(os.path.join(WEB, "station_stats.json"), "w") as f:
        json.dump({"departures": stats}, f, separators=(",", ":"))
    print(f"wrote crs_names.json ({len(crs_name)} names) and station_stats.json")

    size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"wrote {written} boards, {total} departures, {size/1e6:.1f} MB total "
          f"({size/max(written,1)/1024:.1f} kB each)")


if __name__ == "__main__":
    main()
