"""London terminals, grouped into the eight sectors the map colours by.

Why sectors rather than one colour per terminus: fourteen categorical hues
cannot be told apart, least of all by a colourblind reader. Eight can, *if* the
assignment is chosen against the pairs that actually touch on the map. The
sectors form a ring around London (Western -> West Coast -> Midland -> East
Coast -> Great Eastern -> South Eastern -> Southern -> South Western -> back to
Western) plus two chords: HS1 puts St Pancras trains into Kent, and the West
Coast and East Coast sectors meet across Hertfordshire.

scripts/check_palette.mjs searches hue assignments against exactly that pair
list. The order below is the winner: worst CVD dE 8.4 and worst normal-vision
dE 19.3 over all thirteen touching pairs, clearing the >=8 and >=15 gates. Colours
are the dark-surface steps of the reference categorical palette - do not
re-step them without re-running the check.

Colour is still never the only cue: the legend is always on, hovering any line
or station names the terminus in words, and one click isolates a single sector.
"""

# key, label, colour, [terminus CRS codes]
SECTORS = [
    ("western",   "Western",              "#d95926", ["PAD"]),
    ("westcoast", "West Coast & Chiltern","#199e70", ["EUS", "MYB"]),
    ("midland",   "Midland & HS1",        "#3987e5", ["STP"]),
    ("eastcoast", "East Coast & Northern","#c98500", ["KGX", "MOG"]),
    ("greateast", "Great Eastern & Essex","#d55181", ["LST", "FST"]),
    ("southeast", "South Eastern",        "#008300", ["CHX", "CST", "LBG", "BFR"]),
    ("southern",  "Southern",             "#e66767", ["VIC"]),
    ("southwest", "South Western",        "#9085e9", ["WAT"]),
]

# crs, display name, lat, lon
LONDON_TERMINI = [
    ("PAD", "London Paddington",       51.5154, -0.1755),
    ("MYB", "London Marylebone",       51.5225, -0.1631),
    ("EUS", "London Euston",           51.5282, -0.1337),
    ("STP", "London St Pancras",       51.5308, -0.1261),
    ("KGX", "London King's Cross",     51.5308, -0.1238),
    ("LST", "London Liverpool Street", 51.5178, -0.0817),
    ("FST", "London Fenchurch Street", 51.5115, -0.0784),
    ("MOG", "London Moorgate",         51.5186, -0.0886),
    ("CST", "London Cannon Street",    51.5113, -0.0904),
    ("LBG", "London Bridge",           51.5052, -0.0864),
    ("BFR", "London Blackfriars",      51.5116, -0.1035),
    ("CHX", "London Charing Cross",    51.5074, -0.1247),
    ("WAT", "London Waterloo",         51.5031, -0.1132),
    ("VIC", "London Victoria",         51.4952, -0.1441),
]

TERMINUS_NAME = {c: n for c, n, _la, _lo in LONDON_TERMINI}
SECTOR_OF_CRS = {crs: key for key, _l, _c, codes in SECTORS for crs in codes}
SECTOR_COLOUR = {key: colour for key, _l, colour, _codes in SECTORS}
UNREACHED_COLOUR = "#5a6472"
