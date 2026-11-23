/* Real track geometry between stations, so a drawn route follows the rails.
 *
 * The journey planner knows a route's calling points. Joining those with
 * straight lines draws a chord across open country — it cuts every curve and
 * crosses the Pennines in a straight line, which is what a planned journey
 * used to look like on this map.
 *
 * scripts/build_segments.py ships the alignment between each pair of stations
 * that are neighbours on the track. Consecutive calling points are often *not*
 * neighbours — a fast train from Reading to Paddington passes four stations it
 * does not call at — so this walks the station-adjacency graph between them and
 * stitches the segments together. That graph is 2,797 nodes and 3,629 edges, so
 * the search is far below the cost of drawing the result.
 */
"use strict";

const Track = (() => {
  let SEG = null, loading = null;

  async function load(base) {
    if (SEG) return SEG;
    if (loading) return loading;
    loading = (async () => {
      const [buf, meta] = await Promise.all([
        fetch(base + "segments.bin").then((r) => {
          if (!r.ok) throw new Error("segments.bin: " + r.status);
          return r.arrayBuffer();
        }),
        fetch(base + "seg_stops.json").then((r) => r.json()),
      ]);
      const dv = new DataView(buf);
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
      if (magic !== "SEG1") throw new Error("segments.bin is an old format — rerun make segments");

      const nSeg = dv.getUint32(8, true);
      const offRows = dv.getUint32(12, true);
      const offPts = dv.getUint32(16, true);

      /* Rows are a packed mixed-width record, so they are unpacked once into
         parallel arrays rather than read through a DataView on every query. */
      const segA = new Uint16Array(nSeg), segB = new Uint16Array(nSeg);
      const segStart = new Uint32Array(nSeg), segLen = new Uint16Array(nSeg);
      const segM = new Uint16Array(nSeg);
      for (let i = 0; i < nSeg; i++) {
        const o = offRows + i * 12;
        segA[i] = dv.getUint16(o, true);
        segB[i] = dv.getUint16(o + 2, true);
        segStart[i] = dv.getUint32(o + 4, true);
        segLen[i] = dv.getUint16(o + 8, true);
        segM[i] = dv.getUint16(o + 10, true);
      }
      const pts = new Int32Array(buf, offPts, (buf.byteLength - offPts) >> 2);

      const index = new Map();
      meta.stops.forEach((k, i) => index.set(k, i));

      /* CSR adjacency over the station graph: each edge appears from both ends. */
      const n = meta.stops.length;
      const deg = new Int32Array(n + 1);
      for (let i = 0; i < nSeg; i++) { deg[segA[i] + 1]++; deg[segB[i] + 1]++; }
      for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
      const cursor = deg.slice();
      const adjTo = new Uint16Array(nSeg * 2), adjSeg = new Uint32Array(nSeg * 2);
      for (let i = 0; i < nSeg; i++) {
        adjTo[cursor[segA[i]]] = segB[i]; adjSeg[cursor[segA[i]]++] = i;
        adjTo[cursor[segB[i]]] = segA[i]; adjSeg[cursor[segB[i]]++] = i;
      }

      SEG = { n, nSeg, segA, segB, segStart, segLen, segM, pts, index,
              stops: meta.stops, adjFrom: deg, adjTo, adjSeg, cache: new Map() };
      return SEG;
    })();
    return loading;
  }

  const ready = () => !!SEG;

  /* Shortest run of segments from a to b, by track metres. The graph is small
     enough that a plain array scan for the next node beats a heap. */
  function hops(a, b) {
    const { n, adjFrom, adjTo, adjSeg, segM } = SEG;
    const dist = new Float64Array(n).fill(Infinity);
    const viaSeg = new Int32Array(n).fill(-1);
    const viaNode = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[a] = 0;
    /* A bucket queue would be faster still, but 2,797 nodes at a handful of
       queries per journey is already immeasurable next to the redraw. */
    const heap = [[0, a]];
    while (heap.length) {
      let k = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[k][0]) k = i;
      const [d, u] = heap.splice(k, 1)[0];
      if (done[u]) continue;
      done[u] = 1;
      if (u === b) break;
      for (let e = adjFrom[u]; e < adjFrom[u + 1]; e++) {
        const v = adjTo[e];
        if (done[v]) continue;
        const nd = d + (segM[adjSeg[e]] || 1);
        if (nd < dist[v]) {
          dist[v] = nd;
          viaSeg[v] = adjSeg[e];
          viaNode[v] = u;
          heap.push([nd, v]);
        }
      }
    }
    if (!done[b]) return null;
    const out = [];
    let at = b, guard = 0;
    while (at !== a && guard++ < 4000) {
      out.push([viaSeg[at], viaNode[at], at]);
      at = viaNode[at];
      if (at < 0) return null;
    }
    out.reverse();
    return out;
  }

  /* The polyline from station `fromKey` to station `toKey`, or null if the two
     are not connected in the segment graph (the caller then draws a chord). */
  function between(fromKey, toKey) {
    if (!SEG) return null;
    if (fromKey === toKey) return null;
    const ck = fromKey + ">" + toKey;
    const hit = SEG.cache.get(ck);
    if (hit !== undefined) return hit;

    const a = SEG.index.get(fromKey), b = SEG.index.get(toKey);
    let line = null;
    if (a !== undefined && b !== undefined) {
      const chain = hops(a, b);
      if (chain) {
        line = [];
        for (const [seg, u, v] of chain) {
          const start = SEG.segStart[seg], len = SEG.segLen[seg];
          /* Segments are stored a -> b; traversing the other way needs them
             reversed, or the route doubles back on itself at every join. */
          const forward = SEG.segA[seg] === u && SEG.segB[seg] === v;
          for (let k = 0; k < len; k++) {
            const i = (start + (forward ? k : len - 1 - k)) * 2;
            const p = [SEG.pts[i] / 1e5, SEG.pts[i + 1] / 1e5];
            // the join repeats the shared station node
            if (line.length && p[0] === line[line.length - 1][0]
                            && p[1] === line[line.length - 1][1]) continue;
            line.push(p);
          }
        }
        if (line.length < 2) line = null;
      }
    }
    SEG.cache.set(ck, line);
    return line;
  }

  return { load, between, ready, get data() { return SEG; } };
})();
