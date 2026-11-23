/* Tracks — the railway network of Great Britain, coloured by London terminus.
   Data built by scripts/build_network.py, build_times.py, build_departures.py.

   Layout: a toolbar across the top — search, with the journey planner and the
   house price overlay as tools that drop a panel below it — an inspector that
   slides in from the right when you select something, and a dock along the
   bottom for the legend and map options. Only one tool panel is open at a time,
   and the map itself is never covered by a permanent one. */
"use strict";

/* The site is assembled into dist/ by `make dist` — index.html at the root with
   the generated data beside it in data/ — and that is exactly what CloudFront
   serves. Local and deployed therefore run byte-identical paths, which is the
   cheapest way to not discover a path bug only after a deploy. */
const DATA = "data/";

const TIME_BANDS = [
  [15, "#cde2fb"], [30, "#9ec5f4"], [45, "#6da7ec"], [60, "#3987e5"],
  [90, "#2a78d6"], [120, "#256abf"], [180, "#1c5cab"], [1e9, "#184f95"],
];
const bandColour = (m) => (TIME_BANDS.find((b) => m < b[0]) || TIME_BANDS[7])[1];

const TOCS = {
  GW: "GWR", SW: "South Western", SN: "Southern", SE: "Southeastern", TL: "Thameslink",
  GN: "Great Northern", GX: "Gatwick Express", LO: "London Overground", LE: "Greater Anglia",
  XC: "CrossCountry", VT: "Avanti West Coast", GR: "LNER", EM: "East Midlands Railway",
  CH: "Chiltern", CC: "c2c", AW: "Transport for Wales", NT: "Northern", TP: "TransPennine",
  ME: "Merseyrail", SR: "ScotRail", CS: "Caledonian Sleeper", HT: "Hull Trains",
  GC: "Grand Central", LD: "Lumo", LM: "West Midlands Railway", HX: "Heathrow Express",
  ES: "Eurostar", XR: "Elizabeth line", LT: "London Underground", TW: "Tyne & Wear Metro",
};

/* the planned journey is drawn in a colour that belongs to no sector, so it
   can never be mistaken for one of the fourteen networks underneath it */
const ROUTE_INK = "#f2f7fd", ROUTE_CASE = "#070a0e", WALK_INK = "#e0bb62";

const fmt = (m) => {
  if (m == null) return "—";
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};
const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const $ = (s) => document.querySelector(s);
const shortTerm = (n) => (n === "London Bridge" ? n : n.replace("London ", ""));

/* mix a hex colour towards white; used for the dimmed station fill */
function tint(hex, amt) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const m = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${m((n >> 16) & 255)},${m((n >> 8) & 255)},${m(n & 255)})`;
}

const state = {
  mode: "sector", isolated: null, terminus: null, selected: null, line: null,
  sort: "name", asc: true, highlight: null,
  from: null, to: null, journeys: null, chosen: 0,
  commute: null,          // the live isochrone, when a destination is set
  tool: null,             // which toolbar panel is open: "plan" | "prices" | null
  prices: false,          // is the house price overlay drawn?
};
const TERM_INDEX = {};        // CRS -> the index stored in network.bin
let SECTORS, TERMINI, LINES, STATIONS, TIMES, CRSNAMES = {}, STATS = {}, PATHS = {};
let BY_CRS = new Map();
let NET = null, rail, markers = new Map(), SECTOR_COLOUR = [], UNREACHED = "#5a6472";

/* ---------------------------------------------------------- projection -- */
/* Leaflet's latLngToLayerPoint allocates a Point per call. At ~900k points a
   redraw that is otherwise a few milliseconds turns into garbage collection,
   so the Web Mercator maths is inlined here. Matches L.CRS.EPSG3857 exactly. */
let PScale = 0, POx = 0, POy = 0;
function setProjection(map) {
  PScale = 256 * Math.pow(2, map.getZoom());
  const o = map.getPixelOrigin();
  POx = o.x; POy = o.y;
}
const projX = (lon) => (lon / 360 + 0.5) * PScale - POx;
const projY = (lat) =>
  (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * PScale - POy;

/* --------------------------------------------------------- rail layer -- */
/* Extends L.Renderer rather than L.Layer. Renderer already owns the oversized
   canvas, the pan translation and — critically — the zoomanim transform, which
   is what kept the old hand-rolled version frozen mid-zoom while the basemap
   moved underneath it. */
const RailLayer = L.Renderer.extend({
  options: { padding: 0.25 },

  _initContainer() {
    const c = (this._container = document.createElement("canvas"));
    c.style.pointerEvents = "none";
    this._ctx = c.getContext("2d");
  },

  _destroyContainer() {
    L.DomUtil.remove(this._container);
    this._container = null;
    this._ctx = null;
  },

  _updatePaths() { this._draw(); },

  _update() {
    if (this._map._animatingZoom && this._bounds) return;
    L.Renderer.prototype._update.call(this);
    const b = this._bounds, size = b.getSize(), m = L.Browser.retina ? 2 : 1;
    const c = this._container;
    L.DomUtil.setPosition(c, b.min);
    c.width = m * size.x;
    c.height = m * size.y;
    c.style.width = size.x + "px";
    c.style.height = size.y + "px";
    if (L.Browser.retina) this._ctx.scale(2, 2);
    this._ctx.translate(-b.min.x, -b.min.y);
    this.fire("update");
  },

  redraw() { if (this._map) this._draw(); },

  _draw() {
    if (!NET) return;
    const map = this._map, ctx = this._ctx;
    setProjection(map);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._container.width, this._container.height);
    ctx.restore();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const z = map.getZoom();
    /* Track is the ground, stations are the figure. These widths are about a
       third down from where they were: at national scale the old stroke welded
       neighbouring routes into one mass and buried the station dots sitting on
       top of them. */
    const w = z <= 6 ? 0.9 : z <= 7 ? 1.05 : z <= 9 ? 1.25 : z <= 11 ? 1.6 : z <= 13 ? 2.1 : 2.7;
    const bounds = map.getBounds().pad(this.options.padding);
    const south = bounds.getSouth(), north = bounds.getNorth();
    const west = bounds.getWest(), east = bounds.getEast();

    const { count, sector, term, prom, line, starts, counts, coords, bbox } = NET;
    /* Two sequential scales must never be on the map at once in two hues that
       both mean magnitude — and the price overlay's orange is one of the eight
       sector colours. So while the overlay is up the network goes monochrome,
       exactly as it already does for journey-time shading. The track is then
       structure, and the only thing carrying a value is the field underneath. */
    const timeMode = state.mode === "time" || state.prices;
    const iso = state.isolated ? SECTORS.findIndex((s) => s.key === state.isolated) + 1 : 0;
    const isoTerm = state.terminus ? TERM_INDEX[state.terminus] || 0 : 0;
    const hl = state.highlight;
    const lineFilter = state.line;
    const focused = hl || lineFilter != null || isoTerm !== 0;

    /* two passes so anything emphasised lands on top of what it crosses */
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < count; i++) {
        const p = prom[i];
        if (p === 0 && z < 12) continue;
        if (bbox[i * 4 + 1] < south || bbox[i * 4] > north) continue;
        if (bbox[i * 4 + 3] < west || bbox[i * 4 + 2] > east) continue;

        let on = true;
        if (hl) on = hl.has(i);
        else if (lineFilter != null) on = line[i] === lineFilter;
        else if (isoTerm) on = term[i] === isoTerm;
        else if (iso) on = sector[i] === iso;
        if ((pass === 0) === on) continue;

        const weight = p === 2 ? 1 : p === 1 ? 0.55 : 0.36;
        let colour, alpha, width = w * (p === 2 ? 1 : p === 1 ? 0.8 : 0.6);
        if (!on) {
          /* recede, do not disappear: the rest of the network is still the
             context that makes the highlighted line mean anything */
          const strong = lineFilter != null || isoTerm !== 0;   // explicit filter
          colour = focused && !strong ? (SECTOR_COLOUR[sector[i]] || UNREACHED) : "#333c47";
          alpha = (strong ? 0.10 : focused ? 0.22 : 0.30) * weight + (strong ? 0.02 : 0.04);
        } else if (timeMode) {
          colour = "#4b5562";
          alpha = 0.5 * weight + 0.08;
        } else {
          colour = SECTOR_COLOUR[sector[i]] || UNREACHED;
          alpha = 0.58 * weight + 0.04;
          /* Thicken and brighten a highlighted line so it reads from across the
             country, but ease off once you are close enough for the individual
             running lines to be the point -- at z14 a 1.7x stroke welds a
             four-track formation into one band. */
          if (focused) {
            alpha = Math.min(1, alpha + 0.3);
            width *= z >= 13 ? 1.15 : 1.6;
          }
        }
        ctx.strokeStyle = colour;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.beginPath();
        const s = starts[i], nk = counts[i];
        for (let k = 0; k < nk; k++) {
          const x = projX(coords[(s + k) * 2 + 1] / 1e5);
          const y = projY(coords[(s + k) * 2] / 1e5);
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  },

  /* nearest line to a click, for the "what line is this?" label */
  hitTest(latlng, tolPx) {
    if (!NET) return -1;
    setProjection(this._map);
    const px = projX(latlng.lng), py = projY(latlng.lat);
    const { count, prom, line, starts, counts, coords, bbox } = NET;
    const z = this._map.getZoom();
    const dLat = tolPx / (PScale / 360) * 2, dLon = dLat;
    let best = -1, bestD = tolPx * tolPx;
    for (let i = 0; i < count; i++) {
      if (!line[i]) continue;                       // unnamed track cannot be labelled
      if (prom[i] === 0 && z < 12) continue;
      if (bbox[i * 4] < latlng.lat - dLat || bbox[i * 4 + 1] > latlng.lat + dLat) continue;
      if (bbox[i * 4 + 2] < latlng.lng - dLon || bbox[i * 4 + 3] > latlng.lng + dLon) continue;
      const s = starts[i], nk = counts[i];
      let ax = projX(coords[s * 2 + 1] / 1e5), ay = projY(coords[s * 2] / 1e5);
      for (let k = 1; k < nk; k++) {
        const bx = projX(coords[(s + k) * 2 + 1] / 1e5);
        const by = projY(coords[(s + k) * 2] / 1e5);
        const vx = bx - ax, vy = by - ay, len = vx * vx + vy * vy;
        let t = len ? ((px - ax) * vx + (py - ay) * vy) / len : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
        ax = bx; ay = by;
      }
    }
    return best;
  },
});

/* --------------------------------------------------------------- map -- */
const map = L.map("map", {
  center: [53.2, -2.2], zoom: 6, minZoom: 5, maxZoom: 16,
  zoomControl: false, preferCanvas: true,
  maxBounds: [[49.0, -11.5], [61.0, 3.5]], maxBoundsViscosity: 0.7,
});
L.control.zoom({ position: "bottomright" }).addTo(map);
map.createPane("railPane").style.zIndex = 350;
map.createPane("labelPane").style.zIndex = 450;
map.getPane("labelPane").style.pointerEvents = "none";
/* Under the track and under the London outline: the overlay is ground, the
   network is figure. Above the basemap tiles so it reads at all. */
map.createPane("pricePane").style.zIndex = 320;
map.getPane("pricePane").style.pointerEvents = "none";
map.createPane("londonPane").style.zIndex = 340;
map.getPane("londonPane").style.pointerEvents = "none";
map.createPane("routePane").style.zIndex = 470;
map.getPane("routePane").style.pointerEvents = "none";
map.createPane("stationPane").style.zIndex = 500;

/* fitBounds has to keep clear of the floating chrome, or the thing you just
   asked to see lands underneath it. Measured rather than guessed: the toolbar's
   height depends on whether a tool panel is open and on how far the tool labels
   have wrapped, and a hardcoded number was wrong in every state but one. */
const wide = () => window.innerWidth > 900;
function chromeTop() {
  const bar = $("#bar");
  const h = bar ? bar.getBoundingClientRect().height : 0;
  return Math.min(window.innerHeight * 0.45, h + 20) || 80;
}
const fitPad = () => ({
  paddingTopLeft: L.point(wide() ? 24 : 16, chromeTop()),
  paddingBottomRight: L.point(wide() ? 358 : 16, wide() ? 76 : 120),
});

const ESRI = "https://services.arcgisonline.com/ArcGIS/rest/services/";
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors '
           + '&middot; basemap &copy; <a href="https://www.esri.com/">Esri</a> '
           + '&middot; times from the National Rail timetable';

const BASEMAPS = {
  dark: {
    label: "Dark",
    base: ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    labels: ESRI + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    baseClass: "basemap-tiles", labelClass: "label-tiles",
  },
  satellite: {
    label: "Satellite",
    base: ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}",
    labels: ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    baseClass: "sat-tiles", labelClass: "sat-label-tiles",
  },
};
let baseLayer = null, labelLayer = null, basemapName = "dark";

function setBasemap(name) {
  const cfg = BASEMAPS[name] || BASEMAPS.dark;
  basemapName = name;
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) map.removeLayer(labelLayer);
  baseLayer = L.tileLayer(cfg.base, { attribution: ATTR, maxZoom: 17, className: cfg.baseClass }).addTo(map);
  labelLayer = L.tileLayer(cfg.labels, { pane: "labelPane", maxZoom: 17, className: cfg.labelClass }).addTo(map);
  /* Satellite is busy and mid-toned, so the track needs a dark halo behind it
     to stay readable; the dark canvas does not. */
  document.body.classList.toggle("is-sat", name === "satellite");
  if (rail) rail.redraw();
}
setBasemap("dark");

/* ---------------------------------------------------- London outline -- */
/* "Zoom into London and it is a mess" — an administrative edge gives the eye
   something to hold on to, and tells you where the terminals sit relative to
   the city rather than to a field of track. */
let londonLayer = null;
function addLondon(data) {
  if (!data || !data.rings) return;
  londonLayer = L.layerGroup([], { pane: "londonPane" });
  for (const ring of data.rings) {
    L.polyline(ring, { pane: "londonPane", color: "#c8d6e8", weight: 1,
                       opacity: 0.3, dashArray: "5 6", interactive: false })
      .addTo(londonLayer);
  }
  londonLayer.addTo(map);
  const tune = () => {
    const z = map.getZoom();
    const op = z <= 7 ? 0.16 : z <= 9 ? 0.28 : z <= 12 ? 0.38 : 0.26;
    londonLayer.eachLayer((l) => l.setStyle({ opacity: op, weight: z >= 10 ? 1.3 : 1 }));
  };
  map.on("zoomend", tune);
  tune();
}

/* --------------------------------------------------------- bootstrap -- */
async function boot() {
  const msg = $("#loadMsg");
  const grab = async (f, type) => {
    const res = await fetch(DATA + f);
    if (!res.ok) throw new Error(`${f}: ${res.status}`);
    return type === "bin" ? res.arrayBuffer() : res.json();
  };
  const optional = (f) => grab(f).catch(() => null);

  msg.textContent = "Loading network…";
  const sec = await grab("sectors.json");
  SECTORS = sec.sectors;
  TERMINI = sec.termini;
  LINES = sec.lines || [""];
  UNREACHED = sec.unreached || UNREACHED;
  SECTOR_COLOUR = [UNREACHED, ...SECTORS.map((s) => s.colour)];
  (sec.terminusOrder || Object.keys(TERMINI)).forEach((crs, i) => { TERM_INDEX[crs] = i + 1; });

  msg.textContent = "Loading track geometry…";
  NET = parseNetwork(await grab("network.bin", "bin"));

  msg.textContent = "Loading stations…";
  const st = await grab("stations.json");
  STATIONS = st.stations;
  for (const s of Object.values(STATIONS)) if (s.crs && !BY_CRS.has(s.crs)) BY_CRS.set(s.crs, s);
  TIMES = await grab("times.json");
  PATHS = (await optional("paths.json")) || {};
  addLondon(await optional("london.json"));
  CRSNAMES = (await optional("crs_names.json")) || {};
  STATS = ((await optional("station_stats.json")) || {}).departures || {};

  msg.textContent = "Drawing…";
  await new Promise((r) => setTimeout(r, 0));
  rail = new RailLayer({ pane: "railPane" }).addTo(map);
  const b = NET.bounds;
  if (b) map.fitBounds([[b[0], b[2]], [b[1], b[3]]], fitPad());
  buildStations();
  buildLegend();
  buildProvenance();
  wireUI();
  $("#loading").hidden = true;

  /* Last, so everything it drives — the legend, the planner, the inspector —
     already exists. A link that names a journey has to load the timetable, so
     this is awaited rather than fired and forgotten. */
  await applyHash();
  lastHash = location.hash;
  /* Only re-apply when the fragment actually names something different.
     Assigning location.hash queues a hashchange even when the value is
     unchanged, so without this a programmatic restore is applied twice — which
     re-runs the journey scan and can resurrect a destination the reader has
     just cleared. */
  window.addEventListener("hashchange", () => {
    if (hashLock || location.hash === lastHash) return;
    lastHash = location.hash;
    applyHash();
  });
}

function parseNetwork(buf) {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "TRK2") {
    throw new Error("network.bin is an old format — rebuild with make network");
  }
  const count = dv.getUint32(4, true), npts = dv.getUint32(8, true);
  const oSector = dv.getUint32(12, true), oTerm = dv.getUint32(16, true);
  const oProm = dv.getUint32(20, true), oLine = dv.getUint32(24, true);
  const oCounts = dv.getUint32(28, true), oCoords = dv.getUint32(32, true);

  const sector = new Uint8Array(buf, oSector, count);
  const term = new Uint8Array(buf, oTerm, count);
  const prom = new Uint8Array(buf, oProm, count);
  const line = new Uint16Array(buf, oLine, count);
  const counts = new Uint16Array(buf, oCounts, count);
  const coords = new Int32Array(buf, oCoords, npts * 2);

  const starts = new Uint32Array(count);
  const bbox = new Float32Array(count * 4);       // minLat, maxLat, minLon, maxLon
  let at = 0;
  for (let i = 0; i < count; i++) {
    starts[i] = at;
    let mnLa = 1e9, mxLa = -1e9, mnLo = 1e9, mxLo = -1e9;
    for (let k = 0; k < counts[i]; k++) {
      const la = coords[(at + k) * 2] / 1e5, lo = coords[(at + k) * 2 + 1] / 1e5;
      if (la < mnLa) mnLa = la;
      if (la > mxLa) mxLa = la;
      if (lo < mnLo) mnLo = lo;
      if (lo > mxLo) mxLo = lo;
    }
    bbox[i * 4] = mnLa; bbox[i * 4 + 1] = mxLa;
    bbox[i * 4 + 2] = mnLo; bbox[i * 4 + 3] = mxLo;
    at += counts[i];
  }
  let mnLa = 1e9, mxLa = -1e9, mnLo = 1e9, mxLo = -1e9;
  for (let i = 0; i < count; i++) {
    if (bbox[i * 4] < mnLa) mnLa = bbox[i * 4];
    if (bbox[i * 4 + 1] > mxLa) mxLa = bbox[i * 4 + 1];
    if (bbox[i * 4 + 2] < mnLo) mnLo = bbox[i * 4 + 2];
    if (bbox[i * 4 + 3] > mxLo) mxLo = bbox[i * 4 + 3];
  }
  return { count, sector, term, prom, line, starts, counts, coords, bbox,
           bounds: [mnLa, mxLa, mnLo, mxLo] };
}

/* ---------------------------------------------------------- stations -- */
const timesFor = (id) => TIMES.stations[id] || null;
const isTerminus = (st) => !!TERMINI[st.crs];

function tierOf(st) {
  if (isTerminus(st)) return 2;
  if (st.major || (STATS[st.crs] || 0) >= 60) return 1;
  return 0;
}

/* Radius per tier per zoom band. A single multiplier does not work: at z9 the
   whole South East is on screen and an oversized minor-station dot, times two
   thousand of them, paints over the track it is meant to sit on. Minor
   stations stay pin-sized until you are close enough for them to be the
   subject rather than the texture. */
const RADII = {
  6:  [0.8, 1.7, 3.0],
  7:  [1.0, 2.0, 3.4],
  8:  [1.4, 2.6, 4.0],
  9:  [1.7, 3.0, 4.5],
  10: [2.1, 3.4, 5.1],
  11: [2.5, 3.8, 5.6],
  12: [2.9, 4.3, 6.1],
  13: [3.4, 4.8, 6.6],
};
function radiusFor(st) {
  /* getZoom() is fractional mid-flyTo, and RADII is keyed by integer, so this
     has to round before indexing or it reads off undefined during the animation */
  const z = Math.max(6, Math.min(13, Math.round(map.getZoom())));
  return RADII[z][tierOf(st)];
}

function stationStyle(st) {
  const dim = (state.isolated && st.sector !== state.isolated)
           || (state.terminus && st.terminus !== state.terminus)
           || (state.highlight && !state.highlightStations.has(st.id))
           || (state.line != null && !state.lineStations.has(st.id));
  const r = radiusFor(st);
  const base = { pane: "stationPane", radius: r,
                 weight: Math.min(2, Math.max(0.8, r * 0.5)) };

  /* the two ends of a planned journey outrank every other treatment */
  const end = state.from && state.from.id === st.id ? "a"
            : state.to && state.to.id === st.id ? "b" : null;
  if (end) {
    return { pane: "stationPane", radius: Math.max(r, 5.4), weight: 2.4,
             color: ROUTE_INK, fillColor: end === "b" ? "#4f9cf0" : "#11161d",
             opacity: 1, fillOpacity: 1 };
  }

  if (state.mode === "time") {
    const m = shadeMinsFor(st);
    return { ...base, fillColor: m == null ? "#46505d" : bandColour(m),
             color: "rgba(9,12,17,.85)", opacity: dim ? 0.35 : 0.9,
             fillOpacity: dim ? 0.4 : 1 };
  }

  /* Sector colouring plus the price overlay puts an orange dot on an orange
     field — orange is both a sector hue and the whole price ramp. The track
     already goes monochrome for this reason, and the dots have to follow, or the
     collision just moves from the lines to the stations sitting on them. Time
     mode is exempt on purpose: blue dots over an orange field is two scales in
     two hues on two different marks, which is legible and is the point. */
  if (state.prices) {
    return { ...base, fillColor: dim ? "#8d98a6" : "#f2f7fd",
             color: "rgba(7,10,14,.9)", opacity: dim ? 0.4 : 1,
             fillOpacity: dim ? 0.45 : 1 };
  }

  const colour = (SECTORS.find((s) => s.key === st.sector) || {}).colour || UNREACHED;
  /* An explicit filter should leave the rest as faint context; a station click
     is about showing one line among the others, so it fades much less. */
  const faint = state.line != null || state.isolated || state.terminus;
  /* A light core inside a ring of the line's own colour is what separates a
     station from the track it sits on. Solid dots in the sector colour
     disappeared into their own line, which is the whole complaint. */
  return { ...base,
           fillColor: dim ? tint(colour, 0.08) : "#eef4fa",
           color: colour,
           opacity: dim ? (faint ? 0.22 : 0.55) : 1,
           fillOpacity: dim ? (faint ? 0.18 : 0.5) : 1 };
}

function tooltipHTML(st) {
  const c = state.commute;
  if (c) {
    if (st.crs === c.crs) {
      return `<b>${esc(st.name)}</b><span class="tt-t">your destination</span>`;
    }
    const m = commuteMinsFor(st);
    if (m == null) {
      return `<b>${esc(st.name)}</b><span class="tt-t">no commute to `
           + `${esc(shortTerm(c.name))} by ${clock(c.arriveBy)}</span>`;
    }
    const i = c.index.get(st.crs);
    return `<b>${esc(st.name)}</b><span class="tt-t"><em>${fmt(m)}</em> to `
         + `${esc(shortTerm(c.name))} · leave ${clock(c.latest[i])}</span>`;
  }
  const t = timesFor(st.id);
  if (t && t.best && t.best.src === "terminus") {
    return `<b>${esc(st.name)}</b><span class="tt-t">London terminus</span>`;
  }
  if (!t || !t.best) return `<b>${esc(st.name)}</b><span class="tt-t">no London service</span>`;
  const term = TERMINI[t.best.terminus];
  const tag = t.best.est ? " (est.)" : "";
  return `<b>${esc(st.name)}</b><span class="tt-t"><em>${fmt(t.best.mins)}</em>${tag} to `
       + `${esc(term ? term.name : t.best.terminus)}</span>`;
}

let stationLayer;
let lastMarkerClick = 0;
/* Leaflet's Map.closeTooltip needs the tooltip itself, so hold the marker whose
   tooltip is pinned open rather than trying to close "whatever is showing" */
let openTip = null;
function buildStations() {
  stationLayer = L.layerGroup().addTo(map);
  for (const st of Object.values(STATIONS)) {
    if (!st.terminus && !st.crs) continue;
    const m = L.circleMarker([st.lat, st.lon], stationStyle(st));
    m._st = st;
    m.bindTooltip(tooltipHTML(st), { className: "tt", direction: "top", offset: [0, -4] });
    m.on("click", (e) => {
      /* canvas-rendered markers still bubble to the map, which would then run
         the line hit-test and replace the station we just selected */
      L.DomEvent.stop(e);
      lastMarkerClick = Date.now();
      select(st.id);
    });
    markers.set(st.id, m);
    stationLayer.addLayer(m);
  }
  /* Name the terminals when zoomed in — the single most useful orientation cue
     once the map is full of London track. Held back to z12: all fourteen sit
     inside a couple of miles, and at z10 the labels sit on top of each other. */
  const termLabels = L.layerGroup();
  for (const [crs, t] of Object.entries(TERMINI)) {
    L.marker([t.lat, t.lon], {
      pane: "stationPane", interactive: false,
      icon: L.divIcon({ className: "term-label", html: esc(shortTerm(t.name)),
                        iconSize: null, iconAnchor: [-8, 8] }),
    }).addTo(termLabels);
  }
  const tuneLabels = () => {
    const want = map.getZoom() >= 12;
    if (want && !map.hasLayer(termLabels)) termLabels.addTo(map);
    else if (!want && map.hasLayer(termLabels)) map.removeLayer(termLabels);
  };
  map.on("zoomend", () => { restyleStations(); tuneLabels(); });
  tuneLabels();
}

function restyleStations() {
  for (const m of markers.values()) m.setStyle(stationStyle(m._st));
}

/* ------------------------------------------------------------ legend -- */
function buildLegend() {
  const el = $("#legend");
  /* While the overlay is up the track is deliberately monochrome, so a legend
     naming fourteen terminus colours would be describing a map that is not on
     screen. Say what is actually carrying a value instead. */
  const overlay = state.prices
    ? `<p class="note">The house price overlay is on, so the track is drawn in
        one tone — the colour on screen is price, not terminus. Its scale is in
        the <strong>House prices</strong> panel.</p>`
    : "";
  if (state.mode === "time") {
    const c = state.commute;
    el.innerHTML = `<h2>${c ? "Commute to " + esc(shortTerm(c.name)) : "Fastest time into London"}</h2>
      <div class="ramp">${TIME_BANDS.map((b) => `<span style="background:${b[1]}"></span>`).join("")}</div>
      <div class="ramp-labels"><span>15m</span><span>1h</span><span>2h</span><span>3h+</span></div>
      <p class="note">${c
        ? `Every station you could leave from and still reach
           <strong>${esc(c.name)}</strong> by <strong>${clock(c.arriveBy)}</strong>.
           Unshaded stations have no such journey within ${COMMUTE_WINDOW / 60} hours.
           Hover for the time and the last train that makes it.`
        : `Each station is shaded by its journey time into the London
           terminus it serves. Hover for the exact figure.`}</p>` + overlay;
    return;
  }

  /* Count per terminus, not just per sector: "which trains go to Waterloo" is
     the question people actually have, and the eight-way sector grouping could
     not answer it. Sectors stay as the colour grouping and as a coarse filter. */
  const perTerm = {}, perSector = {};
  for (const st of Object.values(STATIONS)) {
    if (st.terminus) perTerm[st.terminus] = (perTerm[st.terminus] || 0) + 1;
    if (st.sector) perSector[st.sector] = (perSector[st.sector] || 0) + 1;
  }

  el.innerHTML = `<h2>London terminus</h2>
    <div class="term-list">${SECTORS.map((s) => {
      const secOn = state.isolated === s.key;
      const rows = s.termini.map((crs) => {
        const t = TERMINI[crs];
        if (!t) return "";
        const on = state.terminus === crs;
        const off = (state.terminus && !on) || (state.isolated && !secOn);
        return `<button class="term ${on ? "is-on" : ""} ${off ? "is-off" : ""}"
                  data-crs="${crs}" aria-pressed="${on}">
            <i style="background:${s.colour}"></i>
            <span class="nm">${esc(shortTerm(t.name))}</span>
            <span class="n">${perTerm[crs] || 0}</span></button>`;
      }).join("");
      const gOff = (state.terminus || (state.isolated && !secOn));
      return `<div class="term-group">
          <button class="grp ${secOn ? "is-on" : ""} ${gOff ? "is-off" : ""}"
                  data-sector="${s.key}" aria-pressed="${secOn}"
                  title="Show the whole ${esc(s.label)} network">
            ${esc(s.label)}<span class="n">${perSector[s.key] || 0}</span></button>
          ${rows}</div>`;
    }).join("")}</div>
    <p class="note">${state.terminus
        ? `Showing trains into ${esc(shortTerm(TERMINI[state.terminus].name))}.`
        : state.isolated ? "Showing one sector."
        : "Pick a terminus, or a sector heading for the whole group."}
      ${state.terminus || state.isolated ? "Click it again to clear." : ""}</p>` + overlay;

  el.querySelectorAll(".term").forEach((b) => b.addEventListener("click", () => {
    state.terminus = state.terminus === b.dataset.crs ? null : b.dataset.crs;
    state.isolated = null;
    resetFocus();
  }));
  el.querySelectorAll(".grp").forEach((b) => b.addEventListener("click", () => {
    state.isolated = state.isolated === b.dataset.sector ? null : b.dataset.sector;
    state.terminus = null;
    resetFocus();
  }));
}

function resetFocus() {
  state.line = null;
  state.lineStations = new Set();
  $("#lineSel").value = "";
  clearHighlight(false);
  rail.redraw();
  restyleStations();
  buildLegend();
  syncHash();
}

function buildProvenance() {
  const real = TIMES.source === "timetable";
  $("#prov").innerHTML = real
    ? `Times: National Rail timetable, ${esc(TIMES.generated)}. Geometry © OpenStreetMap contributors.`
    : `Times: <strong>estimated</strong> from track distance. Geometry © OpenStreetMap contributors.`;
}

/* --------------------------------------------------------- highlight -- */
/* Walk the chain of segments from this station down to its terminus. Each
   station stores only the track between it and the next one along, so the
   trunk into London is held once rather than once per station behind it. */
function routeFrom(id) {
  const feats = new Set(), stops = new Set([id]);
  let cur = id;
  for (let i = 0; i < 400; i++) {
    const seg = PATHS[cur];
    if (!seg) break;
    for (const f of seg.f) feats.add(f);
    if (!seg.next || stops.has(seg.next)) break;
    cur = seg.next;
    stops.add(cur);
  }

  /* The chain only runs towards London. Add the named line the station sits on
     so the highlight covers the whole line, including the half that carries on
     away from town -- clicking Reading should light up the Great Western Main
     Line in both directions, not just the run in to Paddington. */
  const own = PATHS[id];
  if (own && NET && own.first >= 0) {
    const lineIdx = NET.line[own.first];
    if (lineIdx) {
      for (let i = 0; i < NET.count; i++) if (NET.line[i] === lineIdx) feats.add(i);
    }
  }
  return { feats, stops };
}

function clearHighlight(redraw = true) {
  state.highlight = null;
  state.highlightStations = new Set();
  if (redraw) { rail.redraw(); restyleStations(); }
}
state.highlightStations = new Set();
state.lineStations = new Set();

/* ---------------------------------------------------------- inspector -- */
function showInfo(on) {
  $("#inspector").hidden = !on;
  if (on) $(".ins-scroll").scrollTop = 0;
}

async function select(id) {
  state.selected = id;
  showInfo(true);
  const st = STATIONS[id], t = timesFor(id);
  const el = $("#detail");
  const route = routeFrom(id);
  if (route.feats.size) {
    state.highlight = route.feats;
    state.highlightStations = route.stops;
    state.line = null;
    rail.redraw();
    restyleStations();
  } else {
    clearHighlight();
  }
  openTip?.closeTooltip();
  openTip = markers.get(id) || null;
  openTip?.openTooltip();

  const sec = SECTORS.find((x) => x.key === st.sector);
  const head = `<div class="st-head"><p class="st-name">${esc(st.name)}</p>
      <button class="icon-btn" id="shareSel" title="Copy a link to this station">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M6.5 9.5 9.5 6.5M7 4.2 8.4 2.8a2.7 2.7 0 0 1 3.8 3.8L10.8 8M9 11.8l-1.4 1.4a2.7 2.7 0 0 1-3.8-3.8L5.2 8"
                fill="none" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg><span class="sr">Copy link</span></button>
      <button class="icon-btn" id="clearSel" title="Close">&times;</button></div>`;
  const meta = `<p class="st-meta">${[st.crs, st.operator, sec ? sec.label : null]
      .filter(Boolean).map(esc).join(" · ")}</p>`;
  const setters = st.crs ? `<div class="chips">
      <button class="chip" data-set="from">Set as start</button>
      <button class="chip" data-set="to">Set as destination</button></div>` : "";

  if (t && t.best && t.best.src === "terminus") {
    el.innerHTML = head + `<p class="st-meta">${esc(st.crs)} · London terminus${
      sec ? " · " + esc(sec.label) : ""}</p>` + setters +
      `<p class="hint">Journey times on this map are measured into here.</p>
      <div id="dep" class="ins-sec"></div>`;
  } else if (!t || !t.best) {
    el.innerHTML = head + `<p class="st-meta">${esc(st.crs || "no CRS code")} · no London service found</p>`
      + setters + `<div id="dep" class="ins-sec"></div>`;
  } else {
    const best = t.best, term = TERMINI[best.terminus];
    const TAGS = { timetable: ["exact", "timetabled"], published: ["exact", "published"],
                   model: ["est", "estimated"] };
    const [cls, word] = TAGS[best.src] || (best.est ? TAGS.model : TAGS.timetable);
    el.innerHTML = head + meta + setters + `
      <div class="st-hero"><b>${fmt(best.mins)}</b><span>fastest</span>
        <span class="tag ${cls}">${word}</span></div>
      <p class="st-to">to ${esc(term ? term.name : best.terminus)}${best.changes
          ? ` · ${best.changes} change${best.changes > 1 ? "s" : ""}` : ""}</p>
      ${best.typical || best.services ? `<p class="st-stats">${[
          best.typical ? `typically ${fmt(best.typical)}` : null,
          best.services ? `${best.services} trains on a weekday` : null,
        ].filter(Boolean).join(" · ")}</p>` : ""}
      ${t.all.length > 1 ? `<div class="ins-sec"><h3>Every terminus it reaches</h3>
        <div class="st-rows">${t.all.slice(0, 6).map((e) => {
        const tn = TERMINI[e.terminus];
        const colour = (SECTORS.find((s) => s.key === (tn && tn.sector)) || {}).colour || UNREACHED;
        return `<div class="st-row"><i style="background:${colour}"></i>
          <span class="term">${esc(tn ? shortTerm(tn.name) : e.terminus)}</span>
          <span class="km">${e.changes ? e.changes + " chg" : e.services ? e.services + " trains" : ""}</span>
          <span class="mins">${fmt(e.mins)}</span></div>`;
      }).join("")}</div></div>` : ""}
      <div id="dep" class="ins-sec"></div>`;
  }
  /* One insertion point rather than threading the panel through all three
     branches above — they differ in what they say about London, not in where
     a commute belongs. */
  if (state.commute) {
    const anchor = el.querySelector(".chips") || el.querySelector(".st-meta");
    if (anchor) anchor.insertAdjacentHTML("afterend", commutePanel(st));
  }
  /* The two numbers only mean anything together: forty minutes is a different
     proposition at £240,000 than at £740,000. So once the price data is loaded
     it travels with every station, whether or not the overlay is drawn. */
  if (Prices.ready()) {
    const hp = Prices.at(st.lat, st.lon);
    const anchor = el.querySelector(".cmt") || el.querySelector(".chips")
                || el.querySelector(".st-meta");
    if (hp && anchor) anchor.insertAdjacentHTML("afterend", priceRowHTML(hp));
  }
  $("#clearSel")?.addEventListener("click", clearSelection);
  $("#shareSel")?.addEventListener("click", (e) => copyLink(e.currentTarget));
  el.querySelectorAll(".chip[data-set]").forEach((b) => b.addEventListener("click", () => {
    setEndpoint(b.dataset.set, st);
  }));
  syncHash();
  if (st.crs) await loadDepartures(st.crs);
}

/* ------------------------------------------------- service pattern -- */
/* The three things that actually decide whether a commute works: when the
   first train goes, when the last one goes, and how often they run in between.
   All of it is already inside the departure board we just fetched, so this
   costs no extra request and no extra data file. */
function servicePattern(times) {
  if (!times || !times.length) return null;
  const perHour = new Array(24).fill(0);
  let first = Infinity, last = -Infinity;
  for (const t of times) {
    perHour[Math.floor(t / 60) % 24]++;
    if (t < first) first = t;
    if (t > last) last = t;
  }
  let busiest = 0;
  for (let h = 1; h < 24; h++) if (perHour[h] > perHour[busiest]) busiest = h;

  /* "Typical" is the median over the hours that actually have a service, not
     over all 24 — averaging in the small hours makes every station look like a
     branch line. */
  const running = perHour.filter((n) => n > 0).sort((a, b) => a - b);
  const typical = running.length
    ? running[running.length >> 1] : 0;

  return { perHour, first, last, busiest, peak: perHour[busiest], typical,
           total: times.length };
}

/* A 24-hour column per hour, height carrying the count — one hue, because this
   is one series and the bars are magnitudes, not identities. The hour you are
   in is emphasised rather than recoloured into a second category, and it is
   named in the caption underneath so the cue is never colour alone. */
function patternHTML(pat, nowHour) {
  const max = Math.max(1, pat.peak);
  const bars = pat.perHour.map((n, h) => {
    const pct = n ? Math.max(6, Math.round((n / max) * 100)) : 0;
    const now = h === nowHour;
    return `<span class="svc-bar${now ? " is-now" : ""}${n ? "" : " is-nil"}"
       style="--h:${pct}%" title="${String(h).padStart(2, "0")}:00 — ${n} ${
       n === 1 ? "train" : "trains"}"></span>`;
  }).join("");
  const label = `Departures per hour. First ${clock(pat.first)}, last ${clock(pat.last)}, `
              + `busiest ${String(pat.busiest).padStart(2, "0")}:00 with ${pat.peak}.`;
  return `<div class="svc">
    <dl class="svc-kpi">
      <div><dt>First</dt><dd>${clock(pat.first)}</dd></div>
      <div><dt>Last</dt><dd>${clock(pat.last)}</dd></div>
      <div><dt>Per day</dt><dd>${pat.total}</dd></div>
    </dl>
    <div class="svc-strip" role="img" aria-label="${esc(label)}">${bars}</div>
    <div class="svc-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    <p class="svc-cap">Busiest ${String(pat.busiest).padStart(2, "0")}:00 with
      ${pat.peak} ${pat.peak === 1 ? "train" : "trains"} ·
      typically ${pat.typical} an hour while running</p>
  </div>`;
}

/* The same strip, but for one origin-destination pair.
 *
 * Counting departures at a station answers a question nobody asked once they
 * have said where they are going: 820 trains leave Paddington and sixteen of
 * them go to Kemble. It is the sixteen that decide whether the journey works,
 * and the first and last of those that decide whether you can get home. */
let odCache = { key: null, val: null };

function routePattern(fromCrs, toCrs) {
  const key = fromCrs + ">" + toCrs;
  if (odCache.key === key) return odCache.val;
  let val = null;
  try {
    const svc = Journey.directServices(fromCrs, toCrs);
    if (svc && svc.length) {
      const pat = servicePattern(svc.map((s) => s.dep));
      const durs = svc.map((s) => s.arr - s.dep).sort((a, b) => a - b);
      const ops = [...new Set(svc.map((s) => s.toc).filter(Boolean))];
      val = { ...pat, fastest: durs[0], median: durs[durs.length >> 1], ops };
    } else {
      val = { none: true };
    }
  } catch { val = null; }
  odCache = { key, val };
  return val;
}

function routePatternHTML(pat, fromName, toName, nowHour) {
  if (!pat) return "";
  if (pat.none) {
    return `<p class="jp-none">No direct train from ${esc(fromName)} to ${esc(toName)} —
      every option below involves a change.</p>`;
  }
  return `<div class="svc svc-route">
    <dl class="svc-kpi">
      <div><dt>First</dt><dd>${clock(pat.first)}</dd></div>
      <div><dt>Last</dt><dd>${clock(pat.last)}</dd></div>
      <div><dt>Direct</dt><dd>${pat.total}</dd></div>
    </dl>
    <div class="svc-strip" role="img"
         aria-label="${esc(`Direct trains per hour from ${fromName} to ${toName}. `
           + `First ${clock(pat.first)}, last ${clock(pat.last)}, ${pat.total} in the day.`)}">${
      pat.perHour.map((n, h) => {
        const p = n ? Math.max(6, Math.round((n / Math.max(1, pat.peak)) * 100)) : 0;
        return `<span class="svc-bar${h === nowHour ? " is-now" : ""}${n ? "" : " is-nil"}"
           style="--h:${p}%" title="${String(h).padStart(2, "0")}:00 — ${n} direct"></span>`;
      }).join("")}</div>
    <div class="svc-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    <p class="svc-cap">${pat.total} direct ${pat.total === 1 ? "train" : "trains"} a day ·
      fastest ${fmt(pat.fastest)} · typically ${fmt(pat.median)}${
      pat.ops.length ? " · " + esc(pat.ops.map((o) => TOCS[o] || o).join(", ")) : ""}</p>
  </div>`;
}

async function loadDepartures(crs) {
  const box = $("#dep");
  if (!box) return;
  /* station_stats knows which stations have a board, so a station without one
     costs no request and logs no 404 */
  if (STATS && Object.keys(STATS).length && !STATS[crs]) {
    box.innerHTML = `<p class="dep-none">No departures in the timetable for this station.</p>`;
    return;
  }
  box.innerHTML = `<p class="dep-loading">Loading departures…</p>`;
  let data;
  try {
    const res = await fetch(`${DATA}departures/${encodeURIComponent(crs)}.json`);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    box.innerHTML = `<p class="dep-none">No departure board for this station.</p>`;
    return;
  }
  if (state.selected && STATIONS[state.selected]?.crs !== crs) return;   // user moved on

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const upcoming = data.dep.filter((d) => d[0] >= nowMin);
  const rows = (upcoming.length ? upcoming : data.dep).slice(0, 60);
  const pat = servicePattern(data.dep.map((d) => d[0]));
  box.innerHTML = `
    ${pat ? `<div class="dep-head"><h3>Service</h3>
      <span>${esc(data.day)}</span></div>` + patternHTML(pat, now.getHours()) : ""}
    <div class="dep-head"><h3>Departures</h3>
      <span>${esc(data.day)} · ${data.dep.length} trains</span></div>
    ${upcoming.length ? "" : `<p class="dep-none">All of today's services have gone; showing from the start of the day.</p>`}
    <div class="dep-list">${rows.map((d) => {
      const [t, dest, toc, plat] = d;
      return `<div class="dep-row"><span class="t">${clock(t)}</span>
        <span class="d">${esc(CRSNAMES[dest] || dest)}</span>
        <span class="o">${esc(TOCS[toc] || toc || "")}</span>
        <span class="p">${plat ? esc(plat) : ""}</span></div>`;
    }).join("")}</div>`;
}

/* ------------------------------------------------------- line labels -- */
let linePopup = null;

function stationsOnLine(idx) {
  const out = new Set();
  if (!NET) return out;
  for (const [id, seg] of Object.entries(PATHS)) {
    if (seg.f.some((f) => NET.line[f] === idx)) out.add(id);
  }
  return out;
}

function showLine(idx, latlng) {
  state.line = idx;
  state.selected = null;
  state.lineStations = stationsOnLine(idx);
  showInfo(true);
  openTip?.closeTooltip();
  openTip = null;
  clearHighlight(false);
  rail.redraw(); restyleStations();
  const name = LINES[idx];
  $("#detail").innerHTML = `<div class="st-head"><p class="st-name">${esc(name)}</p>
      <button class="icon-btn" id="clearLine" title="Show everything">&times;</button></div>
    <p class="st-meta">Named line · other track dimmed</p>
    <p class="hint">Click a station on it for departures and times.</p>`;
  $("#clearLine").addEventListener("click", clearSelection);
  $("#lineSel").value = String(idx);
  syncHash();

  /* name it on the map itself, where the click happened */
  if (linePopup) map.closePopup(linePopup);
  if (latlng) {
    linePopup = L.popup({ className: "line-pop", closeButton: true, autoPan: false,
                          offset: [0, -4] })
      .setLatLng(latlng)
      .setContent(`<b>${esc(name)}</b><br><span class="pop-hint">click the line again to clear</span>`)
      .openOn(map);
  }
}

function clearSelection() {
  state.line = null;
  state.selected = null;
  state.lineStations = new Set();
  clearPlace();
  if (linePopup) { map.closePopup(linePopup); linePopup = null; }
  openTip?.closeTooltip();
  openTip = null;
  const sel = $("#lineSel");
  if (sel) sel.value = "";
  showInfo(false);
  clearHighlight();
  syncHash();
}

/* ------------------------------------------------------ route overlay -- */
let routeLayer = null;

/* The map is built with preferCanvas, and a canvas-rendered polyline has no
   stroke to animate. The route is the one thing on this map that has to move,
   so it gets its own SVG renderer: the flow dash and the draw-on reveal are
   both stroke-dashoffset, which only exists in SVG. Everything else — a
   million points of track — stays on canvas where it belongs. */
const routeRenderer = L.svg({ pane: "routePane", padding: 0.6 });
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");

const stopLL = (i) => {
  const st = BY_CRS.get(Journey.data.stops[i]);
  return st ? [st.lat, st.lon] : null;
};

/* The polyline for one leg, following the rails.
 *
 * Joining calling points with straight lines draws a chord across open
 * country: it cuts every curve and takes the Settle & Carlisle over the
 * fells in one hop. Between each consecutive pair this asks web/track.js for
 * the real alignment — which walks the station-adjacency graph, since a fast
 * train's calling points are usually not neighbours on the track — and falls
 * back to the chord only where the segment graph genuinely cannot connect
 * them. Walking legs stay straight: they are not on rails. */
function legLine(leg) {
  const stops = Journey.stopsOfLeg(leg);
  /* typeof, not just ready(): if segments.bin is missing the page must still
     draw the route as chords rather than throw on an undefined module. */
  if (leg.walk || typeof Track === "undefined" || !Track.ready()) {
    return stops.map(stopLL).filter(Boolean);
  }

  const out = [];
  const push = (p) => {
    if (!p) return;
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) return;
    out.push(p);
  };
  for (let i = 1; i < stops.length; i++) {
    const a = Journey.data.stops[stops[i - 1]], b = Journey.data.stops[stops[i]];
    const line = Track.between(a, b);
    if (line) line.forEach(push);
    else { push(stopLL(stops[i - 1])); push(stopLL(stops[i])); }
  }
  return out.length >= 2 ? out : stops.map(stopLL).filter(Boolean);
}

/* ------------------------------------------------------ route motion -- */
/* Two animations, doing different jobs. The reveal draws the ribbon from origin
   to destination once, leg by leg, so you read the journey in the order you
   would travel it. The pulse then runs the whole route on a loop, which is what
   makes a six-hour Penzance–Inverness read as a long way rather than a long
   line. Both are off under prefers-reduced-motion; the route still draws. */
let pulseDot = null, pulseAF = 0, revealTimers = [];

function stopRouteAnim() {
  if (pulseAF) { cancelAnimationFrame(pulseAF); pulseAF = 0; }
  revealTimers.forEach(clearTimeout);
  revealTimers = [];
  pulseDot = null;
}

/* Leaflet rewrites a path's `d` on every zoom, so the dash pattern set here
   would clip the re-projected line at a different length. Strip the inline dash
   once the reveal has played — offset 0 with no dasharray is just a solid line. */
function revealPath(layer, delay, dur) {
  const el = layer._path;
  if (!el || typeof el.getTotalLength !== "function") return;
  let len = 0;
  try { len = el.getTotalLength(); } catch { return; }
  if (!len) return;
  el.style.transition = "none";
  el.style.strokeDasharray = `${len} ${len}`;
  el.style.strokeDashoffset = String(len);
  void el.getBoundingClientRect();                  // flush, or there is no start state
  el.style.transition = `stroke-dashoffset ${dur}ms cubic-bezier(.33,0,.2,1) ${delay}ms`;
  el.style.strokeDashoffset = "0";
  revealTimers.push(setTimeout(() => {
    el.style.transition = el.style.strokeDasharray = el.style.strokeDashoffset = "";
  }, delay + dur + 60));
}

/* A dot running the route, timed so a long journey takes visibly longer than a
   short one. Distances are chord lengths in degrees with a cos(lat) correction
   — plenty for positioning one marker, and far cheaper than projecting. */
function runPulse(pts, group) {
  if (REDUCED.matches || pts.length < 2) return;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dy = pts[i][0] - pts[i - 1][0];
    const dx = (pts[i][1] - pts[i - 1][1]) * Math.cos((pts[i][0] * Math.PI) / 180);
    cum.push(cum[i - 1] + Math.hypot(dy, dx));
  }
  const total = cum[cum.length - 1];
  if (!total) return;

  pulseDot = L.circleMarker(pts[0], {
    renderer: routeRenderer, radius: 3.6, weight: 2, color: ROUTE_CASE,
    fillColor: ROUTE_INK, opacity: 0.9, fillOpacity: 1, interactive: false,
    className: "route-pulse",
  }).addTo(group);

  const dur = Math.min(9000, Math.max(3500, total * 900));
  const hold = 700;                                  // pause at the destination
  const mine = pulseDot;
  let t0 = 0;
  const step = (now) => {
    if (pulseDot !== mine || !map.hasLayer(group)) return;
    if (!t0) t0 = now;
    const phase = (now - t0) % (dur + hold);
    const f = Math.min(1, phase / dur);
    const d = f * total;
    let k = 1;
    while (k < cum.length - 1 && cum[k] < d) k++;
    const span = cum[k] - cum[k - 1] || 1;
    const u = (d - cum[k - 1]) / span;
    mine.setLatLng([
      pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * u,
      pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * u,
    ]);
    mine.setStyle({ opacity: f >= 1 ? 0 : 0.9, fillOpacity: f >= 1 ? 0 : 1 });
    pulseAF = requestAnimationFrame(step);
  };
  pulseAF = requestAnimationFrame(step);
}

function clearRoute() {
  stopRouteAnim();
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
}

/* Drop the planned journey entirely — both endpoints, the drawn ribbon and the
   results list. Clearing the *selection* was never enough: the ribbon belongs to
   the journey, not to the selection, so clicking the map left it stranded on
   screen with nothing that would dismiss it. */
function clearJourney() {
  clearRoute();
  state.from = null;
  state.to = null;
  state.journeys = null;
  state.chosen = 0;
  /* The isochrone belongs to the destination, so dropping the destination has
     to drop it too. Setting state.to directly bypasses setEndpoint, which is
     where that normally happens — so it is done explicitly here rather than
     leaving the map shaded against a destination the card no longer names. */
  clearCommute();
  updateChrome();
  for (const k of ["from", "to"]) {
    const input = $(k === "from" ? "#fromInput" : "#toInput");
    if (input) input.value = "";
    const x = document.querySelector(`.ac-x[data-clear="${k}"]`);
    if (x) x.hidden = true;
  }
  renderPlan(null);
  syncClearBtn();
  restyleStations();
  syncHash();
}

const hasJourney = () => !!(routeLayer || state.from || state.to);

function syncClearBtn() {
  const b = $("#clearBtn");
  if (b) b.hidden = !hasJourney();
}

/* The ribbon runs through every calling point of every leg, so at national
   scale it traces the real alignment closely. It is a route overlay, not track
   geometry — between two adjacent stations it is a straight line. */
function drawRoute(j, fit) {
  clearRoute();
  if (!j) return;
  const g = L.layerGroup([]);
  const all = [];
  const legPaths = [];
  for (const leg of j.legs) {
    const ll = legLine(leg);
    if (ll.length < 2) continue;
    all.push(...ll);
    L.polyline(ll, { renderer: routeRenderer, color: ROUTE_CASE, weight: 6.5,
                     opacity: 0.45, interactive: false }).addTo(g);
    const line = L.polyline(ll, { renderer: routeRenderer,
                     color: leg.walk ? WALK_INK : ROUTE_INK,
                     weight: leg.walk ? 2 : 2.8, opacity: 0.95,
                     dashArray: leg.walk ? "2 5" : null, interactive: false }).addTo(g);
    /* A second, dashed stroke on top of the solid one, animated in CSS. The
       direction of travel is the thing a static ribbon cannot tell you — which
       end is Penzance and which is Inverness. Walking legs are already dashed,
       so they get the flow instead of a duplicate. */
    let flow = null;
    if (!leg.walk) {
      flow = L.polyline(ll, { renderer: routeRenderer, color: ROUTE_CASE, weight: 2.8,
                              opacity: 0.55, interactive: false,
                              className: "route-flow" }).addTo(g);
    }
    legPaths.push({ line, flow });
    if (!leg.walk) {
      // mark where you change trains
      const end = ll[ll.length - 1];
      L.circleMarker(end, { renderer: routeRenderer, radius: 3.4, weight: 1.6,
                            color: ROUTE_CASE, fillColor: ROUTE_INK,
                            opacity: 0.9, fillOpacity: 1, interactive: false }).addTo(g);
    }
  }
  if (!all.length) return;
  for (const [ll, txt] of [[all[0], state.from?.name], [all[all.length - 1], state.to?.name]]) {
    if (!txt) continue;
    L.marker(ll, { pane: "routePane", interactive: false,
      icon: L.divIcon({ className: "route-label", html: esc(txt),
                        iconSize: null, iconAnchor: [-9, 9] }) }).addTo(g);
  }
  routeLayer = g.addTo(map);
  syncClearBtn();

  /* Reveal leg by leg, in travel order, then start the pulse once the last leg
     has landed. Total is capped so a nine-change epic does not take ten seconds
     to appear. */
  if (!REDUCED.matches && legPaths.length) {
    const per = Math.max(180, Math.min(520, 1400 / legPaths.length));
    legPaths.forEach(({ line, flow }, i) => {
      revealPath(line, i * per, per);
      /* A CSS animation outranks an inline style, so the flow dash cannot be
         revealed the same way — it would run at full length over a leg that has
         not drawn yet. Hold it hidden and fade it in as its leg lands. */
      if (!flow || !flow._path) return;
      flow._path.style.opacity = "0";
      revealTimers.push(setTimeout(() => {
        flow._path.style.transition = "opacity 260ms ease-out";
        flow._path.style.opacity = "";
      }, i * per + per * 0.75));
    });
    revealTimers.push(setTimeout(() => runPulse(all, g), legPaths.length * per + 120));
  } else {
    runPulse(all, g);
  }
  if (fit) map.fitBounds(L.latLngBounds(all), fitPad());
}

/* ------------------------------------------------- start / destination -- */
/* `quiet` sets the field without replanning, for the caller that is about to
   set the other end too and would otherwise run the scan twice */
function setEndpoint(which, st, quiet = false) {
  state[which] = st;
  const input = $(which === "from" ? "#fromInput" : "#toInput");
  input.value = st ? st.name : "";
  document.querySelector(`.ac-x[data-clear="${which}"]`).hidden = !st;
  restyleStations();
  syncClearBtn();
  /* Naming a destination is what puts the map into commute mode; clearing it
     hands the map back to London. This runs even when `quiet` is set, because
     the shading is not a journey search — swapping the two ends should still
     re-measure the country against the new destination. */
  if (which === "to") {
    if (st) setCommute(st);
    else clearCommute();
  }
  updateChrome();
  if (quiet) return;
  if (state.from && state.to) { runPlan(); return; }
  /* One end is missing, so whatever is drawn belongs to a journey that no
     longer exists. This used to clear only when the *destination* went away:
     clearing the start instead left the old ribbon on the map underneath a
     "now pick a starting station" prompt. */
  clearRoute();
  state.journeys = null;
  if (state.to) renderMsg("Now pick a starting station.");
  else renderPlan(null);
}

function resolveStation(text) {
  const v = (text || "").trim();
  if (!v) return null;
  const up = v.toUpperCase();
  if (/^[A-Z]{3}$/.test(up) && BY_CRS.has(up)) return BY_CRS.get(up);
  const lower = v.toLowerCase();
  /* Object.values order is whatever the JSON happened to hold, so "first prefix
     match wins" returned an arbitrary station — typing "Ash" could resolve to
     Ashburys or Ashford depending on the build. Prefer an exact name, then the
     shortest prefix match, and prefer a station the timetable can actually
     route from: 658 of the 3,250 stations have no CRS code. */
  let exact = null, best = null;
  for (const s of Object.values(STATIONS)) {
    if (!s.name) continue;
    const n = s.name.toLowerCase();
    if (n === lower) { if (!exact || (s.crs && !exact.crs)) exact = s; continue; }
    if (!n.startsWith(lower)) continue;
    if (!best) { best = s; continue; }
    const better = (!!s.crs) - (!!best.crs) || best.name.length - s.name.length
                 || best.name.localeCompare(s.name) * -1;
    if (better > 0) best = s;
  }
  return exact || best;
}

let jpReady = false;
async function jpEnsure() {
  if (jpReady) return true;
  renderMsg("Loading the timetable…");
  try {
    await Journey.load(DATA);
  } catch (err) {
    renderMsg(`Could not load the timetable: ${esc(err.message)}. Run <code>make timetable</code>.`);
    return false;
  }
  /* Track geometry is a nicety, not a prerequisite — if it fails to load the
     route still draws, just as chords. So it is awaited but never fatal. */
  try {
    if (typeof Track !== "undefined") await Track.load(DATA);
  } catch (err) {
    console.warn("track geometry unavailable, routes will be drawn as chords:", err.message);
  }
  jpReady = true;
  return true;
}

function renderMsg(html) {
  const box = $("#cmdOut");
  /* A result nobody can see is not a result. Every path that produces one —
     a shared link, the inspector's "plan this journey" chip, the Enter key —
     goes through here or renderPlan, so this is the one place that has to make
     sure the panel holding it is open. */
  openTool("plan");
  box.hidden = false;
  box.innerHTML = `<p class="jp-msg">${html}</p>`;
}

function renderPlan(res) {
  const box = $("#cmdOut");
  if (!res) { box.hidden = true; box.innerHTML = ""; state.journeys = null; return; }
  openTool("plan");
  box.hidden = false;
  const names = Journey.data.names;
  const nm = (i) => esc(names[Journey.data.stops[i]] || Journey.data.stops[i]);
  if (res.error) { renderMsg(esc(res.error) + "."); return; }
  if (!res.journeys.length) {
    renderMsg(`No journey found from ${esc(state.from.name)} to ${esc(state.to.name)}
      later that day. The timetable covers one representative
      ${esc(Journey.data.day)}; a route needing several changes late at night
      may genuinely not exist.`);
    return;
  }
  state.journeys = res.journeys;
  const od = state.from.crs && state.to.crs
    ? routePattern(state.from.crs, state.to.crs) : null;
  box.innerHTML = `<div class="jp-head">
      <span class="rt">${esc(state.from.name)} → ${esc(state.to.name)}</span>
      <span class="day">${esc(Journey.data.day)} ${esc(Journey.data.date)}</span></div>`
    + routePatternHTML(od, state.from.name, state.to.name, new Date().getHours())
    + res.journeys.map((j, n) => `
      <div class="jp-j ${n === state.chosen ? "open sel" : ""}" data-n="${n}">
        <button class="jp-sum" aria-expanded="${n === state.chosen}">
          <b>${clock(j.dep)} → ${clock(j.arr)}</b>
          <span class="dur">${fmt(j.mins)}</span>
          <span class="chg">${j.changes === 0 ? "direct"
            : j.changes + " change" + (j.changes > 1 ? "s" : "")}</span>
        </button>
        <div class="jp-legs">${j.legs.map((l) => l.walk
          ? `<div class="jp-leg walk"><span class="tm">${fmt(l.arr - l.dep)} walk</span>
               <span>${nm(l.from)} → ${nm(l.to)}<div class="op">change stations on foot</div></span></div>`
          : `<div class="jp-leg"><span class="tm">${clock(l.dep)}–${clock(l.arr)}</span>
               <span>${nm(l.from)} → ${nm(l.to)}<div class="op">${
                 [fmt(l.arr - l.dep), l.toc ? TOCS[l.toc] || l.toc : null]
                   .filter(Boolean).map(esc).join(" · ")}</div></span></div>`
        ).join("")}</div>
      </div>`).join("");
  box.querySelectorAll(".jp-sum").forEach((b) => b.addEventListener("click", () => {
    const card = b.closest(".jp-j");
    const n = Number(card.dataset.n);
    box.querySelectorAll(".jp-j").forEach((c) => c.classList.remove("open", "sel"));
    card.classList.add("open", "sel");
    b.setAttribute("aria-expanded", "true");
    state.chosen = n;
    drawRoute(state.journeys[n], false);
    syncHash();
  }));
}

async function runPlan(fit = true) {
  if (!state.from || !state.to) return;
  if (!state.from.crs || !state.to.crs) {
    renderMsg("One of those stations has no CRS code, so it is not in the timetable.");
    return;
  }
  if (state.from.crs === state.to.crs) { renderMsg("Pick two different stations."); return; }
  if (!(await jpEnsure())) return;
  const [hh, mm] = ($("#timeInput").value || "09:00").split(":").map(Number);
  renderMsg("Searching…");
  await new Promise((r) => setTimeout(r, 0));
  const started = performance.now();
  const res = Journey.plan(state.from.crs, state.to.crs, hh * 60 + mm, 4);
  /* the "route to its London terminus" highlight is about a different journey
     from the one now drawn on the map, so drop it rather than show both */
  clearHighlight();
  state.chosen = 0;
  renderPlan(res);
  if (res.journeys && res.journeys.length) drawRoute(res.journeys[0], fit);
  else clearRoute();
  syncHash();
  console.info(`journey scan in ${(performance.now() - started).toFixed(0)} ms`);
}

/* --------------------------------------------------------- combo box -- */
/* Every open listbox on the page, so one document-level handler can dismiss the
   one the reader has just tapped away from.
 *
 * This is the fix for the bug that made the panel feel like a trap on a phone:
 * the only way the menu ever closed was `blur` on the input, and tapping the map
 * does not blur an input inside a floating card that Leaflet has told to stop
 * propagating. The menu stayed open over the map with nothing that would shift
 * it. Capture phase, because Leaflet calls stopPropagation on gestures inside
 * its own container and a bubbling listener would never see them. */
const OPEN_MENUS = new Set();
document.addEventListener("pointerdown", (e) => {
  for (const m of OPEN_MENUS) if (!m.root.contains(e.target)) m.close();
}, true);

function makeCombo(key, onPick) {
  const input = $(key === "from" ? "#fromInput" : "#toInput");
  const menu = $(key === "from" ? "#fromMenu" : "#toMenu");
  const clear = document.querySelector(`.ac-x[data-clear="${key}"]`);
  let items = [], active = -1;

  const root = input.closest(".ac") || input.parentElement;
  const self = { root, close: () => close() };
  const close = () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
    OPEN_MENUS.delete(self);
  };
  const paint = () => menu.querySelectorAll("li")
    .forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
  const render = (list) => {
    items = list;
    if (!list.length) return close();
    menu.innerHTML = list.map((s, i) => {
      const t = timesFor(s.id);
      return `<li role="option" data-i="${i}" aria-selected="${i === active}">
        <span>${esc(s.name)}</span><span class="crs">${esc(s.crs || "")}</span>
        <span class="t">${t && t.best ? fmt(t.best.mins) : ""}</span></li>`;
    }).join("");
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    OPEN_MENUS.add(self);
    /* pointerdown, not mousedown: on a touch screen mousedown is synthesised
       late and only if the browser decides the tap was not a scroll, so a third
       of taps on a suggestion did nothing at all. */
    menu.querySelectorAll("li").forEach((li) => li.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      choose(items[Number(li.dataset.i)]);
    }));
  };
  const choose = (s) => { if (!s) return; close(); onPick(s); };

  input.addEventListener("input", () => {
    const v = input.value.trim().toLowerCase();
    clear.hidden = !input.value;
    if (v.length < 2) return close();
    render(SEARCH_INDEX.filter((s) => s.name.toLowerCase().includes(v)
      || (s.crs && s.crs.toLowerCase() === v)).slice(0, 10));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (menu.hidden) return;
      e.preventDefault();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      paint();
      menu.querySelectorAll("li")[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!menu.hidden && items[active]) choose(items[active]);
      else { const s = resolveStation(input.value); if (s) choose(s); }
    } else if (e.key === "Escape") { close(); }
  });
  /* focusout rather than blur-on-a-timer: the 60 ms race it replaced was what
     made a suggestion tap intermittently register as a dismissal instead. A
     suggestion's own pointerdown calls preventDefault, so focus never leaves the
     field and this never fires for the one case it must not. */
  input.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget)) close();
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    close();
    onPick(null);
    input.focus();
  });
}

let SEARCH_INDEX = [];

/* ------------------------------------------------------------- places -- */
/* Station names are the wrong vocabulary for the question people arrive with.
   "Somewhere near Hebden Bridge" is a place; so is Canary Wharf, so is Bootle,
   and none of them are reliably the name of the station you would get off at.
   places.json is towns, villages and suburbs from OSM, each labelled with its
   local authority so the three Newports are told apart. ~1 MB, so it is fetched
   on the first keystroke rather than at boot — a reader who never searches never
   pays for it. */
let PLACES = [];
let placesState = "idle";          // idle | loading | ready | failed
let placeMark = null;

async function placesEnsure() {
  if (placesState === "ready" || placesState === "loading") return placesState === "ready";
  placesState = "loading";
  try {
    const res = await fetch(DATA + "places.json");
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    const ranks = d.ranks || [];
    const areas = d.areas || [];
    PLACES = (d.places || []).map((r) => ({
      name: r[0], lat: r[1], lon: r[2], rank: r[3],
      kind: ranks[r[3]] || "place", area: areas[r[4]] || "",
    }));
    placesState = "ready";
    return true;
  } catch (err) {
    console.warn("place search unavailable:", err.message);
    placesState = "failed";
    return false;
  }
}

/* The stations within ~12 km of a place, nearest first. This is the answer to
   the question a place search is really asking — not "where is Hebden Bridge"
   but "what can I catch from there". */
function stationsNear(lat, lon, limit = 5) {
  const out = [];
  for (const st of Object.values(STATIONS)) {
    if (!st.crs) continue;
    const x = (st.lon - lon) * Math.cos((lat * Math.PI) / 180);
    const y = st.lat - lat;
    const km = Math.sqrt(x * x + y * y) * 111.32;
    if (km > 12) continue;
    out.push({ st, km });
  }
  out.sort((a, b) => a.km - b.km);
  return out.slice(0, limit);
}

function clearPlace() {
  if (placeMark) { map.removeLayer(placeMark); placeMark = null; }
}

/* Jump to a place: mark it, name it, and say what you could catch from it. */
function showPlace(p) {
  clearPlace();
  clearHighlight(false);
  state.selected = null;
  state.line = null;
  state.lineStations = new Set();
  openTip?.closeTooltip();
  openTip = null;
  rail.redraw();
  restyleStations();

  placeMark = L.layerGroup([
    L.circleMarker([p.lat, p.lon], { pane: "stationPane", radius: 7, weight: 2,
                                     color: ROUTE_INK, fillColor: "rgba(0,0,0,0)",
                                     fillOpacity: 0, interactive: false }),
    L.marker([p.lat, p.lon], { pane: "labelPane", interactive: false,
      icon: L.divIcon({ className: "route-label", html: esc(p.name),
                        iconSize: null, iconAnchor: [-10, 8] }) }),
  ]).addTo(map);

  /* Zoom by how big the thing is. A city at z13 is one suburb of itself; a
     hamlet at z10 is a dot in a field. */
  const z = [10, 11, 12, 13, 13][p.rank] || 12;
  map.flyTo([p.lat, p.lon], Math.max(z, Math.min(14, map.getZoom())), { duration: 0.7 });

  const near = stationsNear(p.lat, p.lon);
  const hp = Prices.ready() ? Prices.at(p.lat, p.lon) : null;
  showInfo(true);
  $("#detail").innerHTML = `<div class="st-head"><p class="st-name">${esc(p.name)}</p>
      <button class="icon-btn" id="clearPlace" title="Close">&times;</button></div>
    <p class="st-meta">${[p.area, p.kind].filter(Boolean).map(esc).join(" · ")}</p>
    ${hp ? priceRowHTML(hp) : ""}
    <div class="ins-sec"><h3>Nearest stations</h3>
      ${near.length ? `<div class="st-rows">${near.map(({ st, km }) => {
        const t = timesFor(st.id);
        const c = commuteMinsFor(st);
        const sec = SECTORS.find((x) => x.key === st.sector);
        const mins = state.commute ? c : (t && t.best ? t.best.mins : null);
        return `<button class="st-row st-pick" data-id="${esc(st.id)}">
            <i style="background:${(sec || {}).colour || UNREACHED}"></i>
            <span class="term">${esc(st.name)}</span>
            <span class="km">${km.toFixed(1)} km</span>
            <span class="mins">${fmt(mins)}</span></button>`;
      }).join("")}</div>
      <p class="hint">${state.commute
          ? "Time shown is the commute to " + esc(shortTerm(state.commute.name)) + "."
          : "Time shown is the fastest run into London."}</p>`
        : `<p class="hint">No station within 12 km.</p>`}
    </div>`;
  $("#clearPlace").addEventListener("click", () => { clearPlace(); clearSelection(); });
  $("#detail").querySelectorAll(".st-pick").forEach((b) =>
    b.addEventListener("click", () => { clearPlace(); select(b.dataset.id); }));
  syncHash();
}

/* --------------------------------------------------------- the search -- */
/* One box, two vocabularies, and stations win.
 *
 * The scores are spaced so that *any* station match outranks an equally good
 * place match, and a station that merely begins with what you typed still
 * outranks a place that matches it exactly. That is deliberate and it is the
 * whole reason this box exists: the complaint it answers was that finding a
 * station was hard. Typing "Hebden" has to offer Hebden Bridge station before a
 * Yorkshire Dales hamlet called Hebden, however exact the hamlet's match is.
 *
 * A place only comes first when no station matches at all, which is the case
 * every place search is actually for. Within places the rank breaks ties, so a
 * built-up area beats a locality of the same name. */
const SCORE = {
  stationExact: 0, stationPrefix: 1, stationAnywhere: 3,
  placeExact: 1.5, placePrefix: 2.2, placeAnywhere: 4,
};

function searchHits(q) {
  const v = q.trim().toLowerCase();
  if (v.length < 2) return [];
  const out = [];
  for (const st of SEARCH_INDEX) {
    const n = st.name.toLowerCase();
    const i = n.indexOf(v);
    const byCrs = st.crs && st.crs.toLowerCase() === v;
    if (i < 0 && !byCrs) continue;
    out.push({ kind: "station", st, name: st.name, sub: st.crs || "",
               score: (n === v || byCrs) ? SCORE.stationExact
                    : i === 0 ? SCORE.stationPrefix : SCORE.stationAnywhere });
  }
  for (const p of PLACES) {
    const n = p.name.toLowerCase();
    const i = n.indexOf(v);
    if (i < 0) continue;
    const base = n === v ? SCORE.placeExact
               : i === 0 ? SCORE.placePrefix : SCORE.placeAnywhere;
    out.push({ kind: "place", place: p, name: p.name, sub: p.area,
               score: base + p.rank * 0.2 });
  }
  out.sort((a, b) => a.score - b.score
                  || a.name.length - b.name.length
                  || a.name.localeCompare(b.name));
  return out.slice(0, 12);
}

function makeSearch() {
  const input = $("#q"), menu = $("#qMenu"), clear = $("#qClear");
  const root = input.closest(".srch");
  let items = [], active = -1;
  const self = { root, close: () => close() };

  const close = () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
    OPEN_MENUS.delete(self);
  };
  const paint = () => menu.querySelectorAll("li")
    .forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));

  const render = (list) => {
    items = list;
    if (!list.length) {
      menu.innerHTML = `<li class="ac-empty" role="option" aria-disabled="true"
        aria-selected="false">Nothing matches that${
        placesState === "failed" ? " (place search is unavailable)" : ""}</li>`;
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      OPEN_MENUS.add(self);
      return;
    }
    menu.innerHTML = list.map((h, i) => {
      if (h.kind === "station") {
        const t = timesFor(h.st.id);
        const mins = state.commute ? commuteMinsFor(h.st) : (t && t.best ? t.best.mins : null);
        return `<li role="option" data-i="${i}" aria-selected="${i === active}">
          <span class="ac-ic ac-rail" aria-hidden="true"></span>
          <span>${esc(h.name)}</span><span class="crs">${esc(h.sub)}</span>
          <span class="t">${mins == null ? "" : fmt(mins)}</span></li>`;
      }
      return `<li role="option" data-i="${i}" aria-selected="${i === active}">
        <span class="ac-ic ac-place" aria-hidden="true"></span>
        <span>${esc(h.name)}</span><span class="crs">${esc(h.sub)}</span>
        <span class="t">${esc(h.place.kind)}</span></li>`;
    }).join("");
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    OPEN_MENUS.add(self);
    menu.querySelectorAll("li[data-i]").forEach((li) =>
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        choose(items[Number(li.dataset.i)]);
      }));
  };

  const choose = (h) => {
    if (!h) return;
    close();
    input.value = h.name;
    clear.hidden = false;
    input.blur();                     // on a phone, let the keyboard go away
    if (h.kind === "station") { clearPlace(); select(h.st.id);
      map.flyTo([h.st.lat, h.st.lon], Math.max(map.getZoom(), 12), { duration: 0.7 }); }
    else showPlace(h.place);
  };

  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    const v = input.value;
    clear.hidden = !v;
    if (v.trim().length < 2) return close();
    /* Paint the stations immediately, then repaint once places have arrived.
       Waiting on a 1 MB fetch before showing anything makes the first keystroke
       of the session feel broken. */
    render(searchHits(v));
    if (placesState === "idle" || placesState === "loading") {
      await placesEnsure();
      if (mine === seq && input.value.trim().length >= 2) render(searchHits(input.value));
    }
  };

  input.addEventListener("input", run);
  input.addEventListener("focus", () => { if (input.value.trim().length >= 2) run(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (menu.hidden || !items.length) return;
      e.preventDefault();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      paint();
      menu.querySelectorAll("li")[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active >= 0 ? active : 0]);
    } else if (e.key === "Escape") {
      close();
      input.blur();
    }
  });
  input.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget)) close();
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    close();
    clearPlace();
    input.focus();
  });
}

/* --------------------------------------------------------- the toolbar -- */
/* One panel, one tool in it. Two open at once is two panels' worth of map
   covered up, which on a phone is the whole map. The house price overlay is the
   exception to "the panel is the tool": the overlay is a view state that should
   survive you opening the planner on top of it, so its button carries both
   aria-pressed (the overlay) and aria-expanded (the panel). */
function setTool(name) {
  state.tool = name || null;
  $("#toolPanel").hidden = !state.tool;
  document.querySelectorAll(".tool-body").forEach((sec) => {
    sec.hidden = sec.id !== (state.tool ? state.tool + "Tool" : "");
  });
  document.querySelectorAll(".tool").forEach((b) => {
    const open = b.dataset.tool === state.tool;
    b.classList.toggle("is-open", open);
    b.setAttribute("aria-expanded", String(open));
  });
  syncToolChrome();
}

function syncToolChrome() {
  const b = document.querySelector('.tool[data-tool="prices"]');
  if (b) {
    b.setAttribute("aria-pressed", String(state.prices));
    b.classList.toggle("is-on", state.prices);
  }
}

function openTool(name) { if (state.tool !== name) setTool(name); }

async function toggleTool(name) {
  if (name === "prices") {
    /* Pressing it the first time does both things; pressing it again undoes
       both. Switching to another tool leaves the overlay where it is.
       The close branch keys on the *panel*, not the overlay: if the data failed
       to load the panel is open explaining why and the overlay is off, and a
       second press has to still be the way out of it. */
    if (state.tool === "prices") {
      setTool(null);
      if (state.prices) await setPrices(false);
      return;
    }
    setTool("prices");
    if (!state.prices) await setPrices(true);
    return;
  }
  setTool(state.tool === name ? null : name);
}

/* ------------------------------------------------- house price overlay -- */
const money = (v) => (v >= 1e6 ? `£${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}m`
                               : `£${Math.round(v / 1000)}k`);
const moneyFull = (v) => "£" + Math.round(v).toLocaleString("en-GB");
let priceLayer = null;

const priceOpacity = () => (Number($("#hpOpacity")?.value) || 80) / 100;

async function setPrices(on, quiet = false) {
  if (on) {
    if (!Prices.ready()) {
      $("#hpRead").innerHTML = `<p class="hp-none">Loading house prices…</p>`;
      try {
        await Prices.load(DATA);
      } catch (err) {
        $("#hpRead").innerHTML = `<p class="hp-none">Could not load house prices:
          ${esc(err.message)}. Run <code>make prices</code>.</p>`;
        return;
      }
    }
    if (!priceLayer) priceLayer = new Prices.Layer({ pane: "pricePane", opacity: priceOpacity() });
    if (!map.hasLayer(priceLayer)) priceLayer.addTo(map);
    /* L.Renderer.onAdd calls _update() and only *then* subscribes _updatePaths
       to the "update" event, so the first sizing pass never triggers a draw.
       Every other renderer on this map gets its first paint from some later
       redraw by luck; this one is switched on by a button and would otherwise
       sit there empty until the reader happened to pan. */
    priceLayer.redraw();
    state.prices = true;
    buildPriceKey();
    priceReadout(null);
  } else {
    state.prices = false;
    if (priceLayer && map.hasLayer(priceLayer)) map.removeLayer(priceLayer);
  }
  document.body.classList.toggle("is-prices", state.prices);
  syncToolChrome();
  rail.redraw();
  restyleStations();
  buildLegend();
  if (!quiet) syncHash();
}

function buildPriceKey() {
  if (!Prices.ready()) return;
  const m = Prices.meta, edges = Prices.bandEdges();
  const last = edges.length - 1;
  $("#hpTitle").textContent = "What a house costs here";
  $("#hpRamp").innerHTML = Prices.RAMP.map((c, i) =>
    `<span style="background:${c}" title="${money(edges[i])} to ${money(edges[i + 1])}"></span>`).join("");
  $("#hpRamp").setAttribute("aria-label",
    `Colour scale, ${money(edges[0])} at the dark end to ${money(edges[last])} and above at the bright end`);
  $("#hpLabels").innerHTML = [0, 2, 4, 6, 8]
    .map((i) => `<span>${money(edges[i])}${i === last ? "+" : ""}</span>`).join("");
  const d = (m.kinds || []).find((k) => k.key === "district") || {};
  const c = (m.kinds || []).find((k) => k.key === "council") || {};
  const w = m.window || {};
  $("#hpNote").innerHTML = `Median of residential sales per postcode district,
    ${esc(w.from || "")} to ${esc(w.to || "")} — ${esc(d.source || "")}.
    Scotland is council-wide (${esc(c.source || "")}) because Price Paid is an
    English and Welsh register. Both Open Government Licence v3.
    ${Prices.count.toLocaleString("en-GB")} areas.`;
}

/* The readout, not a floating tooltip: a phone has no hover, and a tooltip you
   cannot summon is a figure nobody can check. This updates on hover on a
   desktop and on a tap anywhere on the map, so the number is reachable either
   way — and it names which of the two sources it came from every time. */
function priceReadout(latlng) {
  const box = $("#hpRead");
  if (!box || !Prices.ready()) return;
  const hit = latlng && Prices.at(latlng.lat, latlng.lng);
  if (!hit) {
    box.innerHTML = `<p class="hp-none">Point at the map — or tap it — for the
      figure where you are pointing.</p>`;
    return;
  }
  box.innerHTML = priceRowHTML(hit);
}

/* One markup for the readout and for the inspector, so the number a reader sees
   beside a station is the same number, labelled the same way, as the one under
   the cursor. */
function priceRowHTML(hit) {
  const median = hit.kind && hit.kind.stat === "median";
  return `<div class="hp-hit">
    <span class="hp-sw" style="background:${Prices.colourAt(hit.price)}"></span>
    <b>${moneyFull(hit.price)}</b>
    <span class="hp-where">${esc(hit.label)}</span>
    <span class="tag ${median ? "exact" : "coarse"}">${median
      ? `median of ${hit.sales.toLocaleString("en-GB")} sales`
      : "council average"}</span></div>`;
}

/* ----------------------------------------------------------- commute -- */
/* The map's original question was "how far is this station from London?", with
   the fourteen terminals as fixed points. The question people actually arrive
   with is the same shape but personal: "how far is this station from *my*
   destination?" — so naming a destination replaces London as the thing every
   station is measured against.
 *
 * One backward sweep of the timetable answers it for all 2,576 stations at
 * once (see Journey.commuteTo), which is why this can run on every keystroke
 * that resolves to a station rather than being a separate page.
 */
const COMMUTE_WINDOW = 240;          // four hours; beyond that it is not a commute

function arriveByMins() {
  const v = ($("#timeInput") && $("#timeInput").value) || "09:00";
  const [h, m] = v.split(":").map(Number);
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 0);
}

async function setCommute(st) {
  if (!st || !st.crs) { clearCommute(); return; }
  if (!(await jpEnsure())) return;
  const arriveBy = arriveByMins();
  const res = Journey.commuteTo(st.crs, arriveBy, COMMUTE_WINDOW);
  if (!res) { clearCommute(); return; }
  state.commute = { crs: st.crs, name: st.name, arriveBy,
                    mins: res.mins, latest: res.latest, index: Journey.data.index };
  /* Shading by commute time is the whole point of naming a destination, so
     switch to it — unless the reader has deliberately gone back to the network
     colouring, in which case leave their choice alone. */
  if (state.mode !== "time" && !state.modeSticky) setMode("time");
  else { rail.redraw(); restyleStations(); buildLegend(); }
  retintTooltips();
  updateChrome();
}

function clearCommute() {
  if (!state.commute) return;
  state.commute = null;
  if (state.mode === "time") { rail.redraw(); restyleStations(); buildLegend(); }
  retintTooltips();
  updateChrome();
}

/* Minutes from this station to the commute destination, or null. */
function commuteMinsFor(st) {
  const c = state.commute;
  if (!c || !st || !st.crs) return null;
  const i = c.index.get(st.crs);
  if (i === undefined) return null;
  const m = c.mins[i];
  return m < 0 ? null : m;
}

/* What the "Journey time" mode is measuring right now: the commute to a named
   destination if there is one, otherwise the London terminus as before. */
function shadeMinsFor(st) {
  if (state.commute) return commuteMinsFor(st);
  const t = timesFor(st.id);
  return t && t.best ? t.best.mins : null;
}

function retintTooltips() {
  for (const [id, m] of markers) {
    const st = STATIONS[id];
    if (st) m.setTooltipContent(tooltipHTML(st));
  }
}

/* The map-wide sweep is an approximation by design — it answers for all 2,576
   stations in one pass, and in about one case in two hundred it is a few
   minutes more generous than the planner can actually deliver. A query costs
   half a millisecond, so anything the reader actually clicks gets the real
   answer and is labelled as such. */
function exactCommute(st) {
  const c = state.commute;
  if (!c || !st || !st.crs || st.crs === c.crs) return null;
  const i = c.index.get(st.crs);
  if (i === undefined || c.mins[i] < 0) return null;
  try {
    const r = Journey.plan(st.crs, c.crs, c.latest[i], 1);
    const j = r.journeys && r.journeys[0];
    if (j && j.arr <= c.arriveBy) {
      return { mins: j.arr - j.dep, dep: j.dep, arr: j.arr,
               changes: j.changes, exact: true };
    }
  } catch { /* fall through to the sweep's figure */ }
  return { mins: c.mins[i], dep: c.latest[i], arr: c.arriveBy,
           changes: null, exact: false };
}

function commutePanel(st) {
  const c = state.commute;
  if (!c || !st.crs) return "";
  if (st.crs === c.crs) {
    return `<p class="hint">This is the destination every station on the map is
      being measured against.</p>`;
  }
  const e = exactCommute(st);
  if (!e) {
    return `<div class="cmt none"><p>No journey to ${esc(shortTerm(c.name))}
      arriving by ${clock(c.arriveBy)}.</p></div>`;
  }
  return `<div class="cmt">
    <div class="cmt-head">Commute to ${esc(shortTerm(c.name))}
      <span class="tag ${e.exact ? "exact" : "est"}">${e.exact ? "timetabled" : "estimated"}</span></div>
    <div class="cmt-hero"><b>${fmt(e.mins)}</b>
      <span>leave ${clock(e.dep)} · arrive ${clock(e.arr)}${
        e.changes == null ? "" : e.changes ? ` · ${e.changes} change${e.changes > 1 ? "s" : ""}` : " · direct"}</span></div>
    <button class="chip" data-set="from">Plan this journey</button>
  </div>`;
}

/* ------------------------------------------------------------ sharing -- */
/* Every view worth sending to someone is addressable: a station, a planned
   journey, a filtered network, a place on the map. It lives in the hash rather
   than the query string so it never reaches CloudFront — the cache key ignores
   query strings, and a shared link should not depend on that staying true.
   replaceState, not pushState: panning the map must not fill the back button
   with map positions. */
let hashLock = false, userMoved = false, lastHash = null;

function watchMapGestures() {
  const el = map.getContainer();
  const mark = () => { userMoved = true; };
  /* Deliberately not map.on("zoomstart"): fitBounds fires it at boot, which is
     exactly the programmatic move this flag exists to ignore. Leaflet's zoom
     control lives inside the container, so pointerdown covers it too. */
  el.addEventListener("pointerdown", mark, { passive: true });
  el.addEventListener("wheel", mark, { passive: true });
  el.addEventListener("keydown", mark, { passive: true });
}

/* The single time field is "arrive by" while you are looking at a commute and
   "leaving" once you have named both ends, because those are the two questions
   the two states actually ask. The label says which, so it is never a guess. */
function syncTimeLabel() {
  const lab = document.querySelector(".tf span");
  if (lab) lab.textContent = state.from && state.to ? "Leaving" : "Arrive by";
}

function setMode(m) {
  state.mode = m === "time" ? "time" : "sector";
  document.querySelectorAll(".mode").forEach((x) => {
    const on = x.dataset.mode === state.mode;
    x.classList.toggle("is-on", on);
    x.setAttribute("aria-checked", String(on));
  });
  rail.redraw(); restyleStations(); buildLegend();
}

function updateChrome() {
  syncTimeLabel();
  const b = document.querySelector('.mode[data-mode="time"]');
  if (b) b.textContent = state.commute ? "Commute time" : "Journey time";
}

function encodeState() {
  const p = new URLSearchParams();
  if (state.from && state.from.crs) p.set("from", state.from.crs);
  if (state.to && state.to.crs) p.set("to", state.to.crs);
  /* The time matters to a destination-only link too — it is the "arrive by"
     that the whole isochrone is computed against, so a shared commute view is
     meaningless without it. */
  if (state.to) {
    const t = $("#timeInput") && $("#timeInput").value;
    if (t) p.set("at", t.replace(":", ""));
    if (state.from && state.chosen) p.set("j", String(state.chosen));
  }
  const sel = state.selected && STATIONS[state.selected];
  if (sel && sel.crs) p.set("st", sel.crs);
  if (state.mode !== "sector") p.set("mode", state.mode);
  /* The overlay is a view, so it is addressable like every other view. The
     strength slider is not: it is a reading comfort, not a claim about the
     data, and a link should not impose one reader's taste on the next. */
  if (state.prices) p.set("hp", "1");
  if (state.terminus) p.set("term", state.terminus);
  if (state.isolated) p.set("sec", state.isolated);
  /* By name, not by index: the line index is assigned when the geometry is
     rebuilt, so an indexed link would quietly point at a different line after
     the next OSM refresh. */
  if (state.line != null && LINES[state.line]) p.set("line", LINES[state.line]);
  /* Pin the viewport only once there is something to pin it to, or the reader
     has actually moved the map. Otherwise the fitBounds at boot would rewrite
     a clean URL with a position nobody chose. */
  if (userMoved || [...p.keys()].length) {
    const c = map.getCenter();
    p.set("map", `${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom()}`);
  }
  return p.toString();
}

function syncHash() {
  if (hashLock) return;
  const q = encodeState();
  history.replaceState(null, "", q ? "#" + q : location.pathname + location.search);
  lastHash = location.hash;
}

/* Restore a shared link. Returns true if it set a map view, so the caller knows
   not to let a fitBounds throw it away. */
async function applyHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return false;
  const p = new URLSearchParams(raw);
  let placed = false;
  hashLock = true;
  try {
    const mv = (p.get("map") || "").split(",").map(Number);
    if (mv.length === 3 && mv.every(Number.isFinite)) {
      map.setView([mv[0], mv[1]], mv[2]);
      placed = true;
    }

    if (p.get("mode") === "time") setMode("time");
    if (p.get("hp") === "1") { setTool("prices"); await setPrices(true, true); }

    const term = p.get("term");
    const sec = p.get("sec");
    if (term && TERMINI[term]) { state.terminus = term; resetFocus(); }
    else if (sec && SECTORS.some((x) => x.key === sec)) { state.isolated = sec; resetFocus(); }

    const ln = p.get("line");
    if (ln) {
      const idx = LINES.indexOf(ln);
      if (idx > 0) { showLine(idx); if (!placed) { fitLine(idx); placed = true; } }
    }

    const at = p.get("at");
    if (at && /^\d{4}$/.test(at) && $("#timeInput")) {
      $("#timeInput").value = at.slice(0, 2) + ":" + at.slice(2);
    }

    const a = BY_CRS.get(String(p.get("from") || "").toUpperCase());
    const b = BY_CRS.get(String(p.get("to") || "").toUpperCase());
    if (a) setEndpoint("from", a, true);
    if (b) setEndpoint("to", b, true);
    if (a && b) {
      const want = Number(p.get("j") || 0);
      await runPlan(!placed);
      if (want > 0 && state.journeys && state.journeys[want]) {
        state.chosen = want;
        renderPlan({ journeys: state.journeys });
        drawRoute(state.journeys[want], false);
      }
      placed = true;
    }

    const stc = String(p.get("st") || "").toUpperCase();
    const st = stc && BY_CRS.get(stc);
    if (st) {
      await select(st.id);
      if (!placed) { map.setView([st.lat, st.lon], Math.max(map.getZoom(), 11)); placed = true; }
    }
  } catch (err) {
    console.warn("could not fully restore the shared link:", err);
  } finally {
    hashLock = false;
    lastHash = location.hash;
  }
  return placed;
}

/* Copy the current view's link. Clipboard access needs a secure context, which
   https and localhost both are; the textarea fallback covers anything else. */
async function copyLink(btn) {
  syncHash();
  const url = location.href;
  let ok = true;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
  }
  if (!btn) return;
  btn.classList.add("is-copied");
  clearTimeout(btn._t);
  /* The inspector's control is an icon. Writing "Copied" into its textContent
     would delete the SVG and never put it back, so it acknowledges by colour
     and tooltip instead; only the text button swaps its label. */
  if (btn.querySelector("svg")) {
    btn.dataset.label = btn.dataset.label || btn.title;
    btn.title = ok ? "Link copied" : "Copy failed \u2014 press \u2318C";
    btn._t = setTimeout(() => {
      btn.title = btn.dataset.label;
      btn.classList.remove("is-copied");
    }, 1500);
    return;
  }
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = ok ? "Copied" : "Press \u2318C";
  btn._t = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove("is-copied");
  }, 1500);
}

/* ---------------------------------------------------------------- UI -- */
function wireUI() {
  SEARCH_INDEX = Object.values(STATIONS).filter((s) => s.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  /* 09:00 rather than the current time: the page now opens on "where can I
     commute to X from", and the arrive-by time that question implies is the
     start of the working day, not whenever the page happened to be loaded. */
  $("#timeInput").value = "09:00";
  syncTimeLabel();

  makeSearch();
  syncToolChrome();          // so the overlay button reports "off", not nothing
  document.querySelectorAll(".tool").forEach((b) =>
    b.addEventListener("click", () => { toggleTool(b.dataset.tool); }));
  $("#hpOpacity").addEventListener("input", () => {
    if (priceLayer) priceLayer.setOpacity(priceOpacity());
  });

  makeCombo("from", (s) => {
    const hadTo = !!state.to;
    setEndpoint("from", s);
    if (!s) { clearSelection(); return; }
    select(s.id);
    /* with a destination already set, runPlan has just fitted the whole route;
       flying to the origin on top of it would undo that */
    if (!hadTo) map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 11), { duration: 0.7 });
  });
  makeCombo("to", (s) => setEndpoint("to", s));

  $("#swapBtn").addEventListener("click", () => {
    const a = state.from, b = state.to;
    setEndpoint("from", b, true);
    setEndpoint("to", a, true);
    if (state.from && state.to) runPlan();
    else { clearRoute(); renderPlan(null); }
  });
  $("#goBtn").addEventListener("click", () => {
    /* resolve from the text in the boxes rather than the last pick: the user
       may have typed over a station they chose earlier */
    const a = resolveStation($("#fromInput").value) || state.from;
    const b = resolveStation($("#toInput").value) || state.to;
    if (!a || !b) {
      renderMsg("Pick a starting station and a destination — a name or a three-letter code.");
      return;
    }
    setEndpoint("from", a, true);
    setEndpoint("to", b, true);
    runPlan();
  });
  $("#timeInput").addEventListener("change", () => {
    if (state.to) setCommute(state.to);
    if (state.from && state.to) runPlan(false);
    syncHash();
  });
  $("#clearBtn").addEventListener("click", () => { clearSelection(); clearJourney(); });
  $("#shareBtn").addEventListener("click", (e) => copyLink(e.currentTarget));
  syncClearBtn();

  /* Panning is a view change like any other, so the link follows it — but
     debounced, or a single drag rewrites the URL sixty times a second. */
  watchMapGestures();
  let moveT = 0;
  map.on("moveend zoomend", () => {
    clearTimeout(moveT);
    moveT = setTimeout(syncHash, 400);
  });
  /* dock */
  $("#legendBtn").addEventListener("click", (e) => {
    const open = $("#dockPanel").hidden;
    $("#dockPanel").hidden = !open;
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  document.querySelectorAll(".mode").forEach((b) =>
    b.addEventListener("click", () => {
      /* An explicit click is a preference: naming a destination later must not
         yank the colouring back out from under it. */
      state.modeSticky = true;
      setMode(b.dataset.mode);
      syncHash();
    }));

  const baseBtn = $("#baseBtn");
  baseBtn.addEventListener("click", () => {
    const next = basemapName === "dark" ? "satellite" : "dark";
    setBasemap(next);
    baseBtn.textContent = next === "dark" ? "Satellite" : "Dark map";
    baseBtn.setAttribute("aria-pressed", String(next === "satellite"));
  });

  /* line filter */
  const sel = $("#lineSel");
  const named = LINES.map((n, i) => [n, i]).filter(([n]) => n)
    .sort((a, b) => a[0].localeCompare(b[0]));
  sel.innerHTML = `<option value="">All lines (${named.length} named)</option>`
    + named.map(([n, i]) => `<option value="${i}">${esc(n)}</option>`).join("");
  sel.addEventListener("change", () => {
    if (!sel.value) {
      state.line = null;
      state.lineStations = new Set();
      rail.redraw(); restyleStations();
    } else {
      showLine(Number(sel.value));
      fitLine(Number(sel.value));
    }
  });

  /* click bare track to name its line */
  map.on("click", (e) => {
    if (Date.now() - lastMarkerClick < 120) return;   // the station handler won
    const i = rail.hitTest(e.latlng, 8);
    const hit = i >= 0 ? NET.line[i] : null;
    if (hit != null && hit !== state.line) { showLine(hit, e.latlng); return; }
    /* Clicking the selected line again deselects it. Clicking bare map is the
       universal "I am done with this" gesture, so it also drops the planned
       journey — without that there was no way to click out of a drawn route at
       all, which is the bug this fixes. */
    const bare = hit == null;
    clearSelection();
    if (bare && hasJourney()) clearJourney();
  });

  /* The price figure under the pointer. mousemove on a desktop; the click below
     covers touch, where there is no pointer to follow.
     mousemove is gated on the panel being open as well as the overlay, because
     Prices.at walks every area and there is no reason to do that sixty times a
     second to update an element nobody can see. A click is rare enough to keep
     the readout current for whenever the panel comes back. */
  map.on("mousemove", (e) => {
    if (state.prices && state.tool === "prices") priceReadout(e.latlng);
  });
  map.on("mouseout", () => { if (state.prices) priceReadout(null); });
  map.on("click", (e) => { if (state.prices) priceReadout(e.latlng); });

  /* table */
  $("#tableBtn").addEventListener("click", () => { buildTable(); $("#tableWrap").hidden = false; });
  $("#tableClose").addEventListener("click", () => { $("#tableWrap").hidden = true; });
  $("#tableWrap").addEventListener("click", (e) => {
    if (e.target.id === "tableWrap") $("#tableWrap").hidden = true;
  });
  $("#stationTable").querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (state.sort === k) state.asc = !state.asc; else { state.sort = k; state.asc = true; }
    buildTable();
  }));

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && e.target === document.body) { e.preventDefault(); $("#q").focus(); }
    if (e.key !== "Escape") return;
    /* One rung at a time, outermost first, so Escape never takes away more than
       the thing you are currently looking at. The journey is the last rung —
       previously it had no rung at all. */
    if (!$("#tableWrap").hidden) { $("#tableWrap").hidden = true; return; }
    if (!$("#dockPanel").hidden) {
      $("#dockPanel").hidden = true;
      $("#legendBtn").setAttribute("aria-expanded", "false");
      return;
    }
    if (state.highlight || state.line != null || !$("#inspector").hidden) {
      clearSelection();
      return;
    }
    if (hasJourney()) { clearJourney(); return; }
    /* Last rung, below the journey: the toolbar panel. It is the outermost thing
       still covering the map once everything inside it is gone. */
    if (state.tool) setTool(null);
  });
}

function fitLine(idx) {
  const { count, line, starts, counts, coords } = NET;
  let mnLa = 1e9, mxLa = -1e9, mnLo = 1e9, mxLo = -1e9, found = false;
  for (let i = 0; i < count; i++) {
    if (line[i] !== idx) continue;
    found = true;
    for (let k = 0; k < counts[i]; k++) {
      const la = coords[(starts[i] + k) * 2] / 1e5, lo = coords[(starts[i] + k) * 2 + 1] / 1e5;
      if (la < mnLa) mnLa = la;
      if (la > mxLa) mxLa = la;
      if (lo < mnLo) mnLo = lo;
      if (lo > mxLo) mxLo = lo;
    }
  }
  if (found) map.fitBounds([[mnLa, mnLo], [mxLa, mxLo]], fitPad());
}

/* ------------------------------------------------------------- table -- */
function buildTable() {
  const rows = Object.values(STATIONS).map((st) => {
    const t = timesFor(st.id), b = t && t.best;
    const tn = b && TERMINI[b.terminus];
    const sec = SECTORS.find((s) => s.key === st.sector);
    return { name: st.name, crs: st.crs || "", sector: sec ? sec.label : "",
             term: tn ? shortTerm(tn.name) : "", mins: b ? b.mins : null,
             km: b ? b.km : null, est: b ? b.est : null, src: b ? b.src : null };
  });
  const k = state.sort, dir = state.asc ? 1 : -1;
  rows.sort((a, x) => {
    const av = a[k], xv = x[k];
    if (av == null) return 1;
    if (xv == null) return -1;
    return (typeof av === "number" ? av - xv : String(av).localeCompare(String(xv))) * dir;
  });
  $("#stationTable tbody").innerHTML = rows.map((r) => `<tr>
    <td>${esc(r.name)}</td><td>${esc(r.crs)}</td><td>${esc(r.sector)}</td><td>${esc(r.term)}</td>
    <td class="num">${r.src === "terminus" ? "terminus" : fmt(r.mins) + (r.est ? " *" : "")}</td>
    <td class="num">${r.km == null ? "—" : r.km}</td></tr>`).join("");
}

boot().catch((err) => {
  $("#loading").innerHTML = `<span style="color:#e66767">✕</span>
    <span>Could not load data: ${esc(err.message)}. Run <code>make data</code> first.</span>`;
  console.error(err);
});
