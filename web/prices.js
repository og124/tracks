/* Tracks — the house price overlay.
 *
 * The map answers "how long is the commute from here". The question that always
 * follows is "and what does it cost to live here", and the two are only useful
 * together: a forty-minute commute is a different proposition at £240,000 than
 * at £740,000. So this draws the second answer underneath the first.
 *
 * Shape of the data: data/web/prices.json, built by scripts/build_prices.py —
 * one point per postcode district in England and Wales (median of actual sales
 * over a rolling twelve months) and one per Scottish council area (UK HPI
 * average, because Price Paid is an English and Welsh register). Each point
 * carries its own influence radius, derived from how spread out the postcodes
 * inside it actually are.
 *
 * Why a field and not polygons: there are no free postcode-district boundaries,
 * and inventing them would be drawing a line the data does not contain. An
 * inverse-distance field over the real centroids claims exactly what is true —
 * prices near here look like this — and fades out where there is nothing to say
 * rather than painting a hard edge through empty country.
 *
 * Loaded lazily. Nobody pays for this until they press the button.
 */
"use strict";

const Prices = (() => {
  /* One hue, lightness carrying magnitude, dark end recedes toward the map.
     Dark→bright rather than the estate's usual light→dark, because this is an
     area fill over a dark basemap: a dark "expensive" step would read as less,
     not more. Checked against the dark map surface (#151a20): monotone
     lightness, every adjacent step ≥0.06 apart in OKLab L, hue spread 1°, and
     the dark end still clears the surface at 2.0:1. Orange, not blue, because
     blue is already spoken for by journey time and the two can be on screen
     together. */
  const RAMP = ["#713e1c", "#8e4d20", "#ac5c23", "#ca6c29",
                "#e67f38", "#fa995a", "#febb94", "#fedfcd"];

  let meta = null;
  let n = 0, lat = null, lon = null, val = null, rad = null, kind = null;
  let labels = [], sales = null;
  let loLog = 0, spanLog = 1;
  const LUT = new Uint8Array(256 * 3);

  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16),
                      parseInt(h.slice(5, 7), 16)];

  function buildLUT() {
    const stops = RAMP.map(hex);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1);
      const a = Math.min(stops.length - 1, Math.floor(t)), b = Math.min(stops.length - 1, a + 1);
      const f = t - a;
      for (let c = 0; c < 3; c++) {
        LUT[i * 3 + c] = Math.round(stops[a][c] + (stops[b][c] - stops[a][c]) * f);
      }
    }
  }
  buildLUT();

  async function load(base) {
    if (meta) return true;
    const res = await fetch(base + "prices.json");
    if (!res.ok) throw new Error(`prices.json: ${res.status}`);
    const d = await res.json();
    const pts = d.points || [];
    n = pts.length;
    lat = new Float32Array(n); lon = new Float32Array(n);
    val = new Float32Array(n); rad = new Float32Array(n);
    kind = new Uint8Array(n); sales = new Int32Array(n);
    labels = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      labels[i] = p[0]; lat[i] = p[1]; lon[i] = p[2];
      val[i] = p[3]; sales[i] = p[4]; rad[i] = p[5]; kind[i] = p[6];
    }
    /* Log, not linear. The medians run from £62k to £3.5m; on a linear scale
       every district outside central London lands in the bottom two steps and
       the overlay says nothing about anywhere else. Anchored on the 5th and
       95th percentiles so a handful of Mayfair postcodes cannot flatten the
       rest of the country. */
    const r = d.range || {};
    loLog = Math.log(Math.max(1, r.p5 || 100000));
    spanLog = Math.max(0.1, Math.log(Math.max(1, r.p95 || 700000)) - loLog);
    meta = d;
    return true;
  }

  const ready = () => !!meta;
  const scale = (v) => Math.max(0, Math.min(1, (Math.log(Math.max(1, v)) - loLog) / spanLog));
  const colourAt = (v) => {
    const i = Math.round(scale(v) * 255) * 3;
    return `rgb(${LUT[i]},${LUT[i + 1]},${LUT[i + 2]})`;
  };

  /* The band edges the legend prints. Even steps in log space, which is the
     space the colour is assigned in, so the swatch widths and the numbers
     under them describe the same thing. */
  function bandEdges() {
    const out = [];
    for (let i = 0; i <= RAMP.length; i++) {
      out.push(Math.exp(loLog + (spanLog * i) / RAMP.length));
    }
    return out;
  }

  /* Rough great-circle distance in km. Equirectangular is wrong by under a
     percent at these separations and this is choosing between candidates, not
     reporting a distance. */
  function km(aLat, aLon, bLat, bLon) {
    const x = (aLon - bLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    const y = aLat - bLat;
    return Math.sqrt(x * x + y * y) * 111.32;
  }

  /* The area whose figure actually governs this spot: the one it sits deepest
     inside, not merely the nearest centroid. A postcode district two kilometres
     across outranks a Scottish council area forty kilometres across even when
     the council centroid is closer, which is the behaviour you want — the finer
     measurement wins wherever it has something to say. */
  function at(latitude, longitude) {
    if (!meta) return null;
    let best = -1, bestRatio = Infinity;
    for (let i = 0; i < n; i++) {
      if (Math.abs(lat[i] - latitude) > 1.2) continue;
      const d = km(latitude, longitude, lat[i], lon[i]);
      if (d > rad[i]) continue;
      const ratio = d / rad[i];
      if (ratio < bestRatio) { bestRatio = ratio; best = i; }
    }
    if (best < 0) return null;
    return {
      label: labels[best], price: val[best], sales: sales[best],
      kind: meta.kinds[kind[best]], km: km(latitude, longitude, lat[best], lon[best]),
    };
  }

  /* ------------------------------------------------------------- layer -- */
  /* An L.Renderer subclass for the same reason RailLayer is one: Renderer
     already owns the oversized canvas, the pan translation and the zoomanim
     transform, and a hand-rolled layer freezes mid-zoom while the basemap moves
     underneath it. */
  const Layer = L.Renderer.extend({
    options: { padding: 0.12, opacity: 0.8 },

    /* CSS pixels per field sample. The field is computed at 1/8 resolution and
       scaled up with the browser's own bilinear filter, which is both faster
       than a per-pixel loop and smoother than anything worth hand-writing. 8 px
       is also about the point past which the upscale starts to show as blocks. */
    STEP: 8,

    /* Floor on a point's influence, in grid cells. Without one the whole overlay
       all but vanishes at national zoom: a postcode district two kilometres
       across is under two pixels wide at z6, so almost every point rounds away
       to nothing and the one view where the national pattern *is* the point
       comes up as scattered specks. At z6 a floor of 2 cells covers 110% of the
       land that has a price — full coverage, with a tenth spilling past the
       coast, which the alpha falloff then fades out. Raising it further buys
       nothing and paints more sea. */
    MIN_CELLS: 2,

    _initContainer() {
      const c = (this._container = document.createElement("canvas"));
      c.style.pointerEvents = "none";
      this._ctx = c.getContext("2d");
      /* _field, not _off: L.Evented already has a private _off, and shadowing
         it with a canvas element makes removeLayer throw "this._off is not a
         function" — which surfaces when the overlay is switched *off*, i.e. the
         one path a quick manual check does not take. */
      this._field = document.createElement("canvas");
      this._fieldCtx = this._field.getContext("2d");
    },

    _destroyContainer() {
      L.DomUtil.remove(this._container);
      this._container = null;
      this._ctx = null;
      this._field = null;
      this._fieldCtx = null;
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

    setOpacity(o) { this.options.opacity = o; this.redraw(); },

    redraw() { if (this._map) this._draw(); },

    _draw() {
      const ctx = this._ctx;
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this._container.width, this._container.height);
      ctx.restore();
      if (!meta || !n) return;

      const map = this._map, b = this._bounds, size = b.getSize(), step = this.STEP;
      const gw = Math.max(1, Math.ceil(size.x / step));
      const gh = Math.max(1, Math.ceil(size.y / step));
      const wsum = new Float32Array(gw * gh), vsum = new Float32Array(gw * gh);
      /* Two different questions, two different accumulators.
       *
       * wsum/vsum are inverse-distance weights and answer "what is the price
       * here" — a sum is right for that, it is what makes the interpolation.
       *
       * cover is the *deepest* any one area reaches this cell, a max rather than
       * a sum, and answers "is there a measurement that covers here". Using the
       * weight sum for both was the mistake: midway between two district
       * centroids each weight is a quarter, so the sum is a half and the field
       * came out at 40% opacity across most of the country — washed out in
       * exactly the places where the data is perfectly good. How confident the
       * figure is cannot depend on how many neighbours happen to overlap. */
      const cover = new Float32Array(gw * gh);

      /* Metres per pixel at the centre latitude. Across the width of Great
         Britain that varies by about a fifth, which is less than the error
         already baked into a district's own influence radius — and the field is
         sampled every eight pixels, so chasing it per point would be precision
         the data does not have. */
      const mpp = (156543.03392 * Math.cos(map.getCenter().lat * Math.PI / 180))
                / Math.pow(2, map.getZoom());

      for (let i = 0; i < n; i++) {
        const p = map.latLngToLayerPoint([lat[i], lon[i]]);
        const cx = (p.x - b.min.x) / step, cy = (p.y - b.min.y) / step;
        const rg = Math.max(this.MIN_CELLS, (rad[i] * 1000 / mpp) / step);
        if (cx + rg < 0 || cy + rg < 0 || cx - rg > gw || cy - rg > gh) continue;
        const x0 = Math.max(0, Math.floor(cx - rg)), x1 = Math.min(gw - 1, Math.ceil(cx + rg));
        const y0 = Math.max(0, Math.floor(cy - rg)), y1 = Math.min(gh - 1, Math.ceil(cy + rg));
        const r2 = rg * rg, v = val[i];
        for (let y = y0; y <= y1; y++) {
          const dy = y - cy, dy2 = dy * dy, row = y * gw;
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx, d2 = dx * dx + dy2;
            if (d2 >= r2) continue;
            const t = 1 - Math.sqrt(d2) / rg;
            const w = t * t;                      // smooth to zero at the edge
            wsum[row + x] += w;
            vsum[row + x] += w * v;
            if (t > cover[row + x]) cover[row + x] = t;
          }
        }
      }

      const img = this._fieldCtx.createImageData(gw, gh);
      const px = img.data;
      const alpha = Math.max(0, Math.min(1, this.options.opacity));
      for (let i = 0, j = 0; i < wsum.length; i++, j += 4) {
        const w = wsum[i];
        if (w <= 0) continue;
        const k = Math.round(scale(vsum[i] / w) * 255) * 3;
        px[j] = LUT[k];
        px[j + 1] = LUT[k + 1];
        px[j + 2] = LUT[k + 2];
        /* Weight is coverage, so it is also confidence: full inside an area,
           tapering to nothing where the nearest measurement runs out. That is
           what makes the field end at the coast without a landmask. */
        /* Opaque once you are within half an area's reach of its centre, fading
           to nothing over the outer half. That band is one district radius wide
           — a kilometre or two inland, tens of kilometres in the Highlands —
           which is what ends the field at the coast without a landmask, and
           ends it sooner where the data is finer. */
        px[j + 3] = Math.round(Math.min(1, cover[i] * 2) * 255 * alpha);
      }
      this._field.width = gw;
      this._field.height = gh;
      this._fieldCtx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this._field, b.min.x, b.min.y, gw * step, gh * step);
    },
  });

  return {
    load, ready, at, colourAt, bandEdges, scale, Layer, RAMP,
    get meta() { return meta; },
    get count() { return n; },
  };
})();
