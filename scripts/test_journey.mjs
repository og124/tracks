#!/usr/bin/env node
/* Invariants for the in-browser journey planner.
 *
 * Runs the real web/journey.js against the real data/web/timetable.bin with a
 * fetch shim — no browser, no dependencies. Guards the two mistakes that are
 * silent rather than loud, because both shipped once:
 *
 *   - a change shorter than the operator's published minimum interchange time,
 *     which is an itinerary nobody can travel;
 *   - a reconstruction whose legs do not join end to end, or run backwards;
 *   - the commute sweep and the forward planner drifting apart, which is how
 *     the walk-propagation fault that was losing real routes was found.
 *
 *     node scripts/test_journey.mjs [--plans=600]
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, "data", "web") + path.sep;

const n = Number((process.argv.find((a) => a.startsWith("--plans=")) || "").split("=")[1]) || 600;

if (!fs.existsSync(path.join(DATA, "timetable.bin"))) {
  console.error("data/web/timetable.bin not found — run `make planner` first");
  process.exit(2);
}

globalThis.fetch = async (url) => {
  const f = path.join(DATA, String(url).replace(/^.*\//, ""));
  const b = fs.readFileSync(f);
  return {
    ok: true, status: 200,
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    json: async () => JSON.parse(b.toString("utf8")),
  };
};

const ctx = { console, fetch: globalThis.fetch, performance };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, "web", "journey.js"), "utf8") + "\n;globalThis.__J = Journey;",
  ctx);
const J = ctx.__J;
const TT = await J.load(DATA);
const nameOf = (i) => TT.names[TT.stops[i]] || TT.stops[i];

console.log(`${TT.nStops} stops · ${TT.nConn} connections · ${TT.nWalk} walks · ${TT.nTrips} trips`);

const fail = [];
const bad = (msg) => { if (fail.length < 12) console.log("  " + msg); fail.push(msg); };
/* Worth printing, not worth failing — a property of the feed rather than of
   this code. Kept visible so a drift upwards is noticed before it is a problem. */
const note = (msg) => console.log("  note: " + msg);

/* --- the walking index is only addressable if the edges are sorted ------- */
for (let i = 1; i < TT.nWalk; i++) {
  if (TT.walk[i * 3] < TT.walk[(i - 1) * 3]) {
    bad(`walking transfers are not sorted by origin at ${i} — the CSR index reads the wrong slice`);
    break;
  }
}

/* --- the operator code decode is not systematically broken --------------- */
/* Not "every trip has an operator". build_timetable.py deliberately writes two
   spaces when a schedule carries no TOC in the feed, and the UI omits the
   operator name for those legs rather than inventing one — so a handful of
   blank codes is the pipeline working, not failing. A zero tolerance here meant
   one malformed schedule out of 25,350 failed an unrelated pull request.
 *
 * What this is actually guarding is a decode that has come unstuck — a wrong
 * offset, the wrong endianness, an off-by-one against the trip count — and all
 * of those lose most or all of the codes at once, not one. 1% separates the two
 * cases by two orders of magnitude, which is the kind of margin a threshold
 * wants. */
const TOC_TOL = 0.01;
let noToc = 0;
for (let t = 0; t < TT.nTrips; t++) if (!J.tocOf(t)) noToc++;
const tocMiss = TT.nTrips ? noToc / TT.nTrips : 0;
if (tocMiss > TOC_TOL) {
  bad(`${noToc}/${TT.nTrips} trips (${(100 * tocMiss).toFixed(1)}%) have no `
    + `decodable operator code — above ${100 * TOC_TOL}%, so this is the decode, `
    + `not the feed`);
} else if (noToc) {
  note(`${noToc}/${TT.nTrips} trips carry no operator code in the feed; `
     + `their legs are shown without an operator`);
}

/* --- random journeys, checked against every invariant ------------------- */
let rng = 12345;
const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let plans = 0, journeys = 0, changes = 0, none = 0;
const times = [];

for (let k = 0; k < n; k++) {
  const a = Math.floor(rnd() * TT.nStops), b = Math.floor(rnd() * TT.nStops);
  if (a === b) continue;
  const t0 = Math.floor(rnd() * 16 + 5) * 60;
  const s = performance.now();
  const r = J.plan(TT.stops[a], TT.stops[b], t0, 3);
  times.push(performance.now() - s);
  plans++;
  if (r.error || !r.journeys || !r.journeys.length) { none++; continue; }

  for (const j of r.journeys) {
    journeys++;
    if (j.legs[0].from !== a) bad(`journey does not start at its origin (${nameOf(a)})`);
    if (j.legs[j.legs.length - 1].to !== b) bad(`journey does not end at its target (${nameOf(b)})`);
    if (j.arr < j.dep) bad(`journey arrives before it departs`);
    for (let i = 0; i < j.legs.length; i++) {
      const l = j.legs[i];
      if (l.arr < l.dep) bad(`leg arrives before it departs at ${nameOf(l.from)}`);
      if (i === 0) continue;
      const p = j.legs[i - 1];
      if (p.to !== l.from) bad(`legs do not join: ${nameOf(p.to)} then ${nameOf(l.from)}`);
      if (l.dep < p.arr) bad(`leg departs before the previous one arrives at ${nameOf(l.from)}`);
      if (p.walk || l.walk) continue;             // a walk carries its own duration
      const need = TT.chg[l.from] || 5;
      changes++;
      if (l.dep - p.arr < need) {
        bad(`change at ${nameOf(l.from)} allows ${l.dep - p.arr} min, minimum is ${need}`);
      }
    }
  }
}

/* --- the two engines must agree ---------------------------------------- */
/* The commute shading is a backward sweep; the itinerary is the forward
   planner. They answer the same question from opposite ends, so a divergence
   is a bug in one of them — which is exactly how the walk-propagation fault
   that was losing real routes came to light. The sweep is allowed to be
   slightly generous (it considers arrival modes the single-criterion forward
   scan discards) but never by much, and never about a journey that does not
   exist at all. */
const ARRIVE = 9 * 60, TOL = 15;
let pairs = 0, agree = 0, unreachable = 0;
const overBy = [];
for (const dest of ["PAD", "WAT", "LST", "KGX", "BHM", "MAN"]) {
  if (TT.index.get(dest) === undefined) continue;
  const r = J.commuteTo(dest, ARRIVE, 240);
  if (!r) { bad(`commuteTo(${dest}) returned nothing`); continue; }
  const cands = [];
  for (let i = 0; i < TT.nStops; i++) if (r.mins[i] > 0) cands.push(i);
  for (let k = 0; k < 80 && cands.length; k++) {
    const i = cands[Math.floor(rnd() * cands.length)];
    const f = J.plan(TT.stops[i], dest, r.latest[i], 1);
    pairs++;
    const j = f.journeys && f.journeys[0];
    if (!j) { unreachable++; continue; }
    if (j.arr <= ARRIVE) agree++;
    else overBy.push(j.arr - ARRIVE);
  }
}
if (unreachable) {
  bad(`the commute sweep offered ${unreachable} journeys the planner cannot find at all`);
}
const worst = overBy.length ? Math.max(...overBy) : 0;
if (worst > TOL) {
  bad(`the commute sweep is ${worst} min optimistic somewhere (tolerance ${TOL})`);
}
console.log(`commute sweep vs planner: ${pairs} pairs · ${agree} exact `
          + `(${(100 * agree / pairs).toFixed(1)}%) · ${overBy.length} generous, worst ${worst} min`);

times.sort((x, y) => x - y);
console.log(`${plans} plans (${none} with no journey) · ${journeys} journeys · ${changes} changes`);
console.log(`latency median ${times[times.length >> 1].toFixed(1)} ms · `
          + `p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)} ms · `
          + `max ${times[times.length - 1].toFixed(1)} ms`);

if (fail.length) {
  console.error(`\n${fail.length} invariant violation(s)`);
  process.exit(1);
}
console.log("journey planner invariants OK");
