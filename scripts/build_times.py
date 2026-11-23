#!/usr/bin/env python3
"""Produce data/web/times.json — minutes from each station to each London terminus.

Two backends, same output shape, so the web app never changes:

  timetable  real fastest/typical times parsed out of the National Rail DTD
             timetable feed by scripts/ingest_dtd.py (run that first)
  estimate   placeholder: a per-terminus least-squares fit of
             minutes = a + b * along-track-km, calibrated on the approximate
             headline times in seed_times.py

The estimate backend exists so the map is usable before credentials arrive.
Every value it produces is flagged est=true and the UI labels it as estimated.
"""
import json, math, os, statistics, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from seed_times import SEED
from termini import TERMINUS_NAME

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "data", "web")
REAL = os.path.join(WEB, "times_timetable.json")


def fit(points):
    """Fit mins = exp(a) * km**b in log space. Returns None if too few points.

    A straight line in linear space is the obvious choice and the wrong one: the
    Paddington anchors span 36 to 300 minutes and least squares hands back a
    negative intercept, so anything close to London comes out at zero. Fitting
    the logs keeps every prediction positive and captures the real effect that
    longer runs average higher speeds, because the stopping overhead is a
    smaller share of the journey.
    """
    pts = [(x, y) for x, y in points if x > 0.5 and y > 0]
    n = len(pts)
    if n < 3:
        return None
    lx = [math.log(x) for x, _ in pts]
    ly = [math.log(y) for _, y in pts]
    sx, sy = sum(lx), sum(ly)
    sxx = sum(v * v for v in lx)
    sxy = sum(a * b for a, b in zip(lx, ly))
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-9:
        return None
    b = (n * sxy - sx * sy) / denom
    a = (sy - b * sx) / n
    if not (0.5 <= b <= 1.4):          # implausible shape, fall back
        return None
    return a, b


SPLIT_KM = 45.0        # inner suburban services vs longer-distance ones
BLEND = (30.0, 60.0)   # cross-fade band, so the two fits meet without a step


def fit_piecewise(points):
    """A near fit and a far fit, because one curve cannot serve both.

    Inner suburban services stop everywhere and average maybe 45 km/h; the
    expresses behind them average two or three times that. A single power law
    split the difference and was wrong at both ends -- fitting the short hops
    dragged the long-distance predictions up by half. Either segment falls back
    to the whole-corridor fit when it has too few anchors to stand on its own.
    """
    whole = fit(points)
    near = fit([p for p in points if p[0] < SPLIT_KM]) or whole
    far = fit([p for p in points if p[0] >= SPLIT_KM]) or whole
    if whole is None:
        return None
    return (near, far)


def predict(model, km):
    if model is None:
        return km
    near, far = model
    lo, hi = BLEND
    if km <= lo:
        a, b = near
    elif km >= hi:
        a, b = far
    else:                       # blend the two in log space across the band
        w = (km - lo) / (hi - lo)
        a = near[0] * (1 - w) + far[0] * w
        b = near[1] * (1 - w) + far[1] * w
    return math.exp(a) * (km ** b)


def quality(model, points):
    """Median and worst absolute percentage error of a fit."""
    errs = sorted(abs(predict(model, x) - y) / y * 100 for x, y in points)
    return statistics.median(errs), errs[-1]


def build_estimates(stations):
    by_terminus = {}
    for crs, (term, mins) in SEED.items():
        st = stations.get(crs)
        if not st:
            continue
        km = st["dist"].get(term)
        if km:
            by_terminus.setdefault(term, []).append((km, mins))

    models, all_pts = {}, []
    for term, pts in by_terminus.items():
        all_pts += pts
        m = fit_piecewise(pts)
        if m:
            models[term] = m
    fallback = fit_piecewise(all_pts)
    if fallback is None:
        fallback = ((math.log(1.4), 0.85), (math.log(1.4), 0.85))

    med, worst = quality(fallback, all_pts)
    print(f"  calibrated {len(models)} termini from {len(all_pts)} seed times")
    print(f"  fallback model: median error {med:.0f}%, worst {worst:.0f}%")
    for term, model in sorted(models.items()):
        pts = by_terminus[term]
        med, worst = quality(model, pts)
        print(f"    {term} {TERMINUS_NAME.get(term,'')[:22]:<22} {len(pts):2} anchors, "
              f"median error {med:4.0f}%, worst {worst:4.0f}%, "
              f"10 km -> {predict(model, 10):.0f} min, 100 km -> {predict(model, 100):.0f} min")

    out = {}
    for crs, st in stations.items():
        if crs in TERMINUS_NAME:
            # A terminus has no journey time into itself; the app labels these
            # as terminals rather than showing a fitted two minutes.
            out[crs] = {"best": {"terminus": crs, "mins": 0, "km": 0,
                                  "est": False, "src": "terminus"},
                        "all": []}
            continue
        term = st.get("terminus")
        if not term or term not in st["dist"]:
            continue
        # Only the terminus this corridor actually serves. Running the model
        # against all fourteen produces confident nonsense -- from Kemble every
        # London terminus is within 3% of the same track distance, so the fitted
        # speeds alone decide the ranking and it cheerfully offers Euston in an
        # hour. Which termini a station can really reach is a timetable
        # question, so the full list only appears once ingest_dtd.py has run.
        km = st["dist"][term]
        seeded = SEED.get(crs)
        if seeded and seeded[0] == term:
            entry = {"terminus": term, "mins": seeded[1], "km": km,
                     "est": False, "src": "published"}
        else:
            mins = max(2, round(predict(models.get(term, fallback), max(km, 0.6))))
            entry = {"terminus": term, "mins": mins, "km": km,
                     "est": True, "src": "model"}
        out[crs] = {"best": entry, "all": [entry]}
    return out


def main():
    with open(os.path.join(WEB, "stations.json")) as f:
        stations = json.load(f)["stations"]

    if os.path.exists(REAL):
        with open(REAL) as f:
            real = json.load(f)["stations"]
        # The feed is national; this map is not. Drop what we cannot place.
        offmap = [c for c in real if c not in stations]
        for c in offmap:
            del real[c]
        print(f"timetable feed: {len(real)} stations on this map "
              f"({len(offmap)} elsewhere in GB dropped)")

        # Which terminus to headline. Two honest answers compete: the fastest
        # one, and the one this station's corridor is coloured for. Prefer the
        # corridor when it is within a few minutes, so a dot drawn South Western
        # does not read "to London Victoria" over a two-minute saving -- but let
        # a genuinely faster route win. Abbey Wood really does reach Liverpool
        # Street in 18 minutes on the Elizabeth line, and forcing Cannon Street
        # at 32 would just be wrong. Either way "all" stays fastest-first.
        NEAR_MIN, NEAR_FRAC = 4, 0.15
        realigned = 0
        for crs, rec in real.items():
            want = (stations.get(crs) or {}).get("terminus")
            if not want or rec["best"]["terminus"] == want:
                continue
            match = next((e for e in rec["all"] if e["terminus"] == want), None)
            if not match:
                continue
            fastest = rec["best"]["mins"]
            if match["mins"] - fastest <= max(NEAR_MIN, fastest * NEAR_FRAC):
                rec["best"] = match
                realigned += 1
        print(f"headlined {realigned} stations on their corridor's terminus "
              f"(others keep the genuinely fastest)")

        # Stations the feed has no London journey for -- heritage lines, and
        # anywhere needing two or more changes -- keep the modelled estimate
        # rather than going blank. The UI tags them separately either way.
        gaps = build_estimates(stations)
        filled = 0
        for crs, rec in gaps.items():
            if crs not in real:
                real[crs] = rec
                filled += 1
        print(f"filled {filled} gaps with estimates")
        payload = {"source": "timetable", "stations": real}
    else:
        print("no timetable feed present — building calibrated estimates")
        payload = {"source": "estimate", "stations": build_estimates(stations)}

    payload["generated"] = __import__("datetime").date.today().isoformat()
    with open(os.path.join(WEB, "times.json"), "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    n = len(payload["stations"])
    from collections import Counter
    mix = Counter(v["best"].get("src", "?") for v in payload["stations"].values())
    print(f"wrote times.json — {n} stations: "
          + ", ".join(f"{c} {k}" for k, c in mix.most_common()))


if __name__ == "__main__":
    main()
