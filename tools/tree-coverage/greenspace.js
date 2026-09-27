/**
 * greenspace.js — the "300" of the 3-30-300 rule.
 *
 * Finds public green space around the pin: rasterises the qualifying
 * categories of the vector tiles covering a 600 m box (a 300 m radius
 * circle) into one union mask, splits the mask into connected patches
 * (so a park split across tile edges still counts as one patch), and
 * measures the straight-line distance from the pin to every patch.
 *
 * A patch qualifies when its area is at least the chosen minimum (the
 * WHO 2017 / Konijnendijk 2023 reading uses 1 ha, the 2024 methods
 * review uses 0.5 ha). Farmland is excluded: it is private land, not a
 * public green space.
 *
 * Depends on coverage.js (global Coverage) and mvt.js (global MVT).
 * Plain <script> (no ES module) so the page also works from file://.
 */
(function (global) {
  'use strict';

  const C = global.Coverage;
  const RADIUS = 300; // rule distance in metres
  const SIZE = 512; // raster side of the 600 m search box

  // Categories that can count as a public green space (no farmland).
  const GREEN_IDS = ['parks', 'wood', 'grass', 'gardens', 'sport', 'wild'];

  // -------------------------------------------------------------- rasterise

  /**
   * Draw one tile's qualifying polygons into the union mask. Geometry is
   * projected from tile-extent units into box pixels; the canvas clips.
   */
  function paintTile(ctx, tile, layers, box, size) {
    const rect = box.rect;
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    const n = Math.pow(2, tile.z);
    let painted = 0;

    for (const [layerName, layer] of layers) {
      const extent = layer.extent || 4096;
      const ax = size / (extent * n * width);
      const ay = size / (extent * n * height);
      const bx = ((tile.x / n - rect.x0) * size) / width;
      const by = ((tile.y / n - rect.y0) * size) / height;

      for (const feature of layer.features) {
        if (feature.type !== 3 || !feature.rings.length) continue;
        const props = feature.properties;
        let isGreen = false;
        for (const id of GREEN_IDS) {
          if (C.CATEGORY_BY_ID.get(id).match(layerName, props, 3)) {
            isGreen = true;
            break;
          }
        }
        if (!isGreen) continue;

        ctx.beginPath();
        for (const ring of feature.rings) {
          const x0 = bx + ax * ring[0][0];
          const y0 = by + ay * ring[0][1];
          ctx.moveTo(x0, y0);
          for (let p = 1; p < ring.length; p++) ctx.lineTo(bx + ax * ring[p][0], by + ay * ring[p][1]);
          ctx.closePath();
        }
        ctx.fill('evenodd'); // outer ring minus holes
        painted++;
      }
    }
    return painted;
  }

  /**
   * Label the mask into 4-connected patches. Returns labels (Int32Array,
   * -1 = no green) plus per-patch pixel counts.
   */
  function labelPatches(mask, size) {
    const labels = new Int32Array(size * size).fill(-1);
    const counts = [];
    const stack = new Int32Array(size * size);
    let next = 0;

    for (let seed = 0; seed < mask.length; seed++) {
      if (!mask[seed] || labels[seed] !== -1) continue;
      const label = next++;
      let top = 0;
      stack[top++] = seed;
      labels[seed] = label;
      let count = 0;
      while (top > 0) {
        const i = stack[--top];
        count++;
        const x = i % size;
        const y = (i / size) | 0;
        if (x > 0 && mask[i - 1] && labels[i - 1] === -1) { labels[i - 1] = label; stack[top++] = i - 1; }
        if (x < size - 1 && mask[i + 1] && labels[i + 1] === -1) { labels[i + 1] = label; stack[top++] = i + 1; }
        if (y > 0 && mask[i - size] && labels[i - size] === -1) { labels[i - size] = label; stack[top++] = i - size; }
        if (y < size - 1 && mask[i + size] && labels[i + size] === -1) { labels[i + size] = label; stack[top++] = i + size; }
      }
      counts.push(count);
    }
    return { labels, counts, patchCount: next };
  }

  // ---------------------------------------------------------------- compute

  /**
   * Measure green-space access around a point.
   *
   * @param {number} lat
   * @param {number} lon
   * @param {object} opts
   * @param {number} [opts.minHa]       minimum patch size in hectares (default 1)
   * @param {function} opts.fetchTile   async (z, x, y, signal) => ArrayBuffer
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<object>} nearest qualifying patch with distance and
   *   the map point where it starts
   */
  async function compute(lat, lon, opts) {
    const minHa = opts.minHa != null ? opts.minHa : 1;
    const t0 = performance.now();

    const box = C.squareFromMeters(lat, lon, RADIUS * 2);
    const { z, tiles } = C.planSourceTiles(box);
    const buffers = await Promise.all(tiles.map((t) => opts.fetchTile(t.z, t.x, t.y, opts.signal)));
    const layerSets = buffers.map((bytes) => global.MVT.readTile(bytes));

    // rasterise the union of qualifying green polygons
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = SIZE;
    maskCanvas.height = SIZE;
    const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';

    const pinWorldX = C.lonToWorldX(lon);
    const pinWorldY = C.latToWorldY(lat);
    const pinPx = ((pinWorldX - box.rect.x0) / (box.rect.x1 - box.rect.x0)) * SIZE;
    const pinPy = ((pinWorldY - box.rect.y0) / (box.rect.y1 - box.rect.y0)) * SIZE;

    for (let i = 0; i < tiles.length; i++) {
      paintTile(ctx, tiles[i], layerSets[i], box, SIZE);
    }

    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const mask = new Uint8Array(SIZE * SIZE);
    for (let i = 0, a = 3; i < mask.length; i++, a += 4) mask[i] = data[a] > 127 ? 1 : 0;

    const { labels, counts, patchCount } = labelPatches(mask, SIZE);

    // pin pixel (float position kept for exact distances)
    const pinIdx = Math.min(SIZE - 1, Math.max(0, Math.floor(pinPy))) * SIZE + Math.min(SIZE - 1, Math.max(0, Math.floor(pinPx)));

    const mPerPx = (RADIUS * 2) / SIZE;
    const pxAreaM2 = mPerPx * mPerPx;

    // one pass: per-patch pixel count is from the flood fill; distance too
    const dist2 = new Float64Array(patchCount).fill(Infinity);
    const bestPx = new Int32Array(patchCount).fill(-1);
    const inside = mask[pinIdx] === 1 ? labels[pinIdx] : -1;

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label < 0) continue;
      const x = i % SIZE;
      const y = (i / SIZE) | 0;
      const dx = x - pinPx;
      const dy = y - pinPy;
      const d2 = dx * dx + dy * dy;
      if (d2 < dist2[label]) {
        dist2[label] = d2;
        bestPx[label] = i;
      }
    }

    const patches = [];
    for (let label = 0; label < patchCount; label++) {
      const areaM2 = counts[label] * pxAreaM2;
      const distM = label === inside ? 0 : Math.sqrt(dist2[label]) * mPerPx;
      patches.push({ label, areaM2, distM, inside: label === inside });
    }

    const qualifying = patches.filter((p) => p.areaM2 >= minHa * 10000);
    const nearest = qualifying.reduce(
      (best, p) => (!best || p.distM < best.distM ? p : best),
      null,
    );

    let nearestPoint = null;
    if (nearest) {
      const idx = nearest.inside ? pinIdx : bestPx[nearest.label];
      const x = (idx % SIZE) + 0.5;
      const y = ((idx / SIZE) | 0) + 0.5;
      nearestPoint = {
        lon: C.worldXToLon(box.rect.x0 + (x / SIZE) * (box.rect.x1 - box.rect.x0)),
        lat: C.worldYToLat(box.rect.y0 + (y / SIZE) * (box.rect.y1 - box.rect.y0)),
      };
    }

    const within = qualifying.filter((p) => p.distM <= RADIUS).length;

    return {
      radius: RADIUS,
      box,
      source: { zoom: z, tiles: tiles.length },
      minHa,
      inside,
      patches: patches.length,
      qualifying: qualifying.length,
      within,
      nearest: nearest
        ? { distM: nearest.distM, areaM2: nearest.areaM2, inside: nearest.inside, point: nearestPoint }
        : null,
      ms: Math.round(performance.now() - t0),
    };
  }

  global.Greenspace = { RADIUS, GREEN_IDS, compute };
})(typeof globalThis !== 'undefined' ? globalThis : this);