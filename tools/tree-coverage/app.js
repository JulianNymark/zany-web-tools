/**
 * app.js — map, controls and rendering for the coverage sampler.
 * Plain <script> (no ES module) so the page also works from file://.
 */
(function () {
  'use strict';

  const C = window.Coverage;
  const $ = (id) => document.getElementById(id);

  const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
  const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const TILE_CACHE_MAX = 48;

  const ZOOMS = [12, 13, 14, 15, 16, 17, 18];
  const METERS = [100, 200, 300, 530, 600, 1000];
  const THRESHOLD = 30; // the "30" of the rule is fixed; no user input
  const COUNTRY_ZOOM = 9; // below this the square is a dot: country-browse mode

  // Scale labels. There is no official "neighbourhood" size: the 3-30-300
  // methods review (Browning et al. 2024, doi:10.1016/j.scitotenv.2023.167739)
  // defines neighbourhoods either as administrative/statistical units
  // (allocentric) or as an area around the home (egocentric). The zoom squares
  // mirror the first family, the fixed sizes the second.
  const ZOOM_SCALES = {
    12: { tag: 'city', hint: '~6.0 km across: whole-city / municipality scale.' },
    13: { tag: 'district', hint: '~3.0 km across: about the Dutch average CBS *wijk* (1,060 ha).' },
    14: { tag: 'statistical area', hint: '~1.5 km across: about the Dutch average CBS *buurt* (244 ha, an average pulled up by rural ones).' },
    15: { tag: 'neighbourhood', hint: '~750 m across: matches Clarence Perry\'s 160-acre neighbourhood unit (~800 m) and a 10-minute walk.' },
    16: { tag: '5-minute walk', hint: '~375 m across: roughly the 300-400 m people walk in five minutes.' },
    17: { tag: 'city block', hint: '~190 m across: a large urban block.' },
    18: { tag: 'plot / courtyard', hint: '~95 m across: a single building plot or courtyard.' },
  };
  const METER_SCALES = {
    100: { tag: 'plot', hint: 'A courtyard or a couple of buildings.' },
    200: { tag: 'block cluster', hint: 'A handful of city blocks.' },
    300: { tag: 'small block', hint: 'One large block; 150 m from the pin to each edge.' },
    530: { tag: '300 m radius, equal area', hint: 'Same area as a 300 m-radius circle around the pin - the egocentric "neighbourhood" used in canopy studies.' },
    600: { tag: '300 m to each edge', hint: 'The pin sits exactly 300 m from every edge of the square.' },
    1000: { tag: '1 km district', hint: 'A kilometre across; the "15-minute city" is roughly this order of magnitude.' },
  };

  const state = {
    lat: 59.91691, // the Royal Palace, Oslo, in its own park
    lon: 10.72756,
    mode: 'z16',
    greenMinHa: 1,
    green: null,
    countryId: undefined,
    categoriesTouched: false,
    selected: new Set(C.CATEGORIES.filter((c) => c.default).map((c) => c.id)),
    runId: 0,
    result: null,
    mapReady: false,
    pendingSquare: null,
  };

  // ------------------------------------------------------------- tile source

  // The tile URL template carries a version segment, so it is read from the
  // TileJSON at runtime instead of being hard-coded. (Note: the unversioned
  // /planet/{z}/{x}/{y}.pbf alias answers 200 with an empty body, so it is
  // deliberately not used as a fallback.)
  let tileTemplate = null;
  const tileTemplateReady = fetch(TILEJSON_URL)
    .then((res) => res.json())
    .then((json) => {
      if (json && json.tiles && json.tiles[0]) tileTemplate = json.tiles[0];
    })
    .catch(() => {
      /* reported when a sample is attempted */
    });

  const tileCache = new Map();

  async function fetchTile(z, x, y, signal) {
    const key = z + '/' + x + '/' + y;
    const cached = tileCache.get(key);
    if (cached) {
      try {
        return await cached;
      } catch (err) {
        // An entry aborted by an older run must not poison this one: drop it
        // and refetch below when our own signal is still live.
        if (err && err.name === 'AbortError' && signal && !signal.aborted) {
          tileCache.delete(key);
        } else {
          tileCache.delete(key);
          throw err;
        }
      }
    }

    const promise = (async () => {
      await tileTemplateReady;
      if (!tileTemplate) throw new Error('could not read the tile metadata from ' + TILEJSON_URL);
      const url = tileTemplate
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y);
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error('tile ' + key + ' → HTTP ' + res.status);
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength === 0) console.warn('Empty tile body from ' + url);
      return bytes;
    })();

    promise.catch(() => tileCache.delete(key)); // never cache a failure
    tileCache.set(key, promise);
    if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
    return promise;
  }

  // -------------------------------------------------------------------- map

  let map = null;
  let marker = null;

  // Health of the interactive map, surfaced in the UI so a blank canvas is
  // never silent. `window.__dshPage.report()` prints it for pasting.
  const mapDiag = {
    webgl2: null,
    created: false,
    styleLoaded: false,
    tiles: 0,
    errors: [],
  };

  function hasWebGL2() {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch (err) {
      return false;
    }
  }

  function showMapNote(title, body) {
    const el = $('mapNote');
    if (!el) return;
    el.innerHTML = '<strong>' + escapeHtml(title) + '</strong>' + escapeHtml(body);
    el.hidden = false;
  }

  function hideMapNote() {
    const el = $('mapNote');
    if (el) el.hidden = true;
  }

  function updateMapHealth() {
    const el = $('mapHealth');
    if (!el) return;
    const bits = [
      'WebGL2 ' + (mapDiag.webgl2 ? 'ok' : 'missing'),
      'style ' + (mapDiag.styleLoaded ? 'ok' : 'not loaded'),
      'tiles ' + mapDiag.tiles,
    ];
    if (mapDiag.errors.length) bits.push(mapDiag.errors.length + ' error' + (mapDiag.errors.length === 1 ? '' : 's'));
    el.textContent = 'map: ' + bits.join(' · ') + (mapDiag.errors.length ? ' — ' + mapDiag.errors[0] : '');
  }

  function initMap() {
    mapDiag.webgl2 = hasWebGL2();
    updateMapHealth();

    if (typeof maplibregl === 'undefined') {
      showMapNote('MapLibre did not load', 'The MapLibre script (jsDelivr CDN) could not be loaded — offline or blocked. Sampling still works: the map is only the picture.');
      setStatus('MapLibre did not load — sampling still works via the lat/lon boxes.', true);
      return;
    }

    if (!mapDiag.webgl2) {
      showMapNote(
        'The interactive map needs WebGL2',
        'This browser reports no WebGL2 context, so MapLibre cannot render. Sampling and every number in the panel still work. Try another browser, or re-enable hardware acceleration.',
      );
      setStatus('No WebGL2 in this browser — map disabled, sampling still works.', true);
      return;
    }

    try {
      map = new maplibregl.Map({
        container: 'map',
        style: MAP_STYLE,
        center: [state.lon, state.lat],
        zoom: 15.2,
        attributionControl: false,
      });
      mapDiag.created = true;
    } catch (err) {
      showMapNote('The map could not start', String(err && err.message ? err.message : err) + ' — the coverage numbers still work.');
      setStatus('Map could not start (' + err.message + ') — sampling still works.', true);
      return;
    }

    map.on('error', (e) => {
      const msg = (e && e.error && e.error.message) || String((e && e.message) || 'unknown map error');
      mapDiag.errors.push(msg);
      updateMapHealth();
      if (!mapDiag.styleLoaded) {
        showMapNote('The map failed to load', msg + ' — the coverage numbers below still work.');
      }
    });

    map.on('sourcedata', (e) => {
      if (e.tile) mapDiag.tiles++;
      updateMapHealth();
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: 'Coverage sampling: OpenMapTiles schema via OpenFreeMap',
      }),
      'bottom-right',
    );

    marker = new maplibregl.Marker({ draggable: true, color: '#17251c' })
      .setLngLat([state.lon, state.lat])
      .addTo(map);

    marker.on('dragend', () => {
      const ll = marker.getLngLat();
      setPoint(ll.lat, ll.lng, { fromMarker: true });
    });

    map.on('click', (e) => setPoint(e.lngLat.lat, e.lngLat.lng));

    // If the style has not arrived after a few seconds, say so instead of
    // leaving an empty grey rectangle.
    setTimeout(() => {
      if (!mapDiag.styleLoaded) {
        showMapNote(
          'The map style did not load',
          'MapLibre could not fetch ' + MAP_STYLE + ' — check the network, a proxy or an ad-blocker. The coverage numbers below still work.',
        );
        updateMapHealth();
      }
    }, 8000);

    map.on('load', () => {
      mapDiag.styleLoaded = true;
      hideMapNote();
      updateMapHealth();
      // the square: the greenery raster goes under the outline; the flat
      // fill is gone so the map shows the counted categories themselves
      map.addSource('square', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'square-casing',
        type: 'line',
        source: 'square',
        paint: { 'line-color': '#ffffff', 'line-width': 4.5, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'square-line',
        type: 'line',
        source: 'square',
        paint: { 'line-color': '#64748b', 'line-width': 2.5, 'line-dasharray': [3, 2] },
      });

      map.addSource('dataTiles', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'datatile-line',
        type: 'line',
        source: 'dataTiles',
        layout: { visibility: $('showDataTiles').checked ? 'visible' : 'none' },
        paint: { 'line-color': '#0ea5e9', 'line-width': 1.1, 'line-dasharray': [1, 2] },
      });

      // the 300 m rule's one map indicator: the pin-to-park connector, always on,
      // coloured by the verdict (green within 300 m, red beyond)
      map.addSource('rule300', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'rule300-line',
        type: 'line',
        source: 'rule300',
        filter: ['==', ['get', 'kind'], 'walk'],
        paint: { 'line-color': '#16a34a', 'line-width': 3 },
      });

      state.mapReady = true;
      if (state.pendingSquare) drawSquare(state.pendingSquare.square, state.pendingSquare.pass);
      if (state.result) {
        const pass = state.result.percent >= THRESHOLD;
        drawSquare(state.result.square, pass);
        drawDataTiles(state.result.source.tiles);
        drawSquareRaster(state.result);
      }
      if (state.green) drawRule(state.green);
      syncZoomOverlays(); // honour checkboxes ticked before the map was ready
    });

    map.on('zoomend', () => syncZoomOverlays());
  }

  function emptyFC() {
    return { type: 'FeatureCollection', features: [] };
  }

  function rectFeature(rect, properties) {
    const { worldXToLon, worldYToLat } = C;
    const ring = [
      [worldXToLon(rect.x0), worldYToLat(rect.y0)],
      [worldXToLon(rect.x1), worldYToLat(rect.y0)],
      [worldXToLon(rect.x1), worldYToLat(rect.y1)],
      [worldXToLon(rect.x0), worldYToLat(rect.y1)],
      [worldXToLon(rect.x0), worldYToLat(rect.y0)],
    ];
    return {
      type: 'Feature',
      properties: properties || {},
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
  }

  // image-source corners: top-left, top-right, bottom-right, bottom-left.
  // worldY grows southward, so rect.y0 is the north edge.
  function rectCorners(rect) {
    const { worldXToLon, worldYToLat } = C;
    return [
      [worldXToLon(rect.x0), worldYToLat(rect.y0)],
      [worldXToLon(rect.x1), worldYToLat(rect.y0)],
      [worldXToLon(rect.x1), worldYToLat(rect.y1)],
      [worldXToLon(rect.x0), worldYToLat(rect.y1)],
    ];
  }

  function drawSquare(square, pass) {
    if (!state.mapReady) {
      state.pendingSquare = { square, pass };
      return;
    }
    const color = pass === null ? '#64748b' : pass ? '#16a34a' : '#dc2626';
    map.getSource('square').setData(rectFeature(square.rect));
    map.setPaintProperty('square-line', 'line-color', color);
    state.pendingSquare = null;
  }

  /**
   * The counted greenery itself, drawn on the map inside the square with the
   * same category colours as the sidebar preview (the square's fill used to
   * be a flat pass/fail tint; the raster is the honest picture).
   */
  function drawSquareRaster(result) {
    if (!state.mapReady) return;
    const url = result.preview.toDataURL();
    const coordinates = rectCorners(result.square.rect);
    if (!map.getSource('squareRaster')) {
      map.addSource('squareRaster', { type: 'image', url, coordinates });
      // under the outline so the border stays crisp
      map.addLayer({
        id: 'square-raster',
        type: 'raster',
        source: 'squareRaster',
        paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0 },
      }, 'square-casing');
    } else {
      map.getSource('squareRaster').updateImage({ url, coordinates });
    }
  }

  function drawDataTiles(tiles) {
    if (!state.mapReady) return;
    map.getSource('dataTiles').setData({
      type: 'FeatureCollection',
      features: tiles.map((t) => rectFeature(C.tileRect(t.z, t.x, t.y))),
    });
  }

  // ------------------------------------------------------------------ state

  function buildSquare() {
    if (state.mode.charAt(0) === 'z') {
      return C.squareFromZoom(state.lat, state.lon, Number(state.mode.slice(1)), $('centerOnPin').checked);
    }
    return C.squareFromMeters(state.lat, state.lon, Number(state.mode.slice(1)));
  }

  function setPoint(lat, lon, opts) {
    state.lat = Math.max(-85, Math.min(85, lat));
    state.lon = lon;
    $('lat').value = state.lat.toFixed(5);
    $('lon').value = state.lon.toFixed(5);
    if (marker && !(opts && opts.fromMarker)) marker.setLngLat([state.lon, state.lat]);
    updateSizeLabels();
    applyCountryDefaults(); // picks per-country cover defaults until edited
    if (countryMode()) return; // browsing countries: the pin lookups alone, no tile calls
    runSample();
    runGreenspace();
  }

  // -------------------------------------------------------- 300 m rule loop

  let greenAbort = null;
  let greenRunId = 0;

  async function runGreenspace() {
    const runId = ++greenRunId;
    $('ruleDist').textContent = '–';
    $('ruleDist').title = '';
    $('ruleBadge').textContent = 'waiting';
    delete $('ruleBadge').dataset.color;
    $('ruleCard').classList.remove('pass', 'fail');

    if (greenAbort) greenAbort.abort();
    const controller = new AbortController();
    greenAbort = controller;

    try {
      const g = await Greenspace.compute(state.lat, state.lon, {
        minHa: state.greenMinHa,
        fetchTile,
        signal: controller.signal,
      });
      if (runId !== greenRunId) return;
      state.green = g;
      renderRule(g);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (runId !== greenRunId) return;
      $('ruleBadge').textContent = 'error';
      $('ruleDist').title = 'Could not measure: ' + (err && err.message ? err.message : err);
    }
  }

  function renderRule(g) {
    const badge = $('ruleBadge');
    let pass = false;
    let title = '';

    if (g.nearest) {
      pass = g.nearest.distM <= g.radius;
      $('ruleDist').textContent = fmtMeters(g.nearest.distM).replace(' ', '\u00A0');
      badge.textContent = pass ? 'within ' + g.radius + ' m' : 'beyond ' + g.radius + ' m';
      title = g.nearest.inside
        ? 'The pin is inside this green space; straight-line measure.'
        : 'Nearest green space: ' + fmtArea(g.nearest.areaM2) + ', straight-line from the pin.'
          + (g.within > 1 ? ' ' + g.within + ' qualifying spaces within ' + g.radius + ' m.' : '');
    } else {
      $('ruleDist').textContent = '>' + g.radius + '\u00A0m';
      badge.textContent = 'none within ' + g.radius + ' m';
      title = 'Nothing of at least ' + (g.minHa === 0.5 ? '0.5' : g.minHa) + ' ha within ' + g.radius + ' m of the pin.';
    }
    $('ruleDist').title = title;
    badge.dataset.color = pass ? 'success' : 'danger';
    $('ruleCard').classList.toggle('pass', pass);
    $('ruleCard').classList.toggle('fail', !pass);

    drawRule(g);
  }

  function drawRule(g) {
    if (!state.mapReady) return;
    const features = [];
    let pass = false;
    if (g.nearest && g.nearest.point && !g.nearest.inside) {
      pass = g.nearest.distM <= g.radius;
      features.push({
        type: 'Feature',
        properties: { kind: 'walk' },
        geometry: {
          type: 'LineString',
          coordinates: [[state.lon, state.lat], [g.nearest.point.lon, g.nearest.point.lat]],
        },
      });
    }
    map.getSource('rule300').setData({ type: 'FeatureCollection', features });
    map.setPaintProperty(
      'rule300-line',
      'line-color',
      pass ? '#16a34a' : '#dc2626',
    );
  }

  // ------------------------------------------------------------- sample loop

  let abortPrevious = null;
  let debounceTimer = null;

  function scheduleSample(delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSample, delay == null ? 120 : delay);
  }

  async function runSample() {
    const runId = ++state.runId;
    const square = buildSquare();
    drawSquare(square, null);
    setStatus('');
    $('countMeta').innerHTML = kvHTML([['Status', 'Sampling…']]);

    if (abortPrevious) abortPrevious.abort();
    const controller = new AbortController();
    abortPrevious = controller;

    try {
      const result = await C.compute(square, {
        selected: [...state.selected],
        fetchTile,
        signal: controller.signal,
        onProgress: (p) => {
          if (runId !== state.runId) return;
          $('countMeta').innerHTML = kvHTML([[
            'Status',
            p.phase === 'fetching'
              ? 'Fetching ' + p.tiles + ' tile' + (p.tiles > 1 ? 's' : '') + ' (z' + p.zoom + ')…'
              : 'Counting pixels…',
          ]]);
        },
      });
      if (runId !== state.runId) return;
      state.result = result;
      render(result);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (runId !== state.runId) return;
      const msg = err && err.message ? err.message : err;
      $('countMeta').innerHTML = kvHTML([['Status', 'Sampling failed: ' + msg]]);
      $('badge').textContent = 'error';
      $('badge').dataset.color = 'danger';
      $('resultCard').classList.remove('pass');
      $('resultCard').classList.add('fail');
    }
  }

  // ---------------------------------------------------------------- rendering

  function render(result) {
    const pct = result.percent;
    const pass = pct >= THRESHOLD;

    const card = $('resultCard');
    if (card) {
      card.classList.toggle('pass', pass);
      card.classList.toggle('fail', !pass);
    }

    $('bigPercent').textContent = pct.toFixed(1) + '%';
    const badge = $('badge');
    badge.textContent = pass ? 'meets ' + THRESHOLD + '%' : 'below ' + THRESHOLD + '%';
    badge.dataset.color = pass ? 'success' : 'danger';

    renderLegend(result, pass);
    renderCategories(result);

    const tiles = result.source.tiles.length;
    const scaleTag = result.square.kind === 'zoom'
      ? ZOOM_SCALES[result.square.zoom].tag
      : METER_SCALES[result.square.meters].tag;
    const rows = [
      ['Square', scaleTag + ' · ' + fmtArea(result.areaM2)],
      ['Covered', fmtArea(result.coveredAreaM2)],
      ['Tiles', tiles + ' at z' + result.source.zoom + result.source.note],
    ];
    if (result.empty) rows.push(['Note', 'no mapped green polygons here']);
    $('countMeta').innerHTML = kvHTML(rows);

    $('techMeta').textContent =
      'Sampled square: ' + result.rasterSize + '×' + result.rasterSize + ' pixels · ' +
      result.features + ' feature' + (result.features === 1 ? '' : 's') +
      ' · data z' + result.source.zoom + result.source.note +
      ' · ' + tiles + ' tile' + (tiles === 1 ? '' : 's') +
      ' · ' + Math.round(result.timing.totalMs) + ' ms';

    const names = $('parkNames');
    names.innerHTML = result.names.length
      ? '<p class="ds-paragraph">Protected areas here</p><div class="chips">' +
        result.names.slice(0, 12).map((n) => '<span class="ds-tag" data-variant="outline">' + escapeHtml(n) + '</span>').join('') +
        '</div>'
      : '';

    const preview = $('preview');
    const ctx = preview.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(result.preview, 0, 0, preview.width, preview.height);

    drawSquare(result.square, pass);
    drawSquareRaster(result);
    drawDataTiles(result.source.tiles);
  }

  function renderLegend(result, pass) {
    const rows = [...state.selected].map((id) => {
      const cat = C.CATEGORY_BY_ID.get(id);
      const value = result.byCategory[id] || 0;
      return (
        '<div class="legend-row">' +
        '<span class="legend-swatch" style="background:' + cat.color + '"></span>' +
        '<span class="legend-name">' + escapeHtml(cat.label) + '</span>' +
        '<span class="legend-pct">' + value.toFixed(1) + '%</span>' +
        '</div>'
      );
    });
    rows.push(
      '<div class="legend-row is-union">' +
      '<span class="legend-swatch" style="background:' + (pass ? '#16a34a' : '#dc2626') + '"></span>' +
      '<span class="legend-name">Covered together (overlaps counted once)</span>' +
      '<span class="legend-pct">' + result.percent.toFixed(1) + '%</span>' +
      '</div>',
    );
    $('previewLegend').innerHTML = rows.join('');
  }

  function renderCategories(result) {
    for (const cat of C.CATEGORIES) {
      const el = document.querySelector('.cat[data-id="' + cat.id + '"]');
      if (!el) continue;
      const on = state.selected.has(cat.id);
      el.classList.toggle('on', on);
      const pct = el.querySelector('.cat-pct');
      const value = on && result ? result.byCategory[cat.id] : null;
      if (value === null || value === undefined) {
        pct.hidden = true;
      } else {
        pct.textContent = value.toFixed(1) + '%';
        pct.hidden = false;
      }
    }
  }

  function updateSizeHint() {
    const scale = state.mode.charAt(0) === 'z'
      ? ZOOM_SCALES[Number(state.mode.slice(1))]
      : METER_SCALES[Number(state.mode.slice(1))];
    $('sizeHint').textContent = scale ? scale.hint : '';
  }

  function updateSizeLabels() {
    for (const opt of $('size').querySelectorAll('option[data-zoom]')) {
      const z = Number(opt.dataset.zoom);
      const side = C.squareFromZoom(state.lat, state.lon, z, true).sideMeters;
      opt.textContent = 'z' + z + ' · ' + fmtMeters(side) + ' · ' + ZOOM_SCALES[z].tag;
    }
  }

  function fmtMeters(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
  }

  function fmtArea(m2) {
    if (m2 >= 1000000) return (m2 / 1000000).toFixed(2) + ' km²';
    if (m2 >= 10000) return (m2 / 10000).toFixed(1) + ' ha';
    return Math.round(m2).toLocaleString() + ' m²';
  }

  /** Fixed label: value rows, so the stat block never changes shape. */
  function kvHTML(rows) {
    return rows.map(([k, v]) =>
      '<div class="kv-row"><span class="kv-k">' + k + '</span><span class="kv-v">' + v + '</span></div>').join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // The status pill is for transient operations and errors only; the results
  // live in the checklist cards, not echoed on the map.
  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    el.hidden = !text;
  }

  // --------------------------------------------------------------------- UI

  function buildUI() {
    const size = $('size');

    const zoomGroup = document.createElement('optgroup');
    zoomGroup.label = 'Zoom square (tile at that zoom)';
    for (const z of ZOOMS) {
      const opt = document.createElement('option');
      opt.value = 'z' + z;
      opt.dataset.zoom = String(z);
      zoomGroup.appendChild(opt);
    }
    size.appendChild(zoomGroup);

    const meterGroup = document.createElement('optgroup');
    meterGroup.label = 'Fixed size (centred on pin)';
    for (const m of METERS) {
      const opt = document.createElement('option');
      opt.value = 'm' + m;
      opt.textContent = m + ' m — ' + METER_SCALES[m].tag;
      meterGroup.appendChild(opt);
    }
    size.appendChild(meterGroup);
    size.value = state.mode;

    const cats = $('categories');
    for (const cat of C.CATEGORIES) {
      const on = state.selected.has(cat.id);
      const row = document.createElement('div');
      row.className = 'ds-field cat' + (on ? ' on' : '');
      row.dataset.id = cat.id;
      row.innerHTML =
        '<input class="ds-input" type="checkbox" id="cat-' + cat.id + '"' + (on ? ' checked' : '') + '>' +
        '<label class="ds-label" for="cat-' + cat.id + '">' + escapeHtml(cat.label) + '</label>' +
        '<span class="cat-pct" hidden></span>' +
        '<span class="cat-hint">' + escapeHtml(cat.hint) + '</span>';
      row.querySelector('input').addEventListener('change', (e) => {
        markCategoriesTouched();
        if (e.target.checked) state.selected.add(cat.id);
        else state.selected.delete(cat.id);
        row.classList.toggle('on', e.target.checked);
        if (!state.selected.size) {
          state.selected.add(cat.id);
          e.target.checked = true;
          row.classList.add('on');
          setStatus('Keep at least one category selected.', true);
          return;
        }
        scheduleSample(0);
      });
      cats.appendChild(row);
    }

    size.addEventListener('change', () => {
      state.mode = size.value;
      $('centerOnPin').disabled = state.mode.charAt(0) !== 'z';
      updateSizeHint();
      scheduleSample(0);
    });

    $('centerOnPin').addEventListener('change', () => scheduleSample(0));
    $('showDataTiles').addEventListener('change', () => syncZoomOverlays());
    $('showCountries').addEventListener('change', () => syncCountryOverlay());

    $('go').addEventListener('click', () => {
      const lat = Number($('lat').value);
      const lon = Number($('lon').value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        setPoint(lat, lon);
        // a typed coordinate can be far away; bring the map along so the square
        // and the rule line stay visible
        if (map) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14.6), duration: 900 });
      } else {
        setStatus('Latitude/longitude must be numbers.', true);
      }
    });

    // Enter inside the island's fields should move the pin, not reload the page.
    const form = $('locateForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        $('go').click();
      });
    }

    $('locate').addEventListener('click', () => {
      if (!navigator.geolocation) {
        setStatus('Geolocation is not available in this browser.', true);
        return;
      }
      setStatus('Asking the browser for your location…');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (map) map.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 15) });
          setPoint(pos.coords.latitude, pos.coords.longitude);
          setStatus('');
        },
        (err) => setStatus('Geolocation failed: ' + err.message, true),
        { enableHighAccuracy: false, timeout: 10000 },
      );
    });

    $('presetTrees').addEventListener('click', () => { markCategoriesTouched(); applyPreset(['parks', 'wood']); });
    $('presetGreen').addEventListener('click', () => {
      markCategoriesTouched();
      applyPreset(C.CATEGORIES.filter((c) => c.id !== 'farmland').map((c) => c.id));
    });

    // rule 3: the user's own answer, nothing to compute
    $('seeTrees').addEventListener('change', (e) => {
      const on = e.target.checked;
      $('treesCard').classList.toggle('pass', on);
      const b = $('treesBadge');
      b.textContent = on ? 'yes' : 'no';
      if (on) b.dataset.color = 'success';
      else delete b.dataset.color;
    });

    // rule 300: minimum patch size; tiles are cached so this re-runs fast
    $('gsMin').addEventListener('change', () => {
      state.greenMinHa = Number($('gsMin').value) || 1;
      runGreenspace();
    });
  }

  function applyPreset(ids) {
    state.selected = new Set(ids);
    for (const cat of C.CATEGORIES) {
      const el = document.querySelector('.cat[data-id="' + cat.id + '"]');
      el.querySelector('input').checked = state.selected.has(cat.id);
      el.classList.toggle('on', state.selected.has(cat.id));
    }
    scheduleSample(0);
  }

  // ------------------------------------------------- country-based defaults

  /** Set the cover checkboxes from the pin's country, unless the user has
   *  already picked their own set. */
  function applyCountryDefaults() {
    if (state.categoriesTouched) return;
    const id = typeof Country !== 'undefined' ? Country.find(state.lat, state.lon) : null;
    if (id === state.countryId) return;
    state.countryId = id;
    const profile = Country.profile(id);
    applyPreset(profile.ids);
    const note = $('profileNote');
    if (id) {
      note.textContent = Country.NAME_BY_ID[id] + ': ' + profile.note + ' Override below if you disagree.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  function markCategoriesTouched() {
    state.categoriesTouched = true;
    $('profileNote').hidden = true;
  }

  // ------------------------------------------- countries-by-profile overlay

  /** 2× signed area of a flat ring; > 0 = counter-clockwise (RFC 7946 outer). */
  function ringCCW(flat) {
    let a = 0;
    const n = flat.length;
    for (let i = 0; i < n - 2; i += 2) {
      a += flat[i] * flat[i + 3] - flat[i + 2] * flat[i + 1];
    }
    a += flat[n - 2] * flat[1] - flat[0] * flat[n - 1];
    return a > 0;
  }

  /** Reverse a flat ring's point order without swapping its lon/lat pairs. */
  function flipRing(flat) {
    const out = new Float64Array(flat.length);
    for (let i = 0, j = flat.length - 2; i < flat.length; i += 2, j -= 2) {
      out[i] = flat[j];
      out[i + 1] = flat[j + 1];
    }
    return out;
  }

  /** One polygon's rings (deltas) -> closed [ [lon, lat], ... ] rings, with
   *  the outer ring forced CCW: MapLibre's tiler drops CW outers. */
  function ringArrays(rings) {
    const flats = rings.map((deltas) => Country.ringPoints(deltas));
    if (!ringCCW(flats[0])) for (let r = 0; r < flats.length; r++) flats[r] = flipRing(flats[r]);
    return flats.map((flat) => {
      const ring = [];
      for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
      ring.push(ring[0]);
      return ring;
    });
  }

  /** FeatureCollection of the crude Natural Earth geometry, each feature
   *  tagged with the profile its defaults come from. */
  function buildCountryFC() {
    return {
      type: 'FeatureCollection',
      features: Country.COUNTRIES.map(([id, polys]) => ({
        type: 'Feature',
        properties: {
          iso: id,
          name: Country.NAME_BY_ID[id] || id,
          profile: Country.profile(id) === Country.PROFILES.treed ? 'treed' : 'base',
        },
        geometry: polys.length === 1
          ? {
              type: 'Polygon',
              // single polygon: coordinates are the rings themselves (an
              // extra polygon nesting level here is an invisible feature —
              // MapLibre just drops it)
              coordinates: ringArrays(polys[0]),
            }
          : {
              type: 'MultiPolygon',
              coordinates: polys.map(ringArrays),
            },
      })),
    };
  }

  /** Below COUNTRY_ZOOM the square is a dot and sampling is paused. */
  function countryMode() {
    return !!map && map.getZoom() < COUNTRY_ZOOM;
  }

  /** Show/hide the country overlay; the source is built on first enable.
   *  Visible only when the checkbox is on AND we are at country zoom. */
  function syncCountryOverlay() {
    if (!state.mapReady) return;
    const on = $('showCountries').checked && countryMode();
    if (on && !map.getSource('countries')) {
      map.addSource('countries', { type: 'geojson', data: buildCountryFC() });
      map.addLayer({
        id: 'country-fill',
        type: 'fill',
        source: 'countries',
        paint: {
          'fill-color': ['match', ['get', 'profile'], 'treed', '#16a34a', '#ea580c'],
          'fill-opacity': 0.3,
        },
      });
      map.addLayer({
        id: 'country-line',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': ['match', ['get', 'profile'], 'treed', '#16a34a', '#ea580c'],
          'line-width': 1.2,
          'line-opacity': 0.7,
        },
      });
    }
    const vis = on ? 'visible' : 'none';
    for (const id of ['country-fill', 'country-line']) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', vis);
      }
    }
  }

  /** Swap between city mode (square + rule line) and country mode (the
   *  profile overlay). Zooming back into city mode re-runs sampling for the
   *  current pin, so pausing at country level saves tile fetches. */
  let lastCountryMode = null;

  function syncZoomOverlays() {
    if (!state.mapReady) return;
    const cm = countryMode();
    const changed = cm !== lastCountryMode;
    lastCountryMode = cm;
    for (const id of ['square-casing', 'square-line', 'square-raster']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', cm ? 'none' : 'visible');
    }
    if (map.getLayer('rule300-line')) {
      map.setLayoutProperty('rule300-line', 'visibility', cm ? 'none' : 'visible');
    }
    if (map.getLayer('datatile-line')) {
      const show = $('showDataTiles').checked && !cm;
      map.setLayoutProperty('datatile-line', 'visibility', show ? 'visible' : 'none');
    }
    syncCountryOverlay();
    if (lastCountryMode === true && !cm) {
      // came back from a country browse: re-measure the pinned location
      scheduleSample(0);
      runGreenspace();
    }
  }

  // ------------------------------------------------------------------- boot

  // Remote-debugging hook: paste `__dshPage.report()` in the console.
  window.__dshPage = {
    state,
    mapDiag,
    get map() { return map; },
    report: () =>
      JSON.stringify(
        {
          url: location.href,
          protocol: location.protocol,
          ua: navigator.userAgent,
          webgl2: mapDiag.webgl2,
          mapCreated: mapDiag.created,
          styleLoaded: mapDiag.styleLoaded,
          tiles: mapDiag.tiles,
          errors: mapDiag.errors,
          percent: state.result ? +state.result.percent.toFixed(2) : null,
          note: $('mapNote') && !$('mapNote').hidden ? $('mapNote').textContent : null,
        },
        null,
        1,
      ),
  };

  buildUI();
  applyCountryDefaults(); // preselects the country's profile; its preset schedules the first sample
  updateSizeLabels();
  updateSizeHint();
  $('centerOnPin').disabled = state.mode.charAt(0) !== 'z';
  initMap();
  // The sample run is scheduled by applyCountryDefaults above; the 300 m
  // loop shares the tile cache, so start it directly.
  runGreenspace();
})();