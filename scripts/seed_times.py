"""Approximate published fastest times (minutes) used ONLY to calibrate the
placeholder distance model until the real timetable ingest runs.

These are recollected headline times, not authoritative. build_times.py fits a
per-terminus `time = a + b * track_km` line through them so the estimates for
every other station land in the right ballpark. Once scripts/ingest_dtd.py has
run, data/times.json is regenerated from the real timetable and this file is
used only as a sanity check (see scripts/check_anchors.py).
"""

# CRS -> (terminus CRS, fastest minutes)
SEED = {
    # Great Western -> Paddington
    "RDG": ("PAD", 23),  "OXF": ("PAD", 51),  "SWI": ("PAD", 45),
    "BTH": ("PAD", 68),  "BRI": ("PAD", 79),  "KEM": ("PAD", 79),
    "CNM": ("PAD", 118), "TAU": ("PAD", 100), "EXD": ("PAD", 121),
    "PLY": ("PAD", 189), "PNZ": ("PAD", 300), "NWP": ("PAD", 89),
    "CDF": ("PAD", 105), "DID": ("PAD", 36),  "SWA": ("PAD", 170),
    # West Coast -> Euston
    "WFJ": ("EUS", 16),  "MKC": ("EUS", 32),  "RUG": ("EUS", 50),
    "NMP": ("EUS", 55),  "COV": ("EUS", 60),  "BHM": ("EUS", 84),
    # Chiltern -> Marylebone
    "HWY": ("MYB", 27),  "BCS": ("MYB", 46),  "BAN": ("MYB", 57),
    # Midland -> St Pancras
    "LUT": ("STP", 23),  "BDM": ("STP", 38),
    # HS1 -> St Pancras
    "AFK": ("STP", 37),  "CBW": ("STP", 56),  "DVP": ("STP", 67),
    "RAM": ("STP", 76),  "MAR": ("STP", 88),
    # East Coast / Great Northern -> King's Cross
    "SVG": ("KGX", 20),  "HIT": ("KGX", 27),  "PBO": ("KGX", 46),
    "CBG": ("KGX", 48),
    # Great Eastern -> Liverpool Street
    "CHM": ("LST", 32),  "COL": ("LST", 46),  "SOV": ("LST", 55),
    "IPS": ("LST", 65),
    # c2c -> Fenchurch Street
    "SOC": ("FST", 55),
    # South Western -> Waterloo
    "WOK": ("WAT", 24),  "GLD": ("WAT", 34),  "BSK": ("WAT", 44),
    "WIN": ("WAT", 57),  "SOU": ("WAT", 68),  "SAL": ("WAT", 85),
    "PMS": ("WAT", 90),  "BMH": ("WAT", 105), "POO": ("WAT", 120),
    "WEY": ("WAT", 165),
    # Brighton main line -> Victoria
    "GTW": ("VIC", 30),  "RDH": ("VIC", 33),  "HHE": ("VIC", 42),
    "BTN": ("VIC", 52),  "HRH": ("VIC", 55),  "EBN": ("VIC", 87),
    # Chatham main line -> Victoria
    "RTR": ("VIC", 45),  "CTM": ("VIC", 48),  "FAV": ("VIC", 68),
    # South Eastern -> Charing Cross
    "SEV": ("CHX", 32),  "TON": ("CHX", 42),  "HGS": ("CHX", 96),

    # Short hops. Without these every anchor for a terminus sits 36 km or more
    # out, and the fitted curve has to extrapolate inward: it put Willesden
    # Junction two minutes from Paddington. Anchoring the near end fixes the
    # shape where most of the stations actually are.
    "WIJ": ("PAD", 10), "EAL": ("PAD", 13), "SLO": ("PAD", 18), "MAI": ("PAD", 24),
    "CLJ": ("WAT", 7),  "WIM": ("WAT", 17), "SUR": ("WAT", 20), "RMD": ("WAT", 26),
    "ECR": ("VIC", 15), "SUO": ("VIC", 25),
    "HRW": ("EUS", 15),
    "FPK": ("KGX", 6),  "WGC": ("KGX", 28),
    "SAC": ("STP", 20),
    "SRA": ("LST", 8),  "IFD": ("LST", 15),
    "BKG": ("FST", 15),
    "HGR": ("CHX", 15), "ORP": ("CHX", 25),
    "LEW": ("CST", 15), "DFD": ("CST", 40),
    "WCX": ("MYB", 12),
}


# Extra anchors: which London terminus this station's trains actually run to.
# No times attached - these exist only to label the corridors for
# build_network.py, which grows a Voronoi partition outward from every anchor so
# each station inherits the terminus of the nearest principal station along the
# rails. Without them, geometry alone gets near-ties badly wrong: Victoria sits
# a few hundred metres closer to the South Western main line than Waterloo does,
# which is true and operationally meaningless.
EXTRA_ANCHORS = {
    # South Western
    "RMD": "WAT", "TWI": "WAT", "SNS": "WAT", "WNR": "WAT", "HAV": "WAT",
    "FRM": "WAT", "AHT": "WAT", "FNH": "WAT", "AON": "WAT", "ADV": "WAT",
    "YVJ": "WAT", "EXC": "WAT", "SOA": "WAT", "WKM": "WAT", "WIM": "WAT",
    # Southern
    "SUO": "VIC", "OXT": "VIC", "LIT": "VIC", "CCH": "VIC", "BOG": "VIC",
    "SIT": "VIC", "MDE": "VIC", "DKG": "VIC",
    # South Eastern
    "TBW": "CHX", "DFD": "CST", "GRV": "CST", "MDW": "CST",
    # Western
    "SLO": "PAD", "MAI": "PAD", "NBY": "PAD", "CPM": "PAD", "WSB": "PAD",
    "GCR": "PAD", "WOS": "PAD", "WSM": "PAD", "TQY": "PAD", "NQY": "PAD",
    "BNP": "PAD", "STD": "PAD",
    # Chiltern
    "AYS": "MYB", "AMR": "MYB", "LMS": "MYB", "SAV": "MYB",
    # West Coast
    "TRI": "EUS", "HML": "EUS", "BLY": "EUS", "NUN": "EUS", "WVH": "EUS",
    # Midland
    "SAC": "STP", "HPD": "STP",
    # Great Northern / East Coast
    "WGC": "KGX", "ELY": "KGX", "HFN": "MOG",
    # Great Eastern
    "SRA": "LST", "ENF": "LST", "BIS": "LST", "HWN": "LST", "CLT": "LST",
    "WTM": "LST", "BTR": "LST", "HWC": "LST", "FLX": "LST",
    # Essex Thameside
    "GRY": "FST", "BSO": "FST", "SRY": "FST", "TIL": "FST",

    # ---- north of the original map. Without these the partition has no
    # anchor above the Midlands and hands whole regions to whichever southern
    # station happens to be nearest along the rails.
    # West Coast: everything that funnels through Crewe or Preston to Euston
    "CRE": "EUS", "SOT": "EUS", "STA": "EUS", "WGN": "EUS", "WBQ": "EUS",
    "LIV": "EUS", "MAN": "EUS", "PRE": "EUS", "LAN": "EUS", "OXN": "EUS",
    "PNR": "EUS", "CAR": "EUS", "CTR": "EUS", "SHR": "EUS", "BNG": "EUS",
    "HHD": "EUS", "LLJ": "EUS", "AYW": "EUS", "RUN": "EUS",
    # East Coast: the King's Cross artery
    "DON": "KGX", "WKF": "KGX", "LDS": "KGX", "YRK": "KGX", "DAR": "KGX",
    "DHM": "KGX", "NCL": "KGX", "BWK": "KGX", "HUL": "KGX", "MBR": "KGX",
    "GRA": "KGX", "NNG": "KGX", "RET": "KGX", "HGT": "KGX", "SKI": "KGX",
    "SCA": "KGX", "NTR": "KGX",
    # Midland main line
    "SHF": "STP", "DBY": "STP", "CHD": "STP", "NOT": "STP", "LEI": "STP",
    "LBO": "STP",
    # Great Eastern, the far end
    "NRW": "LST", "GYM": "LST", "LWT": "LST",
    # Scotland: the west goes to Glasgow and on down the West Coast, the east
    # to Edinburgh and down the East Coast
    "GLC": "EUS", "MTH": "EUS", "PYG": "EUS", "AYR": "EUS", "STR": "EUS",
    "KMK": "EUS", "DMF": "EUS", "GKC": "EUS", "HLC": "EUS", "OBN": "EUS",
    "FTW": "EUS", "MLG": "EUS", "STG": "EUS", "PTH": "EUS", "FKK": "EUS",
    "EDB": "KGX", "HYM": "KGX", "DEE": "KGX", "ABD": "KGX", "INV": "KGX",
    "DUN": "KGX", "KDY": "KGX", "LEU": "KGX", "THS": "KGX", "WCK": "KGX",
    "KYL": "KGX",
}

# every anchor the corridor labelling uses: crs -> terminus
ANCHOR_TERMINUS = {**{c: t for c, (t, _m) in SEED.items()}, **EXTRA_ANCHORS}
