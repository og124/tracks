"""Readable station names.

The timetable's station file (MSN) is upper case throughout — "WESTON-SUPER-MARE",
"LONDON KINGS CROSS" — which shouts on a departure board. OSM has the same
stations in normal case, so prefer that and only fall back to title-casing the
feed's version.
"""
import json, os, re

# words that title-casing gets wrong on its own
LOWER = {"and", "of", "the", "on", "in", "upon", "under", "super", "next", "le",
         "la", "sur", "y", "cum", "by"}
UPPER = {"crs", "hs1", "dlr", "cbd"}


def _word(w, first):
    lw = w.lower()
    if lw in UPPER:
        return w.upper()
    if not first and lw in LOWER:
        return lw
    if lw.startswith("mc") and len(lw) > 3:
        return "Mc" + lw[2:].capitalize()
    if lw.startswith("st.") or lw == "st":
        return "St"
    return lw[:1].upper() + lw[1:]


def titlecase(name):
    """Title-case a shouty name, keeping hyphens, apostrophes and brackets."""
    out, first = [], True
    for tok in re.split(r"([ \-()/])", name.strip()):
        if tok in (" ", "-", "(", ")", "/", ""):
            out.append(tok)
            if tok in ("(", "/"):
                first = True
            continue
        # an apostrophe keeps the following letter lower: KING'S -> King's
        parts = tok.split("'")
        word = "'".join([_word(parts[0], first)] + [p.lower() for p in parts[1:]])
        out.append(word)
        first = False
    return "".join(out)


def load(web_dir, feed_names):
    """crs -> best available name, OSM first then the title-cased feed name."""
    osm = {}
    path = os.path.join(web_dir, "stations.json")
    if os.path.exists(path):
        with open(path) as f:
            for crs, st in json.load(f)["stations"].items():
                if st.get("crs") and st.get("name"):
                    osm[st["crs"]] = st["name"]
    return {crs: osm.get(crs) or titlecase(raw) for crs, raw in feed_names.items()}
