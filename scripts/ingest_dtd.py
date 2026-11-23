#!/usr/bin/env python3
"""Turn the National Rail DTD timetable feed into real journey times.

    export NR_USER='you@example.com' NR_PASS='...'      # or put them in .env
    python3 scripts/ingest_dtd.py                       # downloads + parses
    python3 scripts/ingest_dtd.py --zip path/to.zip     # parse a local copy
    python3 scripts/build_times.py                      # publish to the web app

Writes data/web/times_timetable.json; build_times.py prefers it over estimates.

The feed is the fixed-width CIF timetable (an .MCA file) plus a station master
list (.MSN). We read one representative weekday, keep passenger schedules, and
for every station work out the shortest door-to-door time to each London
terminus: direct services first, then a one-change search for the stations that
have no through train.
"""
import argparse, collections, datetime, io, json, os, statistics, sys, urllib.parse, urllib.request, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from termini import LONDON_TERMINI

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "data", "web")

AUTH_URL = "https://opendata.nationalrail.co.uk/authenticate"
FEED_URL = "https://opendata.nationalrail.co.uk/api/staticfeeds/3.0/timetable"

WEEKDAY = 1                 # Tuesday: a representative day in the Days-Run mask
ON_DATE = None              # set at runtime: only schedules valid on this date count
MIN_CONNECTION = 5          # fallback when the feed publishes no change time
MAX_CHANGE = 60             # 98/99 in the MSN are sentinels, not durations
PASSENGER_STATUS = {"P", "1"}
TERMINUS_CRS = {t[0] for t in LONDON_TERMINI}


# ------------------------------------------------------------------ helpers --

def load_dotenv():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def hhmm(s):
    """CIF public time -> minutes past midnight, or None if this is not a stop.

    "0000" is the file's way of saying "no public time", not midnight -- every
    passing point carries it. Reading it as 00:00 turns each one into a
    midnight call, which wrecks the running order and silently cost most of
    Cornwall its London times. Genuine midnight departures are written 2359 or
    0001 by convention.
    """
    s = s.strip()
    if len(s) < 4 or not s[:4].isdigit() or s[:4] == "0000":
        return None
    m = int(s[:4]) // 100 * 60 + int(s[:4]) % 100
    return m + (0.5 if s[4:5] == "H" else 0)


def download(user, password):
    body = urllib.parse.urlencode({"username": user, "password": password}).encode()
    req = urllib.request.Request(AUTH_URL, data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=90) as r:
        token = json.load(r)["token"]
    print("authenticated")
    req = urllib.request.Request(FEED_URL, headers={"X-Auth-Token": token})
    with urllib.request.urlopen(req, timeout=900) as r:
        data = r.read()
    print(f"downloaded {len(data)/1e6:.1f} MB")
    return data


# ------------------------------------------------------------------- parsing --

def parse_msn_change_times(text):
    """CRS -> the operator's minimum interchange time at that station, minutes.

    The MSN station record carries this in columns 63-65 and it is emphatically
    not a constant: Euston, Paddington and Liverpool Street are 15 minutes,
    Birmingham New Street 12, Clapham Junction and Manchester Piccadilly 10,
    against a median of 5. 724 of the 3,116 stations that publish one are not 5.

    Assuming 5 everywhere is not a rounding error, it is a wrong answer — it
    produces itineraries that cannot be walked in the time allowed, at exactly
    the big interchanges a commuter actually changes at.

    Values above an hour (98 and 99 appear for a handful of stations) are
    sentinels rather than durations, so they are clamped rather than trusted.
    """
    out = {}
    for line in text.splitlines():
        if not line.startswith("A") or len(line) < 66:
            continue
        crs = line[49:52].strip()
        raw = line[63:65].strip()
        if crs and raw.isdigit():
            out[crs] = min(int(raw), MAX_CHANGE)
    return out


def parse_msn(text):
    """MSN 'A' records -> tiploc->crs and crs->name."""
    tiploc_crs, crs_name = {}, {}
    for line in text.splitlines():
        if not line.startswith("A") or len(line) < 52:
            continue
        name = line[5:35].strip()
        tiploc = line[36:43].strip()
        crs = line[49:52].strip()
        if not (tiploc and crs):
            continue
        tiploc_crs[tiploc] = crs
        crs_name.setdefault(crs, name)
    return tiploc_crs, crs_name


def cif_date(s):
    """YYMMDD -> date. The file uses 2-digit years; everything is 2000s."""
    try:
        return datetime.date(2000 + int(s[0:2]), int(s[2:4]), int(s[4:6]))
    except ValueError:
        return None


def parse_mca(text, tiploc_crs, on_date, with_toc=False):
    """Yield one (crs_sequence) per passenger schedule running on WEEKDAY.

    Each element is (crs, public_arrival_min, public_departure_min); only stops
    open to passengers are kept, which is what a journey time is measured on.

    With `with_toc`, returns (trips, tocs) instead — tocs[i] is the two-letter
    ATOC code from schedule i's BX record, or None. The journey planner needs it
    to name the operator of each leg; the London journey-time ingest does not,
    so it stays opt-in rather than changing what every caller gets back.
    """
    trips, keep, stops, tocs, toc = [], False, [], [], None
    for line in text.splitlines():
        rid = line[:2]

        if rid == "BS":
            if keep and len(stops) >= 2:
                trips.append(stops)
                tocs.append(toc)
            stops, keep, toc = [], False, None
            if len(line) < 80:
                continue
            days = line[21:28]
            status = line[29]
            category = line[30:32]
            stp = line[79]
            runs_from, runs_to = cif_date(line[9:15]), cif_date(line[15:21])
            in_period = (runs_from is not None and runs_to is not None
                         and runs_from <= on_date <= runs_to)
            keep = (stp != "C" and status in PASSENGER_STATUS
                    and len(days) == 7 and days[WEEKDAY] == "1"
                    and category[:1] in ("O", "X") and in_period)

        elif rid == "BX" and keep:
            toc = line[11:13].strip() or None

        elif rid == "LO" and keep:
            dep = hhmm(line[15:19])
            crs = tiploc_crs.get(line[2:9].strip())
            if crs and dep is not None:
                stops.append((crs, None, dep))

        elif rid == "LI" and keep:
            arr, dep = hhmm(line[25:29]), hhmm(line[29:33])
            crs = tiploc_crs.get(line[2:9].strip())
            if crs and (arr is not None or dep is not None):
                stops.append((crs, arr, dep))

        elif rid == "LT" and keep:
            arr = hhmm(line[15:19])
            crs = tiploc_crs.get(line[2:9].strip())
            if crs and arr is not None:
                stops.append((crs, arr, None))

    if keep and len(stops) >= 2:
        trips.append(stops)
        tocs.append(toc)
    return (trips, tocs) if with_toc else trips


def unwrap(stops):
    """Add 24h to times that have rolled past midnight so arithmetic works."""
    out, offset, prev = [], 0, None
    for crs, arr, dep in stops:
        fixed = []
        for t in (arr, dep):
            if t is None:
                fixed.append(None)
                continue
            if prev is not None and t + offset < prev - 180:
                offset += 1440
            prev = t + offset
            fixed.append(t + offset)      # each time takes the offset in force for it
        out.append((crs, fixed[0], fixed[1]))
    return out


# ------------------------------------------------------------------ journeys --

def direct_times(trips):
    """(station, terminus) -> list of direct journey durations in minutes."""
    durations = collections.defaultdict(list)
    for stops in trips:
        stops = unwrap(stops)
        term_at = [(i, c, a) for i, (c, a, _d) in enumerate(stops)
                   if c in TERMINUS_CRS and a is not None]
        if not term_at:
            continue
        for i, (crs, _arr, dep) in enumerate(stops):
            if dep is None or crs in TERMINUS_CRS:
                continue
            for j, tcrs, tarr in term_at:
                if j > i:
                    durations[(crs, tcrs)].append(tarr - dep)
    return durations


def one_change_times(trips, direct):
    """Fastest London time for stations with no through service.

    For each such station we take every train it can board, and at every later
    stop ask how fast a direct service then reaches a terminus. Uses the best
    direct leg plus a minimum connection - an upper bound on the true time, but
    a realistic one, and only ever used where no direct train exists.
    """
    best_direct = {}
    for (crs, tcrs), ds in direct.items():
        cur = best_direct.get(crs)
        m = min(ds)
        if cur is None or m < cur[1]:
            best_direct[crs] = (tcrs, m)

    served = {crs for crs, _t in direct}
    out = collections.defaultdict(list)
    for stops in trips:
        stops = unwrap(stops)
        for i, (crs, _arr, dep) in enumerate(stops):
            if dep is None or crs in served or crs in TERMINUS_CRS:
                continue
            for j in range(i + 1, len(stops)):
                hub, harr, _hdep = stops[j]
                if harr is None or hub not in best_direct:
                    continue
                tcrs, leg = best_direct[hub]
                out[(crs, tcrs)].append((harr - dep) + MIN_CONNECTION + leg)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="parse an already-downloaded feed zip")
    args = ap.parse_args()

    if args.zip:
        blob = open(args.zip, "rb").read()
    else:
        load_dotenv()
        user, password = os.environ.get("NR_USER"), os.environ.get("NR_PASS")
        if not (user and password):
            sys.exit("set NR_USER and NR_PASS (env or .env) — see README")
        blob = download(user, password)
        with open(os.path.join(ROOT, "data", "raw", "dtd-timetable.zip"), "wb") as f:
            f.write(blob)

    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = zf.namelist()
    mca = next(n for n in names if n.upper().endswith(".MCA"))
    msn = next(n for n in names if n.upper().endswith(".MSN"))
    print(f"feed contains {len(names)} files; using {mca} + {msn}")

    tiploc_crs, crs_name = parse_msn(zf.read(msn).decode("latin-1"))
    print(f"station master: {len(crs_name)} CRS codes, {len(tiploc_crs)} tiplocs")

    # The feed carries schedules for many periods at once; only those valid on a
    # real date are running. Without this, withdrawn services still set records.
    on_date = ON_DATE or datetime.date.today()
    trips = parse_mca(zf.read(mca).decode("latin-1"), tiploc_crs, on_date)
    day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][WEEKDAY]
    print(f"passenger schedules running on a {day} valid {on_date}: {len(trips)}")

    direct = direct_times(trips)
    print(f"direct station-terminus pairs: {len(direct)}")
    indirect = one_change_times(trips, direct)
    print(f"one-change pairs added: {len(indirect)}")

    by_station = collections.defaultdict(list)
    for (crs, tcrs), ds in direct.items():
        ds = [d for d in ds if 1 <= d <= 900]
        if ds:
            by_station[crs].append({"terminus": tcrs, "mins": int(min(ds)),
                                     "typical": int(statistics.median(ds)),
                                     "services": len(ds), "changes": 0, "est": False,
                                     "src": "timetable"})
    for (crs, tcrs), ds in indirect.items():
        if crs in by_station:
            continue
        ds = [d for d in ds if 1 <= d <= 900]
        if ds:
            by_station[crs].append({"terminus": tcrs, "mins": int(min(ds)),
                                     "typical": int(statistics.median(ds)),
                                     "services": len(ds), "changes": 1, "est": False,
                                     "src": "timetable"})

    stations = {}
    for crs, entries in by_station.items():
        entries.sort(key=lambda e: e["mins"])
        stations[crs] = {"best": entries[0], "all": entries[:8]}

    # carry over the track distances the map already knows about
    try:
        with open(os.path.join(WEB, "stations.json")) as f:
            known = json.load(f)["stations"]
        for crs, rec in stations.items():
            dist = (known.get(crs) or {}).get("dist") or {}
            for e in rec["all"]:
                e["km"] = dist.get(e["terminus"])
            rec["best"] = rec["all"][0]
    except FileNotFoundError:
        print("note: run build_network.py first to attach track distances")

    out = os.path.join(WEB, "times_timetable.json")
    with open(out, "w") as f:
        json.dump({"source": "timetable", "stations": stations}, f, separators=(",", ":"))
    print(f"wrote {out} — {len(stations)} stations with real times")
    print("now run: python3 scripts/build_times.py")


if __name__ == "__main__":
    main()
