/**
 * coverage.js — the sampling maths behind the page.
 *
 * Given a point + a square (either a slippy-map tile at some zoom, or a fixed
 * ground size), decode the OpenMapTiles vector tiles that cover the square,
 * rasterise the selected green layers into an offscreen canvas and count how
 * much of the square is covered.
 *
 * Rasterising instead of doing polygon intersection with turf means holes,
 * multipolygons, overlaps and tile-edge clipping are all handled by the 2D
 * canvas fill rule (even-odd), which is exactly the semantics we want.
 *
 * Plain <script> (no ES module) so the page also works from file://.
 */
(function (global) {
  'use strict';

  const EARTH_EQUATORIAL_RADIUS = 6378137; // WGS84, metres
  const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_EQUATORIAL_RADIUS;
  const DATA_MAX_ZOOM = 14; // OpenMapTiles planet tiles stop at z14; clients overzoom
  const RASTER = 1024; // pixels per side of the counting canvas
  const MAX_TILES = 8; // safety cap on tile fetches per sample

  // ------------------------------------------------------------------ maths

  function lonToWorldX(lon) {
    return (lon + 180) / 360;
  }

  function latToWorldY(lat) {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function worldXToLon(x) {
    return x * 360 - 180;
  }

  function worldYToLat(y) {
    return (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** World-coordinate rect of slippy tile z/x/y. */
  function tileRect(z, x, y) {
    const n = Math.pow(2, z);
    return { x0: x / n, y0: y / n, x1: (x + 1) / n, y1: (y + 1) / n };
  }

  /** Exact ground area (m²) of a web-mercator rect. */
  function rectAreaM2(rect) {
    const dLon = (rect.x1 - rect.x0) * 2 * Math.PI;
    const s1 = Math.sin((worldYToLat(rect.y0) * Math.PI) / 180);
    const s0 = Math.sin((worldYToLat(rect.y1) * Math.PI) / 180);
    return EARTH_EQUATORIAL_RADIUS * EARTH_EQUATORIAL_RADIUS * dLon * (s1 - s0);
  }

  function rectGroundWidthM(rect, lat) {
    return (rect.x1 - rect.x0) * EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180);
  }

  // ------------------------------------------------------------ square specs

  /**
   * Grid-aligned (or pin-centred) square of exactly one slippy tile at zoom z.
   * This is the "sample the square at zoom level N" mode.
   */
  function squareFromZoom(lat, lon, z, centered) {
    const n = Math.pow(2, z);
    const wx = lonToWorldX(lon);
    const wy = latToWorldY(lat);
    const side = 1 / n;
    let rect;
    let tile = null;

    if (centered) {
      rect = { x0: wx - side / 2, y0: wy - side / 2, x1: wx + side / 2, y1: wy + side / 2 };
    } else {
      const x = clamp(Math.floor(wx * n), 0, n - 1);
      const y = clamp(Math.floor(wy * n), 0, n - 1);
      tile = { z, x, y };
      rect = tileRect(z, x, y);
    }

    return {
      kind: 'zoom',
      zoom: z,
      tile,
      rect,
      centered: !!centered,
      sideMeters: EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180) / n,
      areaM2: rectAreaM2(rect),
    };
  }

  /** Square of a fixed ground size, centred on the pin. */
  function squareFromMeters(lat, lon, meters) {
    const scale = meters / (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180));
    const wx = lonToWorldX(lon);
    const wy = latToWorldY(lat);
    const rect = {
      x0: wx - scale / 2,
      y0: wy - scale / 2,
      x1: wx + scale / 2,
      y1: wy + scale / 2,
    };
    return {
      kind: 'meters',
      meters,
      tile: null,
      rect,
      centered: true,
      sideMeters: meters,
      areaM2: rectAreaM2(rect),
    };
  }

  /** All tiles at zoom z that the rect touches (half-open, boundary-safe). */
  function tilesForRect(z, rect) {
    const n = Math.pow(2, z);
    const eps = 1e-9;
    const x0 = clamp(Math.floor(rect.x0 * n + eps), 0, n - 1);
    const x1 = clamp(Math.ceil(rect.x1 * n - eps) - 1, 0, n - 1);
    const y0 = clamp(Math.floor(rect.y0 * n + eps), 0, n - 1);
    const y1 = clamp(Math.ceil(rect.y1 * n - eps) - 1, 0, n - 1);
    const tiles = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
    }
    return tiles;
  }

  /** Pick the data zoom (never above z14) and tiles needed for a square. */
  function planSourceTiles(square) {
    let z = square.kind === 'zoom' && square.zoom < DATA_MAX_ZOOM ? square.zoom : DATA_MAX_ZOOM;
    let tiles = tilesForRect(z, square.rect);
    while (tiles.length > MAX_TILES && z > 0) {
      z -= 1;
      tiles = tilesForRect(z, square.rect);
    }
    return { z, tiles };
  }

  function squareCenter(square) {
    return {
      lat: worldYToLat((square.rect.y0 + square.rect.y1) / 2),
      lon: worldXToLon((square.rect.x0 + square.rect.x1) / 2),
    };
  }

  // -------------------------------------------------------------- categories

  const GRASS_SUBCLASSES = ['grass', 'grassland', 'meadow', 'village_green', 'recreation_ground', 'golf_course'];
  const GARDEN_SUBCLASSES = ['garden', 'allotments', 'orchard', 'vineyard', 'plant_nursery', 'flowerbed'];
  const WILD_SUBCLASSES = [
    'scrub', 'heath', 'fell', 'tundra', 'dune', 'beach', 'bare_rock', 'scree',
    'mangrove', 'marsh', 'bog', 'swamp', 'reedbed', 'saltmarsh', 'tidalflat', 'wet_meadow',
  ];

  /**
   * Which coverage buckets a vector-tile feature belongs to.
   * `type` is the MVT geometry type: 1 point, 2 line, 3 polygon.
   */
  const CATEGORIES = [
    {
      id: 'parks',
      label: 'Parks & protected areas',
      hint: 'leisure=park (landcover), nature reserves, national parks, protected areas',
      color: '#1b7f3b',
      default: true,
      match: (layer, props, type) =>
        (layer === 'landcover' && props.subclass === 'park') ||
        (layer === 'park' && type === 3) ||
        (layer === 'landuse' && props.class === 'park'),
    },
    {
      id: 'wood',
      label: 'Woods & forest',
      hint: 'landcover class=wood (forest, woodland)',
      color: '#0b3d2e',
      default: true,
      match: (layer, props) => layer === 'landcover' && props.class === 'wood',
    },
    {
      id: 'grass',
      label: 'Grass & meadows',
      hint: 'lawns, verges, meadows, recreation grounds',
      color: '#8bc34a',
      default: false,
      match: (layer, props) =>
        layer === 'landcover' && props.class === 'grass' && GRASS_SUBCLASSES.includes(props.subclass),
    },
    {
      id: 'gardens',
      label: 'Gardens & allotments',
      hint: 'garden, allotments, orchard, vineyard, flowerbed',
      color: '#fdd835',
      default: false,
      match: (layer, props) => layer === 'landcover' && GARDEN_SUBCLASSES.includes(props.subclass),
    },
    {
      id: 'wild',
      label: 'Scrub, heath & wetland',
      hint: 'natural scrub/heath, wetland, dunes, rock',
      color: '#26a69a',
      default: false,
      match: (layer, props) =>
        layer === 'landcover' &&
        (props.class === 'wetland' || props.class === 'rock' || WILD_SUBCLASSES.includes(props.subclass)),
    },
    {
      id: 'sport',
      label: 'Sports & urban green',
      hint: 'pitch, playground, cemetery, zoo, theme park',
      color: '#8d6e63',
      default: false,
      match: (layer, props) =>
        layer === 'landuse' && ['pitch', 'playground', 'cemetery', 'theme_park', 'zoo', 'stadium'].includes(props.class),
    },
    {
      id: 'farmland',
      label: 'Farmland',
      hint: 'landcover class=farmland (fields)',
      color: '#d7ccc8',
      default: false,
      match: (layer, props) => layer === 'landcover' && props.class === 'farmland',
    },
  ];

  const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

  function matchesFor(layer, props, type) {
    const out = [];
    for (const c of CATEGORIES) if (c.match(layer, props, type)) out.push(c.id);
    return out;
  }

  // ------------------------------------------------------------- rasterising

  function makeCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  }

  /**
   * Draw every polygon of the selected categories into one mask per category.
   * Geometry is projected from tile-extent units straight into square pixels,
   * so anything outside the square is clipped by the canvas itself.
   */
  function rasterise(square, tileList, layerSets, selectedIds, size) {
    const rect = square.rect;
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    const ids = CATEGORIES.filter((c) => selectedIds.includes(c.id)).map((c) => c.id);
    const bitOf = new Map(ids.map((id, i) => [id, 1 << i]));

    const masks = new Map();
    const ctxs = new Map();
    for (const id of ids) {
      const canvas = makeCanvas(size);
      masks.set(id, canvas);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      ctxs.set(id, ctx);
    }

    const names = new Set();
    let featureCount = 0;

    for (let i = 0; i < tileList.length; i++) {
      const tile = tileList[i];
      const layers = layerSets[i];
      const n = Math.pow(2, tile.z);

      for (const [layerName, layer] of layers) {
        const extent = layer.extent || 4096;
        // Affine tile-extent -> square-pixel transform, per tile.
        const ax = size / (extent * n * width);
        const ay = size / (extent * n * height);
        const bx = ((tile.x / n - rect.x0) * size) / width;
        const by = ((tile.y / n - rect.y0) * size) / height;

        for (const feature of layer.features) {
          if (!feature.rings.length) continue;
          const cats = matchesFor(layerName, feature.properties, feature.type);
          if (!cats.length) continue;

          const paths = feature.rings.map((ring) => {
            const pts = new Array(ring.length * 2);
            for (let p = 0; p < ring.length; p++) {
              pts[p * 2] = bx + ax * ring[p][0];
              pts[p * 2 + 1] = by + ay * ring[p][1];
            }
            return pts;
          });

          for (const id of cats) {
            if (!ctxs.has(id)) continue;
            const ctx = ctxs.get(id);
            ctx.beginPath();
            for (const pts of paths) {
              ctx.moveTo(pts[0], pts[1]);
              for (let p = 2; p < pts.length; p += 2) ctx.lineTo(pts[p], pts[p + 1]);
              ctx.closePath();
            }
            // even-odd: outer rings minus holes, islands inside holes kept
            ctx.fill('evenodd');
          }
          featureCount++;

          // Collect names of park *polygons* that overlap the square; point
          // features carry no area and would not explain the percentage.
          if (layerName === 'park' && feature.type === 3) {
            const name = feature.properties.name || feature.properties['name:en'];
            if (name && !names.has(name) && pathsIntersectSquare(paths, size)) names.add(name);
          }
        }
      }
    }

    // Count pixels: per category and as a union (overlaps counted once).
    const covered = new Uint8Array(size * size);
    const byCategory = {};
    for (const [id, ctx] of ctxs) {
      const data = ctx.getImageData(0, 0, size, size).data;
      const bit = bitOf.get(id);
      let count = 0;
      for (let i = 0, a = 3; i < covered.length; i++, a += 4) {
        if (data[a] > 127) {
          covered[i] |= bit;
          count++;
        }
      }
      byCategory[id] = count;
    }

    let union = 0;
    for (let i = 0; i < covered.length; i++) if (covered[i]) union++;

    return {
      masks,
      byCategory,
      union,
      total: size * size,
      featureCount,
      names: [...names].sort(),
      covered,
    };
  }

  /**
   * Does the polygon actually cover part of the square? Sample a small grid of
   * points and use even-odd ray casting, so a donut-shaped feature whose
   * bounding box overlaps but whose geometry does not is not reported.
   * Used only for the park-name chips.
   */
  function pathsIntersectSquare(paths, size) {
    const GRID = 5;
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const px = ((gx + 0.5) / GRID) * size;
        const py = ((gy + 0.5) / GRID) * size;
        if (pointInRings(paths, px, py)) return true;
      }
    }
    return false;
  }

  /** Even-odd point-in-polygon over flat [x, y, x, y, ...] rings. */
  function pointInRings(paths, px, py) {
    let inside = false;
    for (const pts of paths) {
      for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
        const xi = pts[i];
        const yi = pts[i + 1];
        const xj = pts[j];
        const yj = pts[j + 1];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
    return inside;
  }

  /** Colour the union mask by category precedence, for the preview canvas. */
  function buildPreview(covered, ids, size) {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const palette = ids.map((id) => hexToRgb(CATEGORY_BY_ID.get(id).color));
    for (let i = 0, a = 0; i < covered.length; i++, a += 4) {
      const bits = covered[i];
      if (!bits) continue;
      let color = null;
      for (let b = 0; b < palette.length; b++) {
        if (bits & (1 << b)) {
          color = palette[b];
          break;
        }
      }
      img.data[a] = color[0];
      img.data[a + 1] = color[1];
      img.data[a + 2] = color[2];
      img.data[a + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // ------------------------------------------------------------------ driver

  const now = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  /**
   * Sample a square.
   *
   * @param {object} square            from squareFromZoom / squareFromMeters
   * @param {object} opts
   * @param {string[]} opts.selected   category ids to count
   * @param {function} opts.fetchTile  async (z, x, y, signal) => ArrayBuffer|Uint8Array
   * @param {AbortSignal} [opts.signal]
   * @param {function} [opts.onProgress]
   * @returns {Promise<object>} stats (percent, counts, areas, masks, names, ...)
   */
  async function compute(square, opts) {
    const selected = (opts.selected || []).filter((id) => CATEGORY_BY_ID.has(id));
    const { z, tiles } = planSourceTiles(square);
    const t0 = now();

    if (opts.onProgress) opts.onProgress({ phase: 'fetching', tiles: tiles.length, zoom: z });

    const buffers = await Promise.all(
      tiles.map((t) => opts.fetchTile(t.z, t.x, t.y, opts.signal)),
    );
    const layerSets = buffers.map((bytes) => global.MVT.readTile(bytes));
    const tDecoded = now();

    if (opts.onProgress) opts.onProgress({ phase: 'counting', tiles: tiles.length, zoom: z });

    const raster = rasterise(square, tiles, layerSets, selected, RASTER);
    const preview = buildPreview(raster.covered, selected, RASTER);
    const tDone = now();

    const total = raster.total;
    const byCategory = {};
    for (const id of selected) byCategory[id] = (100 * (raster.byCategory[id] || 0)) / total;

    const center = squareCenter(square);
    const dataZoomNote = square.kind === 'zoom' && square.zoom > z ? ' (overzoomed)' : '';

    return {
      percent: (100 * raster.union) / total,
      byCategory,
      counts: raster.byCategory,
      coveredPixels: raster.union,
      totalPixels: total,
      areaM2: square.areaM2,
      coveredAreaM2: (raster.union / total) * square.areaM2,
      sideMeters: square.sideMeters,
      groundWidthM: rectGroundWidthM(square.rect, center.lat),
      square,
      source: { zoom: z, tiles, note: dataZoomNote },
      features: raster.featureCount,
      names: raster.names,
      preview,
      masks: raster.masks,
      rasterSize: RASTER,
      timing: { decodeMs: tDecoded - t0, countMs: tDone - tDecoded, totalMs: tDone - t0 },
      empty: raster.featureCount === 0,
    };
  }

  global.Coverage = {
    EARTH_CIRCUMFERENCE,
    DATA_MAX_ZOOM,
    RASTER,
    CATEGORIES,
    CATEGORY_BY_ID,
    squareFromZoom,
    squareFromMeters,
    squareCenter,
    planSourceTiles,
    tilesForRect,
    tileRect,
    rectAreaM2,
    lonToWorldX,
    latToWorldY,
    worldXToLon,
    worldYToLat,
    compute,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);