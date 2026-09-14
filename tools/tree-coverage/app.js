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
    lat: 52.35813,
    lon: 4.86865,
    mode: 'z16',
    threshold: 30,
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
    if (cached) return cached;

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
      map.addSource('square', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'square-casing',
        type: 'line',
        source: 'square',
        paint: { 'line-color': '#ffffff', 'line-width': 4.5, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'square-fill',
        type: 'fill',
        source: 'square',
        paint: { 'fill-color': '#16a34a', 'fill-opacity': 0.2 },
      });
      map.addLayer({
        id: 'square-line',
        type: 'line',
        source: 'square',
        paint: { 'line-color': '#15803d', 'line-width': 2.5, 'line-dasharray': [3, 2] },
      });

      map.addSource('dataTiles', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'datatile-line',
        type: 'line',
        source: 'dataTiles',
        layout: { visibility: $('showDataTiles').checked ? 'visible' : 'none' },
        paint: { 'line-color': '#0ea5e9', 'line-width': 1.1, 'line-dasharray': [1, 2] },
      });

      state.mapReady = true;
      if (state.pendingSquare) drawSquare(state.pendingSquare.square, state.pendingSquare.pass);
      if (state.result) {
        const pass = state.result.percent >= state.threshold;
        drawSquare(state.result.square, pass);
        drawDataTiles(state.result.source.tiles);
      }
    });
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

  function drawSquare(square, pass) {
    if (!state.mapReady) {
      state.pendingSquare = { square, pass };
      return;
    }
    const color = pass === null ? '#64748b' : pass ? '#16a34a' : '#dc2626';
    map.getSource('square').setData(rectFeature(square.rect));
    map.setPaintProperty('square-fill', 'fill-color', color);
    map.setPaintProperty('square-line', 'line-color', color);
    state.pendingSquare = null;
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
    runSample();
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
    updateSquareMeta(square);
    setStatus('Sampling ' + describeSquare(square) + '…');

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
          setStatus(
            p.phase === 'fetching'
              ? 'Fetching ' + p.tiles + ' tile' + (p.tiles > 1 ? 's' : '') + ' (z' + p.zoom + ')…'
              : 'Counting pixels…',
          );
        },
      });
      if (runId !== state.runId) return;
      state.result = result;
      render(result);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (runId !== state.runId) return;
      setStatus('Sampling failed: ' + (err && err.message ? err.message : err), true);
      $('badge').textContent = 'error';
      $('badge').className = 'badge fail';
    }
  }

  // ---------------------------------------------------------------- rendering

  function render(result) {
    const threshold = state.threshold;
    const pct = result.percent;
    const pass = pct >= threshold;

    const card = $('resultCard');
    if (card) {
      card.classList.toggle('pass', pass);
      card.classList.toggle('fail', !pass);
    }

    $('bigPercent').textContent = pct.toFixed(1) + '%';
    const badge = $('badge');
    badge.textContent = pass ? 'meets ' + threshold + '%' : 'below ' + threshold + '%';
    badge.dataset.color = pass ? 'success' : 'danger';

    renderLegend(result, pass);
    renderCategories(result);

    const tiles = result.source.tiles.length;
    $('resultMeta').innerHTML =
      '<strong>' + fmtArea(result.coveredAreaM2) + '</strong> of ' + fmtArea(result.areaM2) + ' counted';

    if (result.empty) {
      $('resultMeta').innerHTML += ' — no mapped green polygons here.';
    }

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
    drawDataTiles(result.source.tiles);

    setStatus((pass ? '✓ ' : '✕ ') + pct.toFixed(1) + '% cover');
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

  function updateSquareMeta(square) {
    $('squareMeta').textContent = describeSquare(square) + ' · ' + fmtArea(square.areaM2);
  }

  function describeSquare(square) {
    const scale = square.kind === 'zoom' ? ZOOM_SCALES[square.zoom] : METER_SCALES[square.meters];
    const side = square.kind === 'zoom'
      ? 'z' + square.zoom + ' square' + (square.centered ? ' (centred)' : ' (grid tile' + (square.tile ? ' ' + square.tile.z + '/' + square.tile.x + '/' + square.tile.y : '') + ')')
      : square.meters + ' m square (centred)';
    return side + ' · ≈' + fmtMeters(square.sideMeters) + ' across' + (scale ? ' · ' + scale.tag : '');
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
      opt.textContent = 'z' + z + ' · ' + fmtMeters(side) + ' — ' + ZOOM_SCALES[z].tag;
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
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
    $('showDataTiles').addEventListener('change', () => {
      if (state.mapReady) {
        map.setLayoutProperty('datatile-line', 'visibility', $('showDataTiles').checked ? 'visible' : 'none');
      }
    });

    $('threshold').addEventListener('input', () => {
      const v = Number($('threshold').value);
      state.threshold = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 30;
      if (state.result) render(state.result);
    });

    $('go').addEventListener('click', () => {
      const lat = Number($('lat').value);
      const lon = Number($('lon').value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) setPoint(lat, lon);
      else setStatus('Latitude/longitude must be numbers.', true);
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
        },
        (err) => setStatus('Geolocation failed: ' + err.message, true),
        { enableHighAccuracy: false, timeout: 10000 },
      );
    });

    $('presetTrees').addEventListener('click', () => applyPreset(['parks', 'wood']));
    $('presetGreen').addEventListener('click', () =>
      applyPreset(C.CATEGORIES.filter((c) => c.id !== 'farmland').map((c) => c.id)));
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

  // ------------------------------------------------------------------- boot

  // Remote-debugging hook: paste `__dshPage.report()` in the console.
  window.__dshPage = {
    state,
    mapDiag,
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
  updateSizeLabels();
  updateSizeHint();
  $('centerOnPin').disabled = state.mode.charAt(0) !== 'z';
  initMap();
  // Sampling does not depend on the map, so start it straight away.
  runSample();
})();