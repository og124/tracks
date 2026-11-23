/* Any-station-to-any-station journey planning, in the browser.
 *
 * Connection Scan (Dijkstra et al. 2013) over the whole GB timetable. The data
 * is a list of connections — one train's hop between consecutive calling points
 * — sorted by departure time, so a query is a single forward sweep with an
 * early exit once nothing can still improve on the arrival already found. No
 * server, no precomputed matrix: all-pairs would be 2,599² entries and stale
 * the moment the timetable changed.
 */
"use strict";

const Journey = (() => {
  /* Only a fallback now. The real minimum interchange time is per station and
     comes from the feed's station master file — 15 minutes at Euston and
     Paddington, 12 at Birmingham New Street, against a median of 5. Using one
     number everywhere handed out changes that cannot physically be made. */
  const MIN_CHANGE = 5;
  const INF = 0x7fffffff;

  let TT = null, loading = null;

  async function load(base) {
    if (TT) return TT;
    if (loading) return loading;
    loading = (async () => {
      const [buf, meta] = await Promise.all([
        fetch(base + "timetable.bin").then((r) => {
          if (!r.ok) throw new Error("timetable.bin: " + r.status);
          return r.arrayBuffer();
        }),
        fetch(base + "tt_stops.json").then((r) => r.json()),
      ]);
      const dv = new DataView(buf);
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
      if (magic !== "TTB2") throw new Error("timetable.bin is an old format — rerun make timetable");

      const nStops = dv.getUint32(4, true);
      const nConn = dv.getUint32(8, true);
      const nWalk = dv.getUint32(12, true);
      const offConn = dv.getUint32(16, true);
      const offWalk = dv.getUint32(20, true);
      const offToc = dv.getUint32(24, true);
      const offChg = dv.getUint32(28, true);
      const total = dv.getUint32(32, true);

      /* One interleaved Uint16 view rather than five arrays: the scan touches
         all five fields of a connection together, so they should share a cache
         line. Stride is 5 uint16s. */
      const conn = new Uint16Array(buf, offConn, nConn * 5);
      const walk = new Uint16Array(buf, offWalk, nWalk * 3);
      /* One uint16 per trip, holding the two ATOC letters. Older builds left
         this section as zeros, so an all-zero code just means "unknown" and the
         UI drops the operator line rather than printing control characters. */
      const nTrips = Math.max(0, Math.floor((offChg - offToc) / 2));
      const toc = nTrips ? new Uint16Array(buf, offToc, nTrips) : new Uint16Array(0);
      /* One byte per stop: the operator's own minimum interchange time. */
      const chg = new Uint8Array(buf, offChg, nStops);

      /* CSR index over the walking transfers: walkFrom[s] .. walkFrom[s+1] is
         the slice of `walk` leaving stop s. build_timetable.py sorts the edges
         by origin so the prefix sum addresses them directly. The scan used to
         sweep all `nWalk` edges every time any arrival improved, which is the
         same answer several hundred times more slowly. */
      const walkFrom = new Int32Array(nStops + 1);
      for (let i = 0; i < nWalk; i++) walkFrom[walk[i * 3] + 1]++;
      for (let i = 0; i < nStops; i++) walkFrom[i + 1] += walkFrom[i];
      for (let i = 1; i < nWalk; i++) {
        if (walk[i * 3] < walk[(i - 1) * 3]) {
          console.warn("walking transfers are not sorted by origin — rerun make planner");
          break;
        }
      }

      const index = new Map();
      meta.stops.forEach((crs, i) => index.set(crs, i));

      TT = { nStops, nConn, nWalk, nTrips, conn, walk, walkFrom, toc, chg,
             stops: meta.stops, names: meta.names, day: meta.day, date: meta.date, index };
      return TT;
    })();
    return loading;
  }

  /* Earliest arrival at `target` leaving `origin` no earlier than t0. */
  function scan(origin, target, t0) {
    const { nStops, nConn, conn, walk, walkFrom, chg } = TT;

    /* Two arrival clocks per station, not one.
     *
     * A station can be reached by train or on foot, and the two are not
     * interchangeable: boarding after a train arrival costs that station's
     * published interchange time, boarding after a walk costs nothing, because
     * the walk already covered getting between platforms. Keeping only the
     * earlier of the two — which is what a single `best[]` does — throws away
     * the other option along with its boarding rule, and that loses real
     * journeys in both directions:
     *
     *   Euston is a 15-minute interchange. Arrive there by train at 07:30 and
     *   the 07:38 to Birmingham is out of reach. Walk in from St Pancras,
     *   arriving 07:38, and you make it. A single clock keeps 07:30 because it
     *   is earlier, and then refuses the train — so Acton Central to Birmingham
     *   came out 27 minutes worse than it really is.
     *
     *   The mirror of it: reaching Waterloo East on foot from Blackfriars at
     *   08:40 both blocked the onward walk (walks may not chain) and made the
     *   08:48 train arrival look like no improvement, so the seven-minute walk
     *   to Waterloo was never offered at all.
     *
     * So: arrT is arrival by train, arrW is arrival on foot, and a walk may
     * only be taken out of a train arrival — which is what stops walks chaining
     * across a city.
     */
    const arrT = new Int32Array(nStops).fill(INF);
    const arrW = new Int32Array(nStops).fill(INF);
    const viaConn = new Int32Array(nStops).fill(-1);   // connection achieving arrT
    const walkSrc = new Int32Array(nStops).fill(-1);   // station walked from for arrW
    /* Where each trip was boarded, as connection index + 1 (0 = not boarded),
       and whether that boarding was made on foot. Once aboard, CSA stops
       charging a change at later calling points — correctly, you are not
       changing — so the reconstruction has to be told where you actually got
       on, or it splits the leg somewhere no change was ever validated. */
    const boardAt = new Int32Array(65536);
    const boardWalk = new Uint8Array(65536);

    arrT[origin] = t0;                 // standing at the origin counts as arrived
    for (let w = walkFrom[origin]; w < walkFrom[origin + 1]; w++) {
      const to = walk[w * 3 + 1], t = t0 + walk[w * 3 + 2];
      if (t < arrW[to]) { arrW[to] = t; walkSrc[to] = origin; }
    }

    // first connection that leaves at or after t0
    let lo = 0, hi = nConn;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (conn[mid * 5] < t0) lo = mid + 1; else hi = mid;
    }

    for (let i = lo; i < nConn; i++) {
      const dep = conn[i * 5];
      const bestTarget = arrT[target] < arrW[target] ? arrT[target] : arrW[target];
      if (dep > bestTarget) break;             // nothing later can improve it
      const trip = conn[i * 5 + 4];
      const from = conn[i * 5 + 2];
      if (!boardAt[trip]) {
        /* Ready by train, allowing for the change; or ready on foot, which
           needs no allowance. Prefer the train when both work — it is the
           earlier arrival and keeps the itinerary simpler. */
        const tReady = from === origin ? t0
                     : arrT[from] === INF ? INF
                     : arrT[from] + (chg[from] || MIN_CHANGE);
        let usedWalk = false;
        if (tReady > dep) {
          if (arrW[from] > dep) continue;
          usedWalk = true;
        }
        boardAt[trip] = i + 1;
        boardWalk[trip] = usedWalk ? 1 : 0;
      }
      const to = conn[i * 5 + 3], arr = conn[i * 5 + 1];
      if (arr < arrT[to]) {
        arrT[to] = arr;
        viaConn[to] = i;
        for (let w = walkFrom[to]; w < walkFrom[to + 1]; w++) {
          const wt = walk[w * 3 + 1], t = arr + walk[w * 3 + 2];
          if (t < arrW[wt]) { arrW[wt] = t; walkSrc[wt] = to; }
        }
      }
    }
    const best = arrT[target] < arrW[target] ? arrT[target] : arrW[target];
    return best === INF
      ? null : { arrT, arrW, viaConn, walkSrc, boardAt, boardWalk, best };
  }

  function rebuild(origin, target, r) {
    const { conn } = TT;
    const { arrT, arrW, viaConn, walkSrc, boardAt, boardWalk } = r;
    const legs = [];
    let at = target;
    /* How we arrived where we currently stand, walking the itinerary backwards. */
    let onFoot = arrW[at] < arrT[at];
    let guard = 0;
    while (at !== origin && guard++ < 400) {
      if (onFoot) {
        const src = walkSrc[at];
        if (src < 0) return null;
        legs.push({ walk: true, from: src, to: at, dep: arrT[src], arr: arrW[at] });
        at = src;
        onFoot = false;                // a walk is only ever taken off a train
        continue;
      }
      const ci = viaConn[at];
      if (ci < 0) return null;
      const trip = conn[ci * 5 + 4];
      let j = boardAt[trip] ? boardAt[trip] - 1 : ci;
      if (j > ci) j = ci;
      legs.push({ walk: false, trip, toc: tocOf(trip),
                   from: conn[j * 5 + 2], to: conn[ci * 5 + 3],
                   dep: conn[j * 5], arr: conn[ci * 5 + 1] });
      at = conn[j * 5 + 2];
      onFoot = boardWalk[trip] === 1;
    }
    if (at !== origin) return null;
    legs.reverse();
    return legs;
  }

  /* Every calling point of one leg, so the map can draw the route rather than
     a chord between its endpoints. Connections are sorted by departure and a
     trip's hops run forward in time, so this is a walk along the chain from
     the leg's first station until it reaches the last. */
  function stopsOfLeg(leg) {
    if (leg.walk) return [leg.from, leg.to];
    const { conn, nConn } = TT;
    let lo = 0, hi = nConn;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (conn[mid * 5] < leg.dep) lo = mid + 1; else hi = mid;
    }
    const out = [leg.from];
    let at = leg.from;
    for (let i = lo; i < nConn && conn[i * 5] <= leg.arr; i++) {
      if (conn[i * 5 + 4] !== leg.trip || conn[i * 5 + 2] !== at) continue;
      at = conn[i * 5 + 3];
      out.push(at);
      if (at === leg.to) return out;
    }
    return [leg.from, leg.to];          // chain broke: fall back to a chord
  }

  /* The two-letter ATOC code operating a trip, or "" when the build predates
     the operator section. */
  function tocOf(trip) {
    if (!TT || !TT.toc.length || trip >= TT.toc.length) return "";
    const v = TT.toc[trip];
    const code = String.fromCharCode(v & 0xff, (v >> 8) & 0xff).trim();
    return /^[A-Z0-9]{2}$/.test(code) ? code : "";
  }

/* Every direct service from one station to another across the whole day.
 *
 * This is the frequency people actually want. 820 trains leave Paddington, but
 * only a dozen of them go to Kemble, and it is the dozen that decides whether
 * the journey works. Counting departures at a station answers a question
 * nobody asked once they have named where they are going.
 *
 * One pass over the connections. They are sorted by departure time and a
 * trip's own hops run forward in time, so a trip that departs the origin and
 * later arrives at the target is a direct service, found in order.
 */
  function directServices(fromCrs, toCrs) {
    if (!TT) return null;
    const origin = TT.index.get(fromCrs), target = TT.index.get(toCrs);
    if (origin === undefined || target === undefined || origin === target) return null;
    const { conn, nConn } = TT;
    const boardedAt = new Int32Array(65536).fill(-1);
    const done = new Uint8Array(65536);
    const out = [];
    for (let i = 0; i < nConn; i++) {
      const trip = conn[i * 5 + 4];
      if (done[trip]) continue;
      if (conn[i * 5 + 2] === origin && boardedAt[trip] < 0) boardedAt[trip] = conn[i * 5];
      if (conn[i * 5 + 3] === target && boardedAt[trip] >= 0) {
        out.push({ dep: boardedAt[trip], arr: conn[i * 5 + 1], toc: tocOf(trip) });
        done[trip] = 1;                 // a service is counted once
      }
    }
    out.sort((a, b) => a.dep - b.dep);
    return out;
  }

/* Commute time to one destination, from every station in the country, in a
 * single backward sweep.
 *
 * This is the question the map is actually for: "I have to be at work by nine
 * — where could I live?" Asking it the forward way would mean one scan per
 * origin, 2,576 of them. Run backwards it is one scan, because the answer for
 * every station falls out of the same pass.
 *
 * Connections are walked newest-first. A connection is usable if riding it
 * still leaves you able to reach the target: either it arrives at the target
 * in time, or you can change at its far end within that station's published
 * interchange time, or you are already aboard a trip that works. Because a
 * trip's own hops run forward in time and we are going backwards, "already
 * aboard" is simply a trip we have marked on an earlier iteration — which is
 * also what stops a change penalty being charged for staying on the train.
 *
 * Returns minutes of travel per stop index, or -1 where the target cannot be
 * reached in time. `latest` holds the latest possible departure, which is the
 * more useful number for "when do I have to leave".
 */
  function commuteTo(targetCrs, arriveBy, windowMins = 240) {
    if (!TT) throw new Error("timetable not loaded");
    const target = TT.index.get(targetCrs);
    if (target === undefined) return null;
    const { nStops, nConn, conn, walk, walkFrom, chg } = TT;

    const NONE = -0x7fffffff;
    /* Two clocks per station, mirroring the forward scan exactly.
         reach — the latest you can *be* at this station and still make it.
         cont  — the latest a *train* may put you down here and still make it,
                 which is earlier, because you then have to change (chg) or walk.
       One combined number cannot express both: charging the interchange time to
       someone who is about to walk out of the station makes the answer
       pessimistic, and not charging it to someone changing platforms makes it
       wrong. */
    const reach = new Int32Array(nStops).fill(NONE);
    const cont = new Int32Array(nStops).fill(NONE);
    const onTrip = new Uint8Array(65536);
    const earliest = arriveBy - windowMins;   // nothing before this is a commute

    /* The destination itself: arriving by train at arriveBy is the whole point,
       so no interchange is charged there. */
    reach[target] = arriveBy;
    cont[target] = arriveBy;
    /* Walking in to the destination counts — Euston to King's Cross is a real
       part of a real commute. Walk edges are stored both ways, so the edges
       leaving the target are also the edges arriving at it. A train may put you
       down at the far end and you simply walk, so cont gets the same value. */
    for (let w = walkFrom[target]; w < walkFrom[target + 1]; w++) {
      const v = walk[w * 3 + 1], t = arriveBy - walk[w * 3 + 2];
      if (t > reach[v]) reach[v] = t;
      if (t > cont[v]) cont[v] = t;
    }

    /* Start at the last connection that could still arrive in time. */
    let lo = 0, hi = nConn;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (conn[mid * 5] <= arriveBy) lo = mid + 1; else hi = mid;
    }

    for (let i = lo - 1; i >= 0; i--) {
      const dep = conn[i * 5];
      if (dep < earliest) break;                 // too early to be a commute
      const trip = conn[i * 5 + 4];
      const to = conn[i * 5 + 3], arr = conn[i * 5 + 1];
      /* Riding on is free; getting off and continuing is what `cont` prices. */
      const usable = onTrip[trip] === 1 || (cont[to] !== NONE && arr <= cont[to]);
      if (!usable) continue;
      onTrip[trip] = 1;
      const from = conn[i * 5 + 2];
      if (dep > reach[from]) reach[from] = dep;
      /* A train may drop you at `from` and you change onto this one. */
      const viaChange = dep - (chg[from] || MIN_CHANGE);
      if (viaChange > cont[from]) cont[from] = viaChange;
      /* …or drop you next door and you walk across to it, which costs the walk
         and nothing else — the same rule the forward scan applies. */
      for (let w = walkFrom[from]; w < walkFrom[from + 1]; w++) {
        const v = walk[w * 3 + 1], t = dep - walk[w * 3 + 2];
        if (t > reach[v]) reach[v] = t;
        if (t > cont[v]) cont[v] = t;
      }
    }

    const mins = new Int32Array(nStops).fill(-1);
    for (let i = 0; i < nStops; i++) {
      if (reach[i] === NONE) continue;
      const d = arriveBy - reach[i];
      if (d >= 0 && d <= windowMins) mins[i] = d;
    }
    mins[target] = 0;
    return { mins, latest: reach, target, arriveBy, windowMins };
  }

  /* Up to `limit` successive departures from t0 onwards. */
  function plan(fromCrs, toCrs, t0, limit = 4) {
    if (!TT) throw new Error("timetable not loaded");
    const origin = TT.index.get(fromCrs), target = TT.index.get(toCrs);
    if (origin === undefined || target === undefined) return { error: "unknown station" };
    if (origin === target) return { error: "same station" };

    const out = [];
    let t = t0;
    for (let k = 0; k < limit; k++) {
      const r = scan(origin, target, t);
      if (!r) break;
      const legs = rebuild(origin, target, r);
      if (!legs || !legs.length) break;
      const dep = legs[0].dep, arr = legs[legs.length - 1].arr;
      out.push({ dep, arr, mins: arr - dep, changes: legs.filter((l) => !l.walk).length - 1, legs });
      t = dep + 1;                   // next one must leave later than this
      if (t > t0 + 24 * 60) break;
    }
    return { journeys: out };
  }

  return { load, plan, stopsOfLeg, tocOf, directServices, commuteTo,
           get data() { return TT; } };
})();
