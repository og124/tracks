#!/usr/bin/env python3
"""Produce data/web/prices.json — what a house costs near every point on the map.

The map already answers "how long is the commute from here". The question that
actually follows it is "and what does living here cost", so the two have to be
answerable from the same screen. This builds the second one.

Two sources, because no single free one covers Great Britain at a useful
granularity:

  England & Wales   HM Land Registry Price Paid Data — every residential sale,
                    with its postcode. Aggregated to the postcode district
                    (RG1, SW11) and reported as a *median of actual sales*.
                    ~2,300 areas, which is fine enough to tell one side of a
                    London borough from the other.

  Scotland          Price Paid is an English and Welsh register; Scottish
                    conveyancing is recorded by Registers of Scotland and is
                    not in it. The UK House Price Index — which does cover
                    Scotland — is published per council area, so Scotland is
                    32 coarse areas rather than hundreds of fine ones. That is
                    a real difference in resolution and the output says so per
                    point, so the UI can label it rather than quietly blend the
                    two into one number.

Both are Open Government Licence v3. Nothing here runs in the browser and
nothing here runs weekly: house prices move on the scale of months, so this
belongs with `make fetch` / `make network` as a thing you run locally and push
and committed nowhere: it is rebuilt locally when wanted.

Downloads are cached in data/raw/prices/ and reused, so a re-run after a failure
costs nothing. Roughly 350 MB the first time.
"""
import csv
import io
import json
import math
import os
import ssl
import statistics
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw", "prices")
WEB = os.path.join(ROOT, "data", "web")

PP_BASE = ("http://prod.publicdata.landregistry.gov.uk.s3-website-eu-west-1"
           ".amazonaws.com")
HPI_BASE = ("http://publicdata.landregistry.gov.uk/market-trend-data"
            "/house-price-index-data")
CODEPOINT = ("https://api.os.uk/downloads/v1/products/CodePointOpen/downloads"
             "?area=GB&format=CSV&redirect")
LAD = ("https://services1.arcgis.com/ESMARspQHYMw9BZ9/ArcGIS/rest/services"
       "/LAD_MAY_2025_UK_BUC/FeatureServer/0/query")

MONTHS = 12          # the rolling window a median is taken over
MIN_SALES = 10       # below this a district median is noise, so it is dropped


# --------------------------------------------------------------- download --
def get(url, dest=None, timeout=900):
    """Fetch url, caching to data/raw/prices/<dest> when dest is given."""
    if dest:
        path = os.path.join(RAW, dest)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return path
    os.makedirs(RAW, exist_ok=True)
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "tracks/1.0 (+https://github.com/og124/tracks)"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as res:
        if not dest:
            return res.read()
        tmp = os.path.join(RAW, dest + ".part")
        with open(tmp, "wb") as fh:
            while True:
                chunk = res.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
        os.replace(tmp, os.path.join(RAW, dest))
    return os.path.join(RAW, dest)


def exists(url):
    req = urllib.request.Request(url, method="HEAD",
                                headers={"User-Agent": "tracks/1.0 (+https://github.com/og124/tracks)"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status == 200
    except Exception:
        return False


# ------------------------------------------------------- OSGB36 → WGS84 ----
# Code-Point Open is eastings/northings on the National Grid. Everything else
# in this repo is WGS84 degrees, so the grid references have to be converted
# before they can be put on a Leaflet map. Reverse transverse Mercator onto the
# Airy 1830 ellipsoid, then the Ordnance Survey's own Helmert parameters across
# to WGS84 — good to about 5 m, which for a district centroid is exact enough
# to be meaningless.
A_AIRY, B_AIRY = 6377563.396, 6356256.909
F0, LAT0, LON0 = 0.9996012717, math.radians(49.0), math.radians(-2.0)
E0, N0 = 400000.0, -100000.0


def grid_to_wgs84(east, north):
    e2 = 1 - (B_AIRY * B_AIRY) / (A_AIRY * A_AIRY)
    n = (A_AIRY - B_AIRY) / (A_AIRY + B_AIRY)
    lat = LAT0
    m = 0.0
    for _ in range(12):
        lat += (north - N0 - m) / (A_AIRY * F0)
        dl, sl = lat - LAT0, lat + LAT0
        m = B_AIRY * F0 * (
            (1 + n + 1.25 * n * n + 1.25 * n ** 3) * dl
            - (3 * n + 3 * n * n + 2.625 * n ** 3) * math.sin(dl) * math.cos(sl)
            + (1.875 * n * n + 1.875 * n ** 3) * math.sin(2 * dl) * math.cos(2 * sl)
            - (35 / 24) * n ** 3 * math.sin(3 * dl) * math.cos(3 * sl))
        if abs(north - N0 - m) < 1e-5:
            break
    s, c, t = math.sin(lat), math.cos(lat), math.tan(lat)
    nu = A_AIRY * F0 / math.sqrt(1 - e2 * s * s)
    rho = A_AIRY * F0 * (1 - e2) / (1 - e2 * s * s) ** 1.5
    eta2 = nu / rho - 1
    t2, t4, t6 = t * t, t ** 4, t ** 6
    sec = 1 / c
    vii = t / (2 * rho * nu)
    viii = t / (24 * rho * nu ** 3) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2)
    ix = t / (720 * rho * nu ** 5) * (61 + 90 * t2 + 45 * t4)
    x = sec / nu
    xi = sec / (6 * nu ** 3) * (nu / rho + 2 * t2)
    xii = sec / (120 * nu ** 5) * (5 + 28 * t2 + 24 * t4)
    xiia = sec / (5040 * nu ** 7) * (61 + 662 * t2 + 1320 * t4 + 720 * t6)
    d = east - E0
    lat = lat - vii * d ** 2 + viii * d ** 4 - ix * d ** 6
    lon = LON0 + x * d - xi * d ** 3 + xii * d ** 5 - xiia * d ** 7
    return helmert(lat, lon)


def helmert(lat, lon):
    """OSGB36 geodetic → WGS84 geodetic, via geocentric cartesian."""
    e2 = 1 - (B_AIRY * B_AIRY) / (A_AIRY * A_AIRY)
    s, c = math.sin(lat), math.cos(lat)
    nu = A_AIRY / math.sqrt(1 - e2 * s * s)
    x1 = nu * c * math.cos(lon)
    y1 = nu * c * math.sin(lon)
    z1 = (1 - e2) * nu * s
    tx, ty, tz = 446.448, -125.157, 542.060
    sc = 20.4894e-6
    rx = math.radians(0.1502 / 3600)
    ry = math.radians(0.2470 / 3600)
    rz = math.radians(0.8421 / 3600)
    x2 = tx + x1 * (1 + sc) - y1 * rz + z1 * ry
    y2 = ty + x1 * rz + y1 * (1 + sc) - z1 * rx
    z2 = tz - x1 * ry + y1 * rx + z1 * (1 + sc)
    # WGS84 ellipsoid
    aw, bw = 6378137.0, 6356752.3142
    e2w = 1 - (bw * bw) / (aw * aw)
    p = math.sqrt(x2 * x2 + y2 * y2)
    phi = math.atan2(z2, p * (1 - e2w))
    for _ in range(8):
        nuw = aw / math.sqrt(1 - e2w * math.sin(phi) ** 2)
        phi = math.atan2(z2 + e2w * nuw * math.sin(phi), p)
    return math.degrees(phi), math.degrees(math.atan2(y2, x2))


# ------------------------------------------------- postcode district shapes --
def district_centroids():
    """Centroid and spread, in km, of every postcode district in Great Britain.

    The spread is what gives each district its influence radius in the heatmap.
    A single fixed radius cannot work: SW11 is two kilometres across and
    IV27 is sixty, and either a radius that covers the Highlands pours London
    across the Home Counties or one that fits London leaves rural Britain as
    unconnected dots.
    """
    path = get(CODEPOINT, "codepo_gb.zip")
    acc = defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0.0])   # n, se, sn, se², sn²
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.lower().endswith(".csv") or "/CSV/" not in name:
                continue
            with z.open(name) as fh:
                for row in csv.reader(io.TextIOWrapper(fh, "latin-1")):
                    if len(row) < 4:
                        continue
                    outward = row[0].split()[0].strip().upper()
                    if not outward:
                        continue
                    try:
                        e, n = float(row[2]), float(row[3])
                    except ValueError:
                        continue
                    a = acc[outward]
                    a[0] += 1
                    a[1] += e
                    a[2] += n
                    a[3] += e * e
                    a[4] += n * n
    out = {}
    for code, (n, se, sn, se2, sn2) in acc.items():
        if n < 3:
            continue
        me, mn = se / n, sn / n
        var = max(0.0, se2 / n - me * me) + max(0.0, sn2 / n - mn * mn)
        rms_km = math.sqrt(var) / 1000.0
        lat, lon = grid_to_wgs84(me, mn)
        # 2.2x the RMS spread, floored so dense urban districts still join up
        # to their neighbours and capped so one rural district cannot colour a
        # county it knows nothing about.
        radius = min(22.0, max(2.2, rms_km * 2.2))
        out[code] = (round(lat, 5), round(lon, 5), round(radius, 2), n)
    return out


# -------------------------------------------------------------- price paid --
def price_paid_years():
    """The Price Paid year files needed to cover a rolling MONTHS window."""
    today = date.today()
    years = [today.year]
    if today.month <= MONTHS:
        years.append(today.year - 1)
    paths = []
    for y in sorted(set(years), reverse=True):
        url = f"{PP_BASE}/pp-{y}.csv"
        if not exists(url):
            print(f"  pp-{y}.csv not published yet, skipping")
            continue
        print(f"  pp-{y}.csv …")
        paths.append(get(url, f"pp-{y}.csv"))
    if not paths:
        raise SystemExit("no Price Paid year file could be downloaded")
    return paths


def district_medians(paths):
    """Median sale price per postcode district over the last MONTHS months.

    Filters, all of which matter:

      category A only  B is "additional price paid" — repossessions, buy-to-let
                       portfolios, transfers that are not an open-market sale.
                       Including them drags a district's median down by
                       something that was never on the market.
      type != O        "Other" is the non-residential and part-share catch-all.
      price > 0        the register contains a handful of £1 transfers.
    """
    rows = defaultdict(list)
    seen_months = set()
    for path in paths:
        with open(path, newline="", encoding="latin-1") as fh:
            for rec in csv.reader(fh):
                if len(rec) < 16:
                    continue
                if rec[14] != "A" or rec[4] == "O":
                    continue
                postcode = rec[3].strip().upper()
                if not postcode:
                    continue
                try:
                    price = int(rec[1])
                except ValueError:
                    continue
                if price <= 0:
                    continue
                month = rec[2][:7]
                seen_months.add(month)
                rows[(postcode.split()[0], month)].append(price)

    if not seen_months:
        raise SystemExit("no usable Price Paid records")
    # The window ends at the last month the register actually has, not at today:
    # the register runs about a month behind, and anchoring on today would make
    # the newest month of a 12-month window empty.
    end = max(seen_months)
    ey, em = int(end[:4]), int(end[5:7])
    window = set()
    for i in range(MONTHS):
        m = em - i
        y = ey
        while m <= 0:
            m += 12
            y -= 1
        window.add(f"{y:04d}-{m:02d}")
    start = min(window)

    by_district = defaultdict(list)
    for (code, month), prices in rows.items():
        if month in window:
            by_district[code].extend(prices)
    out = {c: (int(statistics.median(p)), len(p))
           for c, p in by_district.items() if len(p) >= MIN_SALES}
    return out, start, end


# ------------------------------------------------------------------- Scotland
def scotland_points():
    """Average price per Scottish council area, with that area's centroid.

    UK HPI is published monthly as the whole series for every area, so the file
    is read once and only the newest row per council area is kept.
    """
    today = date.today()
    y, m = today.year, today.month
    month = None
    for _ in range(6):
        m -= 1
        if m == 0:
            m, y = 12, y - 1
        cand = f"{y:04d}-{m:02d}"
        if exists(f"{HPI_BASE}/Average-prices-{cand}.csv"):
            month = cand
            break
    if not month:
        raise SystemExit("no UK HPI Average-prices file found in the last 6 months")
    print(f"  UK HPI {month} …")
    path = get(f"{HPI_BASE}/Average-prices-{month}.csv", f"hpi-{month}.csv")

    latest = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for rec in csv.DictReader(fh):
            code = (rec.get("Area_Code") or "").strip()
            if not code.startswith("S12"):          # Scottish council areas
                continue
            price = (rec.get("Average_Price") or "").strip()
            if not price:
                continue
            d = (rec.get("Date") or "").strip()
            cur = latest.get(code)
            if cur is None or d > cur[0]:
                latest[code] = (d, float(price), rec.get("Region_Name", code))

    print("  Scottish council area centroids …")
    q = (LAD + "?where=" + urllib.parse.quote("LAD25CD LIKE 'S12%'")
         + "&outFields=LAD25CD,LAD25NM,LONG,LAT,Shape__Area"
         + "&returnGeometry=false&f=json")
    geo = json.loads(get(q))
    pts = []
    for f in geo.get("features", []):
        a = f["attributes"]
        row = latest.get(a["LAD25CD"])
        if not row:
            continue
        # Shape__Area comes back in square metres of the service's projection.
        # The radius of the circle of the same area, widened a little so
        # neighbouring councils meet rather than leaving seams of blank map.
        km = math.sqrt(max(a.get("Shape__Area") or 0, 1) / math.pi) / 1000.0
        pts.append([a["LAD25NM"], round(a["LAT"], 5), round(a["LONG"], 5),
                    int(round(row[1])), 0, round(min(70.0, max(12.0, km * 1.25)), 2), 1])
    return pts, month


# ------------------------------------------------------------------- output --
def main():
    os.makedirs(WEB, exist_ok=True)
    print("Price Paid year files")
    paths = price_paid_years()
    print("aggregating sales by postcode district …")
    medians, start, end = district_medians(paths)
    print(f"  {len(medians)} districts with ≥{MIN_SALES} sales, {start} → {end}")

    print("Code-Point Open")
    shapes = district_centroids()
    print(f"  {len(shapes)} postcode districts located")

    points = []
    missing = 0
    for code, (price, n) in sorted(medians.items()):
        shape = shapes.get(code)
        if not shape:
            missing += 1
            continue
        lat, lon, radius, _units = shape
        points.append([code, lat, lon, price, n, radius, 0])
    if missing:
        print(f"  {missing} districts had sales but no Code-Point location")

    print("UK HPI — Scotland")
    sc, hpi_month = scotland_points()
    print(f"  {len(sc)} Scottish council areas")
    points.extend(sc)

    prices = [p[3] for p in points]
    out = {
        "built": date.today().isoformat(),
        "window": {"from": start, "to": end, "months": MONTHS},
        "fields": ["label", "lat", "lon", "price", "sales", "radiusKm", "kind"],
        "kinds": [
            {"key": "district", "stat": "median",
             "label": "median sale price, postcode district",
             "source": "HM Land Registry Price Paid Data",
             "licence": "Open Government Licence v3",
             "provenance": "published",
             "note": f"median of residential sales, {start} to {end}"},
            {"key": "council", "stat": "mean",
             "label": "average price, Scottish council area",
             "source": "UK House Price Index",
             "licence": "Open Government Licence v3",
             "provenance": "published",
             "note": f"UK HPI average price, {hpi_month}; Price Paid does not "
                     f"cover Scotland, so these areas are council-wide rather "
                     f"than per postcode district"},
        ],
        "range": {"min": min(prices), "max": max(prices),
                  "p5": int(statistics.quantiles(prices, n=20)[0]),
                  "p95": int(statistics.quantiles(prices, n=20)[18]),
                  "median": int(statistics.median(prices))},
        "points": points,
    }
    dest = os.path.join(WEB, "prices.json")
    with open(dest, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    kb = os.path.getsize(dest) / 1024
    print(f"wrote {dest} — {len(points)} points, {kb:.0f} kB")
    print(f"  median of medians £{out['range']['median']:,}  "
          f"p5 £{out['range']['p5']:,}  p95 £{out['range']['p95']:,}")


if __name__ == "__main__":
    main()
