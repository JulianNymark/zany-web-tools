/* Bus stop golf: map, leaderboard, pick-two explorer, live position.
   Plain script (no modules) so it also runs from file://.
   Globals DATA, PAIRS, ADJ, POS come from data.js. */

const RANK_POOL = 30; // "you are close to" hunts among the 30 shortest pairs
const RUTER_RED = '#E60000'; // official Ruter city-network colour
const CITY_VIEW = L.latLngBounds([59.892, 10.62], [59.95, 10.88]); // Frogner to Økern-ish

const map = L.map('map', { zoomControl: false }).setView([59.92, 10.75], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);
map.fitBounds(CITY_VIEW, { maxZoom: 13 });

// vectors get transform-scaled mid-zoom (pixelated): hide while zooming, fade back
// hide vectors only during *programmatic* zooms; transform-scaling mid-flight
// looks pixelated. Manual wheel/pinch zoom keeps them visible.
let autoZoom = false;
const fly = (fn) => { autoZoom = true; fn(); };
map.on('zoomstart', () => { if (autoZoom) map.getContainer().classList.add('zooming'); });
map.on('zoomend', () => { autoZoom = false; map.getContainer().classList.remove('zooming'); });
['zoomIn', 'zoomOut'].forEach((name) => { // +/− buttons count as button presses
  const orig = map[name].bind(map);
  map[name] = (...args) => { autoZoom = true; orig(...args); };
});

// DOM-icon stop dot, like the custom-icons demo: translate-only during zoom,
// constant size (SVG circleMarkers stretch/balloon mid-zoom instead)
const stopIcon = () => L.divIcon({ className: '', html: '<div class="stop-dot"></div>', iconSize: [15, 15], iconAnchor: [7.5, 7.5] });

const list = document.getElementById('list');
const A = document.getElementById('stopA');
const B = document.getElementById('stopB');
const verdict = document.getElementById('verdict');
const nearcard = document.getElementById('nearcard');
const locBtn = document.getElementById('locme');

/* ---------------------------------------------------------- leaderboard */

const lines = [];

// shared floating popup: anchored above the leg's bounding box, no tail
const routePop = L.popup({ className: 'route-pop-float', autoPan: false, closeButton: true, offset: [0, 2] });

function routePopup(rank, from, to, line, len) {
  return `
    <div class="route-pop">
      <div class="route-pop__rank">#${rank}</div>
      <div class="route-pop__names">${from}<br><span class="dir">↳</span> ${to}</div>
      <div class="route-pop__meta">
        <span class="line-badge">${line}</span>
        <b>${Math.round(len)} meters</b>
      </div>
    </div>`;
}

DATA.forEach((d, i) => {
  const pl = L.polyline(d.coords, { color: RUTER_RED, weight: 6, opacity: 0.9 }).addTo(map);
  pl.on('click', () => select(i));
  lines.push(pl);
  // stop dots: one click handler = one behaviour, identical to clicking the path.
  // (No bound popup: the floating popover is the single source of route info.)
  L.marker(d.fromPos, { icon: stopIcon() }).addTo(map).on('click', () => select(i));
  L.marker(d.toPos, { icon: stopIcon() }).addTo(map).on('click', () => select(i));
});

function select(vi) {
  activeIdx = vi;
  document.querySelectorAll('.leg').forEach((e) => e.classList.toggle('active', +e.dataset.vi === vi));
  [...document.querySelectorAll('.leg')].find((e) => +e.dataset.vi === vi)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const v = view[vi];
  let bb, content;
  if (v.d) { // top-30 shortest entry: its polyline lives permanently on the map
    bb = lines[vi].getBounds(); // exact endpoints, no margin
    lines.forEach((pl, j) => pl.setStyle({ weight: j === vi ? 10 : 4, opacity: j === vi ? 1 : 0.3 }));
    content = routePopup(v.rank, v.d.from, v.d.to, v.d.line, v.d.length);
  } else { // top-30 longest entry: draw it on demand, dim the permanent set
    const [a, b, code, len, coords, fn, tn] = v.p;
    custom.clearLayers();
    const pl = L.polyline(coords, { color: RUTER_RED, weight: 10, opacity: 0.95 }).addTo(custom);
    bb = pl.getBounds();
    lines.forEach((pl) => pl.setStyle({ weight: 4, opacity: 0.15 }));
    content = routePopup(v.rank, fn, tn, code, len);
  }
  fly(() => map.flyToBounds(bb.pad(0.25), { duration: 0.7, maxZoom: 17 }));
  // popup floats just above the true bounding box of the two stops
  const topCenter = L.latLng(bb.getNorth(), (bb.getEast() + bb.getWest()) / 2);
  routePop.setLatLng(topCenter).setContent(content);
  clearTimeout(popTimer);
  popTimer = setTimeout(() => routePop.openOn(map), 750); // after fly-in
  verdict.innerHTML = '';
}

let desc = false;
let activeIdx = null;
let view = [];

function buildList() {
  view = desc
    ? PAIRS.slice(-30).reverse().map((p) => ({ p, rank: PAIRS.indexOf(p) + 1 }))
    : DATA.map((d) => ({ d, rank: d.rank }));
  list.innerHTML = '';
  view.forEach((v, vi) => {
    const from = v.d ? v.d.from : v.p[5];
    const to = v.d ? v.d.to : v.p[6];
    const line = v.d ? v.d.line : v.p[2];
    const len = v.d ? v.d.length : v.p[3];
    const li = document.createElement('li');
    li.className = 'leg' + (vi === activeIdx ? ' active' : '');
    li.dataset.vi = vi;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.innerHTML = `
      <span class="rank">#${v.rank}</span>
      <span class="body">
        <span class="stop" title="${from}">${from}</span>
        <span class="stop" title="${to}"><span class="dir">↳</span> ${to}</span>
      </span>
      <span class="dist" title="${Math.round(len)} meters along the drive path"><span class="num">${Math.round(len)}&hairsp;<small>m</small></span><span class="line-badge" title="Line number ${line}">${line}</span></span>`;
    li.onclick = () => select(vi);
    li.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(vi); }
    };
    list.appendChild(li);
  });
}
buildList();

document.getElementById('sortToggle').onclick = (e) => {
  desc = !desc;
  activeIdx = null;
  e.currentTarget.textContent = desc ? 'Show shortest' : 'Show longest';
  e.currentTarget.setAttribute('aria-pressed', String(desc)); // state via AT, label stays a command
  routePop.close();
  custom.clearLayers();
  lines.forEach((pl) => pl.setStyle({ weight: 6, opacity: 0.9 }));
  buildList();
};

/* -------------------------------------------------------- pick-two game */

const custom = L.layerGroup().addTo(map);
let popTimer = null;
let pickA = null;
let pickB = null;

Object.keys(POS).sort((a, b) => a.localeCompare(b, 'nb')).forEach((n) => A.add(new Option(n, n)));
B.disabled = true;
B.add(new Option('Pick stop A first', ''));

A.addEventListener('change', () => {
  pickA = A.value || null;
  B.innerHTML = '';
  B.disabled = !pickA;
  if (!pickA) {
    B.add(new Option('Pick stop A first', ''));
    verdict.innerHTML = '';
    custom.clearLayers();
    return;
  }
  const nb = (ADJ[pickA] || []).sort((a, b) => a.localeCompare(b, 'nb'));
  B.add(new Option(nb.length ? `${nb.length} neighbouring stop${nb.length > 1 ? 's' : ''}` : 'No neighbours', ''));
  nb.forEach((n) => B.add(new Option(n, n)));
  verdict.innerHTML = '';
  custom.clearLayers();
});

B.addEventListener('change', () => {
  pickB = B.value || null;
  if (pickB) check();
});

function check() {
  if (!pickA || !pickB) return;
  custom.clearLayers();
  const pair = PAIRS.find((p) => (p[0] === pickA && p[1] === pickB) || (p[1] === pickA && p[0] === pickB));
  const pa = POS[pickA];
  const pb = POS[pickB];
  if (pair) {
    const [f, t, line, len, coords, fromName, toName] = pair;
    const idx = PAIRS.indexOf(pair);
    verdict.innerHTML = `
      <div class="big">${len} m</div>
      <div class="sub2">${fromName} &rarr; ${toName} on <span class="line-badge">${line}</span> is
        <b>#${idx + 1}</b> of ${PAIRS.length.toLocaleString('en')} stop pairs</div>
      <div class="walk">Closer than ${pct(idx)}% of all pairs.</div>`;
    L.polyline(coords, { color: RUTER_RED, weight: 8, opacity: 0.95 }).addTo(custom);
    fly(() => map.flyToBounds(L.latLngBounds(coords).pad(1.5), { duration: 0.7, maxZoom: 17 }));
  } else {
    verdict.innerHTML = `
      <div class="big">${Math.round(dist(pa, pb))} m</div>
      <div class="sub2">Straight line: <b>${pickA}</b> and <b>${pickB}</b> are not consecutive stops on any line</div>
      <div class="walk">Pick stop A first; stop B then offers only its connected stops.</div>`;
    L.polyline([pa, pb], { color: '#999', weight: 5, dashArray: '4 8' }).addTo(custom);
    fly(() => map.flyToBounds(L.latLngBounds([pa, pb]).pad(1.5), { duration: 0.7, maxZoom: 17 }));
  }
}

function pct(idx) {
  const better = ((PAIRS.length - idx) / PAIRS.length) * 100;
  return better < 1 ? better.toFixed(1) : better.toFixed(0);
}

function dist(a, b) {
  const R = 6371000;
  const dLa = ((b[0] - a[0]) * Math.PI) / 180;
  const dLo = ((b[1] - a[1]) * Math.PI) / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ------------------------------------------- "where am I" live tracking */

const meLayer = L.layerGroup().addTo(map);
let watchId = null;
let haveFirstFix = false;

function bearing(a, b) {
  const f1 = (a[0] * Math.PI) / 180;
  const f2 = (b[0] * Math.PI) / 180;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) / 45) % 8];
}

function setUser(lat, lng) {
  meLayer.clearLayers();
  const me = [lat, lng];
  const icon = L.divIcon({ className: '', html: '<div class="me-pulse"></div>', iconSize: [15, 15], iconAnchor: [7.5, 7.5] });
  L.marker(me, { icon, zIndexOffset: 1000 }).addTo(meLayer).bindPopup('You are here');
  if (!haveFirstFix) {
    haveFirstFix = true;
    fly(() => map.flyTo(me, 15, { duration: 0.8 })); // zoom to the user first
  }

  let best = null;
  PAIRS.slice(0, RANK_POOL).forEach((p, idx) => {
    const eA = p[4][0];
    const eB = p[4][p[4].length - 1];
    const dA = dist(me, eA);
    const dB = dist(me, eB);
    const d = Math.min(dA, dB);
    if (!best || d < best.d) best = { d, idx, p, end: dA <= dB ? 0 : 1, dEnd: Math.min(dA, dB) };
  });

  if (best.dEnd <= 100) {
    const [a, b, line, len, coords, fromName, toName] = best.p;
    const stopName = best.end === 0 ? fromName : toName;
    const otherName = best.end === 0 ? toName : fromName;
    const sp = coords[0];
    const op = coords[coords.length - 1];
    const target = best.end === 0 ? sp : op;
    L.polyline([me, target], { color: '#1668c1', weight: 5, dashArray: '2 8', opacity: 0.9 }).addTo(meLayer);
    nearcard.hidden = false;
    nearcard.innerHTML = `
      <div class="big">You're ${Math.round(best.dEnd)} m from a really short pair!</div>
      <div class="sub2">${stopName} &harr; ${otherName} <span class="line-badge">${line}</span>
        is <b>#${best.idx + 1}</b> at <b>${len} m</b></div>
      <div class="walk">🚶 Head ${bearing(me, target)}!</div>`;
    L.polyline(coords, { color: RUTER_RED, weight: 6, opacity: 0.9 }).addTo(meLayer);
    [[sp, stopName], [op, otherName]].forEach(([p]) =>
      L.marker(p, { icon: stopIcon() }).addTo(meLayer)); // route info lives in the nearcard
    fly(() => map.flyToBounds(L.latLngBounds([me, sp, op]).pad(1.5), { duration: 0.7, maxZoom: 17 }));
  } else {
    nearcard.hidden = true;
  }
}

locBtn.onclick = () => {
  if (!navigator.geolocation) {
    locBtn.textContent = '📍 Geolocation unavailable';
    return;
  }
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    haveFirstFix = false;
    locBtn.textContent = '📍 Track my position';
    nearcard.hidden = true;
    meLayer.clearLayers();
    return;
  }
  nearcard.hidden = false;
  nearcard.innerHTML = '<div class="sub2">Locating…</div>';
  watchId = navigator.geolocation.watchPosition(
    (pos) => setUser(pos.coords.latitude, pos.coords.longitude),
    () => {
      nearcard.innerHTML = '<div class="sub2">📍 Geolocation blocked. Allow location and serve over HTTPS.</div>';
    },
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  locBtn.textContent = '⏸ Stop tracking';
};

document.getElementById('pairCount').textContent = `${PAIRS.length.toLocaleString('en')} pairs`;
document.getElementById('pairStats').textContent = `${PAIRS.length.toLocaleString('en')} across ${Object.keys(POS).length.toLocaleString('en')} stops`;

// fun fact: the size of the shipped path data (UTF-8 bytes of the pair geometry)
document.getElementById('dataSize').textContent =
  `~${Math.round(new Blob([JSON.stringify(PAIRS)]).size / 1024).toLocaleString('en')} KB`;
