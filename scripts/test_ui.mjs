#!/usr/bin/env node
/* End-to-end UI checks: boots the real dist/ — real index.html, real Leaflet,
 * real app.js — inside jsdom against the real generated data, then exercises
 * the parts that have no other safety net.
 *
 * Needs jsdom, which is not a dependency of this project:
 *
 *     npm install --no-save jsdom && node scripts/test_ui.mjs
 *
 * Covers the service pattern (first train, last train, departures per hour) and
 * shareable links end to end — built, cleared, restored from the URL, copied.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const DATA = path.join(ROOT, "data", "web");

const vc = new VirtualConsole();
const logs = [];
vc.on("jsdomError", (e) => logs.push("jsdomError: " + e.message));
vc.on("error", (...a) => logs.push("error: " + a.join(" ")));
vc.on("warn", (...a) => logs.push("warn: " + a.join(" ")));

const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;

// --- shims Leaflet/the app need that jsdom lacks -------------------------
/* Mostly a sink, with one exception: the price overlay computes a real field of
   RGBA bytes and hands it to putImageData, so createImageData returns a real
   buffer and putImageData keeps the last one. That is what lets the suite check
   the heatmap's actual colours rather than only that it did not throw. */
window.__lastImage = null;
window.HTMLCanvasElement.prototype.getContext = function () {
  const noop = () => {};
  const real = {
    canvas: this,
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createImageData: (w, h) => ({ width: w, height: h,
                                  data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => { window.__lastImage = img; },
  };
  return new Proxy(real, { get: (t, k) => (k in t ? t[k] : noop) });
};
window.SVGElement.prototype.getTotalLength = function () { return 100; };
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
}));
window.navigator.clipboard = { writeText: async (t) => { window.__copied = t; } };
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);


// Leaflet sizes from the container; jsdom reports 0 and the map refuses to draw.
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 1200 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { get: () => 800 });

// --- serve data/ and vendor tiles from disk ------------------------------
window.fetch = async (url) => {
  const rel = String(url).replace(/^https?:\/\/[^/]+\//, "");
  const file = rel.startsWith("data/")
    ? path.join(DATA, rel.slice(5)) : path.join(DIST, rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  const b = fs.readFileSync(file);
  return {
    ok: true, status: 200,
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    json: async () => JSON.parse(b.toString("utf8")),
    text: async () => b.toString("utf8"),
  };
};

// --- run the three scripts in order --------------------------------------
/* As real <script> elements, not window.eval: app.js opens with "use strict",
   and strict eval code keeps its declarations in its own scope, so nothing it
   defines would be reachable afterwards. Injected scripts land in the global
   lexical environment, which is where the app expects to live.
   The <script src> tags already in index.html never run — jsdom is not given a
   resource loader — so these are the only three that execute. */
/* Read the script list out of index.html rather than hardcoding it, so a new
   module added to the page is exercised here automatically instead of failing
   with a ReferenceError the first time someone runs the suite. */
const SCRIPTS = [...window.document.querySelectorAll("script[src]")].map((e) => e.getAttribute("src"));
if (!SCRIPTS.length) throw new Error("index.html lists no scripts");
for (const f of SCRIPTS) {
  const el = window.document.createElement("script");
  el.textContent = fs.readFileSync(path.join(DIST, f), "utf8");
  window.document.head.appendChild(el);
}

/* Top-level let/const in a classic script are script-scoped, not window
   properties. window.eval shares that lexical scope, so it can reach them. */
const ev = (code) => window.eval(code);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(60); }
  return false;
};

const booted = await until(() => window.document.getElementById("loading").hidden);
console.log(`boot completed: ${booted}`);
if (!booted) { console.log(logs.slice(0, 12).join("\n")); process.exit(1); }

const $ = (s) => window.document.querySelector(s);
let fails = 0;
const check = (n, c) => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}`); };

console.log("\n=== a clean load does not invent a viewport ===");
check("no map= before the reader has touched the map", !window.location.hash.includes("map="));
check("no hash at all on a fresh load", window.location.hash === "");

console.log("\n=== service pattern: frequency, first & last train ===");
ev('select(BY_CRS.get("KEM").id)');
await until(() => $(".svc"));
const bars = window.document.querySelectorAll(".svc-bar");
const kpi = [...window.document.querySelectorAll(".svc-kpi dd")].map((e) => e.textContent.trim());
console.log(`  Kemble — first ${kpi[0]}, last ${kpi[1]}, ${kpi[2]} per day`);
console.log(`  ${$(".svc-cap").textContent.replace(/\s+/g, " ").trim()}`);
check("24 hourly bars rendered", bars.length === 24);
check("first / last / per-day all populated", kpi.length === 3 && kpi.every((v) => v && v !== "—"));
check("strip carries an accessible name", !!$(".svc-strip").getAttribute("aria-label"));
check("exactly one hour emphasised", window.document.querySelectorAll(".svc-bar.is-now").length === 1);
ev('select(BY_CRS.get("PAD").id)');
await until(() => {
  const v = [...window.document.querySelectorAll(".svc-kpi dd")].map((e) => e.textContent.trim());
  return v[2] && v[2] !== kpi[2];
});
const kpi2 = [...window.document.querySelectorAll(".svc-kpi dd")].map((e) => e.textContent.trim());
console.log(`  Paddington — first ${kpi2[0]}, last ${kpi2[1]}, ${kpi2[2]} per day`);
check("pattern is per station", kpi2[2] !== kpi[2]);

console.log("\n=== share link: a station ===");
ev('select(BY_CRS.get("YRK").id)');
await wait(200);
let h = window.location.hash;
console.log(`  ${h}`);
check("station link carries st=YRK", h.includes("st=YRK"));

console.log("\n=== share link: a journey ===");
ev('setEndpoint("from", BY_CRS.get("RDG"), true)');
ev('setEndpoint("to", BY_CRS.get("YRK"), true)');
$("#timeInput").value = "08:30";
await ev("runPlan(false)");
await until(() => window.location.hash.includes("from="));
h = window.location.hash;
console.log(`  ${h}`);
check("journey link carries from, to and at", h.includes("from=RDG") && h.includes("to=YRK") && h.includes("at=0830"));
check("a route was drawn", ev("!!routeLayer"));

console.log("\n=== restoring that link from a cleared state ===");
const shared = h;
ev("clearJourney(); clearSelection();");
await wait(150);
check("cleared: link no longer names a journey", !window.location.hash.includes("from="));
check("cleared: route removed from the map", ev("!routeLayer"));
window.location.hash = shared;
await ev("applyHash()");
await until(() => ev("state.from") && ev("state.to"), 15000);
console.log(`  restored: ${ev("state.from && state.from.name")} → ${ev("state.to && state.to.name")} leaving ${$("#timeInput").value}`);
check("origin restored", ev("state.from && state.from.crs") === "RDG");
check("destination restored", ev("state.to && state.to.crs") === "YRK");
check("departure time restored", $("#timeInput").value === "08:30");
check("journeys recomputed", ev("Array.isArray(state.journeys) && state.journeys.length > 0"));
check("route redrawn", ev("!!routeLayer"));

console.log("\n=== copy to clipboard ===");
await ev("copyLink(document.querySelector('#shareBtn'))");
check("clipboard holds the full URL", String(window.__copied).startsWith("http://localhost/#"));
console.log(`  ${String(window.__copied).slice(0, 100)}`);
check("button acknowledges the copy", $("#shareBtn").textContent.trim() === "Copied");

console.log("\n=== the inspector's icon control keeps its icon ===");
ev('select(BY_CRS.get("EUS").id)');
await wait(200);
await ev("copyLink(document.querySelector('#shareSel'))");
check("SVG icon survives the copy", !!$("#shareSel svg"));
check("icon acknowledges via its title", /copied/i.test($("#shareSel").getAttribute("title") || ""));

console.log("\n=== filters round-trip through the link ===");
ev("clearJourney(); clearSelection();");
ev('state.terminus = "WAT"; resetFocus();');
await wait(150);
console.log(`  ${window.location.hash}`);
check("terminus filter appears in the link", window.location.hash.includes("term=WAT"));
ev("state.terminus = null; resetFocus();");
await wait(150);
check("clearing the filter drops it", !window.location.hash.includes("term=WAT"));

console.log("\n=== origin-destination frequency, not station frequency ===");
ev("clearJourney(); clearSelection();");
ev('setEndpoint("to", BY_CRS.get("PAD"), true)');
await until(() => ev("!!state.commute"), 20000);
ev('setEndpoint("from", BY_CRS.get("KEM"), true)');
$("#timeInput").value = "09:00";
await ev("runPlan(false)");
await until(() => $(".svc-route"));
const odCap = $(".svc-route .svc-cap").textContent.replace(/\s+/g, " ").trim();
const odKpi = [...window.document.querySelectorAll(".svc-route .svc-kpi dd")].map((e) => e.textContent.trim());
console.log(`  Kemble → Paddington: first ${odKpi[0]}, last ${odKpi[1]}, ${odKpi[2]} direct`);
console.log(`  ${odCap}`);
const direct = Number(odKpi[2]);
check("counts direct trains on the route, not departures at the station",
      direct > 0 && direct < 100);
check("route strip has its own accessible name",
      /Direct trains per hour/.test($(".svc-route .svc-strip").getAttribute("aria-label") || ""));

console.log("\n=== the drawn route follows the rails ===");
const railPts = ev(`(() => {
  let n = 0;
  routeLayer.eachLayer((l) => { if (l.getLatLngs) n = Math.max(n, l.getLatLngs().length); });
  return n;
})()`);
const callingPts = ev("Journey.stopsOfLeg(state.journeys[state.chosen].legs[0]).length");
console.log(`  longest drawn polyline ${railPts} points vs ${callingPts} calling points`);
check("track geometry loaded", ev("Track.ready()"));
check("the line has far more points than calling points", railPts > callingPts * 3);

console.log("\n=== commute mode: one destination shades the whole country ===");
ev("clearJourney(); clearSelection();");
ev('setEndpoint("to", BY_CRS.get("PAD"), true)');
await until(() => ev("!!state.commute"), 20000);
const reach = ev("[...state.commute.mins].filter((m) => m >= 0).length");
console.log(`  ${reach} stations can reach Paddington by ${ev("clock(state.commute.arriveBy)")}`);
check("a destination alone builds the isochrone", reach > 500);
check("the map switches to time shading", ev('state.mode === "time"'));
check("the legend names the destination", /Commute to Paddington/.test($("#legend").textContent));
check("the mode control is relabelled",
      /Commute time/.test($('.mode[data-mode="time"]').textContent));
check("the time field asks for an arrival", /Arrive by/.test($(".tf span").textContent));

console.log("\n=== the commute figure a reader clicks is the exact one ===");
ev('select(BY_CRS.get("RDG").id)');
await until(() => $(".cmt"));
const cmt = $(".cmt-hero").textContent.replace(/\s+/g, " ").trim();
console.log(`  Reading: ${cmt}`);
check("the inspector shows a commute panel", !!$(".cmt-hero b"));
check("it is labelled with its provenance", !!$(".cmt-head .tag"));
const sweep = ev('(() => { const i = state.commute.index.get("RDG"); return state.commute.mins[i]; })()');
const shown = ev('(() => { const e = exactCommute(BY_CRS.get("RDG")); return e && e.mins; })()');
console.log(`  sweep says ${sweep} min, planner says ${shown} min`);
check("the planner confirms the sweep for Reading", ev('(() => { const e = exactCommute(BY_CRS.get("RDG")); return !!(e && e.exact); })()'));

console.log("\n=== a commute view survives being shared ===");
const cmtLink = window.location.hash;
console.log(`  ${cmtLink}`);
check("the link names the destination and the arrive-by time",
      cmtLink.includes("to=PAD") && cmtLink.includes("at=0900"));
ev("clearJourney(); clearSelection();");
await wait(200);
check("cleared before restoring", ev("state.commute === null"));
window.location.hash = cmtLink;
await ev("applyHash()");
await until(() => ev("!!state.commute"), 20000);
check("destination restored from the link", ev("state.commute && state.commute.crs") === "PAD");
check("arrive-by restored", $("#timeInput").value === "09:00");
check("isochrone rebuilt", ev("[...state.commute.mins].filter((m) => m >= 0).length") > 500);
await wait(400);        // let any queued hashchange settle before the next block

console.log("\n=== clearing the destination hands the map back to London ===");
console.log(`  before: to=${ev("state.to && state.to.crs")} commute=${ev("state.commute && state.commute.crs")}`);
ev('setEndpoint("to", null, true)');
await wait(300);
console.log(`  after:  to=${ev("state.to && state.to.crs")} commute=${ev("state.commute && state.commute.crs")} mode=${ev("state.mode")}`);
check("commute cleared", ev("state.commute === null"));
check("legend reverts to London", /time into London/i.test($("#legend").textContent));

console.log("\n=== the search box: one field, stations and places ===");
ev("clearJourney(); clearSelection(); setTool(null);");
const q = $("#q"), qMenu = $("#qMenu");
const type = async (text) => {
  q.value = text;
  q.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(150);
};
await type("york");
let opts = [...qMenu.querySelectorAll("li[data-i]")];
console.log(`  "york" → ${opts.slice(0, 4).map((o) => o.textContent.replace(/\s+/g, " ").trim()).join(" | ")}`);
check("the menu opens on a query", !qMenu.hidden && opts.length > 0);
check("York is offered", opts.some((o) => /^\s*York/.test(o.textContent)));
await type("KEM");
opts = [...qMenu.querySelectorAll("li[data-i]")];
check("a three-letter CRS resolves", opts.length > 0 && /Kemble/.test(opts[0].textContent));

console.log("\n=== the dismissal bug: tapping the map closes the menu ===");
check("menu is open before the tap", !qMenu.hidden);
/* The exact gesture that used to be a dead end on a phone: a pointerdown on the
   map while the suggestion list is open. blur never fired, so the list sat over
   the map with nothing that would shift it. */
$("#map").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
await wait(80);
check("pointerdown outside the combo dismisses it", qMenu.hidden);

console.log("\n=== picking a station from the search jumps to it ===");
await type("Kemble");
opts = [...qMenu.querySelectorAll("li[data-i]")];
opts[0].dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
await until(() => ev('state.selected && STATIONS[state.selected].crs === "KEM"'), 8000);
check("the station is selected", ev("state.selected && STATIONS[state.selected].crs") === "KEM");
check("the inspector names it", /Kemble/.test($("#detail").textContent));
check("the search keeps what was chosen", /Kemble/.test(q.value));

console.log("\n=== places: searching a town that is not a station name ===");
if (!fs.existsSync(path.join(DATA, "places.json"))) {
  console.log("  SKIP — no places.json here (run `make places`)");
} else {
  await type("Hebden");
  await until(() => ev('placesState === "ready"'), 15000);
  await type("Hebden");
  opts = [...qMenu.querySelectorAll("li[data-i]")];
  console.log(`  "Hebden" → ${opts.slice(0, 3).map((o) => o.textContent.replace(/\s+/g, " ").trim()).join(" | ")}`);
  check("place search returns something", opts.length > 0);
  /* Rows are told apart by their own marker, not by their text: "Hebden Bridge"
     is both a station and a place, and matching on the name picks whichever came
     first. The point of the next two checks is that both are offered and the
     station is the one on top. */
  check("the station ranks above a place that matches more exactly",
        !!opts[0].querySelector(".ac-rail") && /Hebden Bridge/.test(opts[0].textContent));
  const place = opts.find((o) => o.querySelector(".ac-place")
                               && /Hebden Bridge/.test(o.textContent));
  check("the place of the same name is offered too", !!place);
  place.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  await until(() => ev("!!placeMark"), 8000);
  check("the place is marked on the map", ev("!!placeMark"));
  const picks = [...window.document.querySelectorAll(".st-pick")];
  console.log(`  nearest: ${picks.slice(0, 3).map((b) => b.textContent.replace(/\s+/g, " ").trim()).join(" | ")}`);
  check("it lists the stations you could catch from there", picks.length > 0);
  if (picks.length) {
    picks[0].click();
    await until(() => ev("!!state.selected"), 8000);
    check("clicking one selects it and drops the place marker",
          ev("!!state.selected") && ev("!placeMark"));
  }
  /* The empty branch is reachable and has to say so rather than render a heading
     over nothing: Hebden in Craven is a Dales hamlet miles from any line. */
  await type("Hebden");
  const remote = [...qMenu.querySelectorAll("li[data-i]")]
    .find((o) => o.querySelector(".ac-place") && /Craven/.test(o.textContent));
  if (remote) {
    remote.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
    await until(() => /No station within/.test($("#detail").textContent), 8000);
    check("a place with no nearby station says so",
          /No station within/.test($("#detail").textContent));
  }
  /* Every place carries its local authority precisely so the duplicates are
     distinguishable; if they are not, the search is guessing for the reader. */
  const newports = ev('PLACES.filter((p) => p.name === "Newport").map((p) => p.area)');
  console.log(`  Newport appears in: ${newports.slice(0, 5).join(", ")}`);
  check("duplicate place names are told apart by their local authority",
        newports.length > 1 && new Set(newports).size === newports.length);
}

console.log("\n=== the toolbar: one panel at a time, and Escape closes it ===");
ev("clearJourney(); clearSelection();");
const planBtn = $('.tool[data-tool="plan"]');
const hpBtn = $('.tool[data-tool="prices"]');
planBtn.click();
await wait(100);
check("the plan panel opens", !$("#toolPanel").hidden && !$("#planTool").hidden);
check("the button says it is expanded", planBtn.getAttribute("aria-expanded") === "true");
planBtn.click();
await wait(100);
check("pressing it again closes the panel", $("#toolPanel").hidden);
planBtn.click();
await wait(100);
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(100);
check("Escape closes the panel as the last rung", $("#toolPanel").hidden);

console.log("\n=== the house price overlay ===");
if (!fs.existsSync(path.join(DATA, "prices.json"))) {
  console.log("  SKIP — no prices.json here (run `make prices`)");
} else {
  ev("map.setView([51.5, -0.12], 9);");
  hpBtn.click();
  await until(() => ev("state.prices && Prices.ready()"), 20000);
  check("the button turns the overlay on", ev("state.prices"));
  check("and opens its panel", !$("#pricesTool").hidden);
  check("the button reports both states", hpBtn.getAttribute("aria-pressed") === "true"
        && hpBtn.getAttribute("aria-expanded") === "true");
  check("the colour scale is drawn", window.document.querySelectorAll("#hpRamp span").length === 8);
  check("the scale is labelled with money", /£/.test($("#hpLabels").textContent));
  check("the scale carries an accessible name", /£/.test($("#hpRamp").getAttribute("aria-label") || ""));
  console.log(`  scale: ${$("#hpLabels").textContent.replace(/\s+/g, " ").trim()}`);
  console.log(`  ${$("#hpNote").textContent.replace(/\s+/g, " ").trim().slice(0, 170)}`);

  /* Provenance, which this repo treats as non-negotiable: a figure from the
     English and Welsh sales register and one from a Scottish council-wide
     average are different claims and must not be labelled the same way. */
  const ew = ev("Prices.at(51.4636, -0.1655)");      // Battersea, SW11
  const sc = ev("Prices.at(55.8642, -4.2518)");      // Glasgow
  console.log(`  SW11    → ${ew && ew.label} £${ew && ew.price} (${ew && ew.kind.stat})`);
  console.log(`  Glasgow → ${sc && sc.label} £${sc && sc.price} (${sc && sc.kind.stat})`);
  check("England and Wales report a median of real sales",
        !!ew && ew.kind.stat === "median" && ew.sales > 0);
  check("Scotland reports an area average and says so",
        !!sc && sc.kind.stat === "mean" && sc.kind.key === "council");
  ev("priceReadout({ lat: 51.4636, lng: -0.1655 })");
  check("the readout names the area", /SW11/.test($("#hpRead").textContent));
  check("the readout labels its provenance", !!$("#hpRead .tag"));
  ev("priceReadout({ lat: 55.8642, lng: -4.2518 })");
  check("a Scottish figure is not labelled as a sales median",
        !!$("#hpRead .tag.coarse") && !$("#hpRead .tag.exact"));

  console.log("\n=== the field paints, and in the order the key claims ===");
  check("a field was rendered to pixels", !!window.__lastImage);
  const im = window.__lastImage;
  if (im) {
    let painted = 0, alpha = 0;
    for (let i = 3; i < im.data.length; i += 4) {
      if (im.data[i] > 0) { painted++; alpha += im.data[i]; }
    }
    const mean = alpha / Math.max(1, painted);
    console.log(`  ${painted} of ${im.width * im.height} field cells carry a value, `
      + `mean alpha ${Math.round(mean)}/255`);
    check("most of the view is covered over London",
          painted > im.width * im.height * 0.5);
    /* The regression this guards is a washed-out overlay, which looks like a
       styling choice rather than a bug. Opacity is the *deepest* any one area
       reaches a cell; computing it from the inverse-distance weight sum instead
       put most of the country at 40% because midway between two centroids both
       weights are a quarter. At the slider's default 80% anything much under
       half of 255 means that has come back. */
    check("the field is opaque where the data is good, not washed out", mean > 128);
  }
  /* The ramp must run the way the legend says it runs. Dearer has to come out
     brighter, or the key is describing a different map. */
  const dear = ev("Prices.colourAt(900000)"), cheap = ev("Prices.colourAt(120000)");
  const lum = (c) => c.match(/\d+/g).map(Number).reduce((a, v) => a + v, 0);
  console.log(`  £120k → ${cheap}   £900k → ${dear}`);
  check("expensive reads brighter than cheap", lum(dear) > lum(cheap));
  check("the scale saturates rather than wrapping round",
        ev("Prices.scale(50000)") === 0 && ev("Prices.scale(9000000)") === 1);

  console.log("\n=== the overlay survives being shared ===");
  await wait(300);
  check("the link records the overlay", window.location.hash.includes("hp=1"));
  const hpLink = window.location.hash;
  await ev("setPrices(false)");
  await wait(200);
  check("turning it off drops it from the link", !window.location.hash.includes("hp=1"));
  window.location.hash = hpLink;
  await ev("applyHash()");
  await until(() => ev("state.prices"), 15000);
  check("restored from the link", ev("state.prices") && !$("#pricesTool").hidden);

  console.log("\n=== a station carries its local price beside its commute ===");
  ev('select(BY_CRS.get("RDG").id)');
  await until(() => $("#detail .hp-hit"), 8000);
  console.log(`  Reading: ${$("#detail .hp-hit").textContent.replace(/\s+/g, " ").trim()}`);
  check("the inspector shows the local figure", !!$("#detail .hp-hit b"));
  check("labelled with its provenance", !!$("#detail .hp-hit .tag"));
  await ev("setPrices(false)");
  await wait(150);
}

const noisy = logs.filter((l) => !/Could not parse CSS|Not implemented|stylesheet/i.test(l));
console.log(`\n=== unexpected console output: ${noisy.length} ===`);
noisy.slice(0, 6).forEach((l) => console.log("  " + l.slice(0, 150)));
console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
