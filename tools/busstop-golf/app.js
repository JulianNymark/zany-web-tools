/* Bus stop golf — map, leaderboard, pick-two game, live position.
   Plain script (no modules) so it also runs from file://.
   Globals DATA, PAIRS, ADJ, POS come from data.js. */

const RANK_POOL = 30; // "you are close to" hunts among the 30 shortest pairs
const map = L.map('map', { zoomControl: false }).setView([59.915, 10.76], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const col = (i) => `hsl(${(i * 47) % 360} 72% 42%)`; // 30 distinct hues
const list = document.getElementById('list');
const A = document.getElementById('stopA');
const B = document.getElementById('stopB');
const verdict = document.getElementById('verdict');
const nearcard = document.getElementById('nearcard');
const locBtn = document.getElementById('locme');

/* ---------------------------------------------------------- leaderboard */

const lines = [];
const markers = [];

DATA.forEach((d, i) => {
  const c = col(i);
  const pl = L.polyline(d.coords, { color: c, weight: 6, opacity: 0.9 })
    .addTo(map)
    .bindTooltip(`#${d.rank}  ${d.from} &rarr; ${d.to} — ${Math.round(d.length)} m`, { sticky: true });
  lines.push(pl);
  const mk = (p, txt) =>
    L.circleMarker(p, { radius: 7, color: '#fff', weight: 3, fillColor: c, fillOpacity: 1 })
      .addTo(map)
      .bindPopup(txt);
  markers.push([mk(d.fromPos, `#${d.rank} <b>${d.from}</b> [${d.line}]`), mk(d.toPos, `#${d.rank} <b>${d.to}</b> [${d.line}]`)]);
});

function select(i) {
  document.querySelectorAll('.leg').forEach((e, j) => e.classList.toggle('active', j === i));
  document.querySelectorAll('.leg')[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  map.flyToBounds(lines[i].getBounds().pad(1.2), { duration: 0.7, maxZoom: 17 });
  lines.forEach((pl, j) => pl.setStyle({ weight: j === i ? 10 : 5, opacity: j === i ? 1 : 0.35 }));
  markers.forEach((ms, j) => ms.forEach((m) => m.setStyle({ fillOpacity: j === i ? 1 : 0.35, radius: j === i ? 9 : 6 })));
  custom.clearLayers();
  verdict.innerHTML = '';
}

DATA.forEach((d, i) => {
  const li = document.createElement('li');
  li.className = 'leg';
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.innerHTML = `
    <span class="rank">${d.rank}</span>
    <span class="body">
      <span class="name">${d.from} &rarr; ${d.to}</span>
      <span class="meta"><span class="line-badge">${d.line}</span> two stops in a row</span>
    </span>
    <span class="dist">${Math.round(d.length)}<small>METERS</small></span>`;
  li.onclick = () => select(i);
  li.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); }
  };
  list.appendChild(li);
});

/* -------------------------------------------------------- pick-two game */

const custom = L.layerGroup().addTo(map);
let pickA = null;
let pickB = null;

Object.keys(POS).sort((a, b) => a.localeCompare(b, 'nb')).forEach((n) => A.add(new Option(n, n)));
B.disabled = true;
B.add(new Option('— pick stop A first —', ''));

A.addEventListener('change', () => {
  pickA = A.value || null;
  B.innerHTML = '';
  B.disabled = !pickA;
  if (!pickA) {
    B.add(new Option('— pick stop A first —', ''));
    verdict.innerHTML = '';
    custom.clearLayers();
    return;
  }
  const nb = (ADJ[pickA] || []).sort((a, b) => a.localeCompare(b, 'nb'));
  B.add(new Option(nb.length ? `— ${nb.length} neighbouring stop${nb.length > 1 ? 's' : ''} —` : '— no neighbours —', ''));
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
    const eA = coords[0];
    const eB = coords[coords.length - 1]; // quay-level, direction-true
    verdict.innerHTML = `
      <div class="big">${len} m</div>
      <div class="sub2">${f} &harr; ${t} on line <span class="line-badge">${line}</span> is
        <b>#${idx + 1}</b> of ${PAIRS.length.toLocaleString('en')} stop pairs</div>
      <div class="walk">Closer than ${pct(idx)}% of all pairs.</div>`;
    const c = col(idx);
    L.polyline(coords, { color: c, weight: 8, opacity: 0.95 }).addTo(custom);
    [[eA, fromName], [eB, toName]].forEach(([p, n]) =>
      L.circleMarker(p, { radius: 9, color: '#fff', weight: 3, fillColor: c, fillOpacity: 1 }).addTo(custom).bindPopup(n));
    map.flyToBounds(L.latLngBounds(coords).pad(1.5), { duration: 0.7, maxZoom: 17 });
  } else {
    verdict.innerHTML = `
      <div class="big">${Math.round(dist(pa, pb))} m</div>
      <div class="sub2">Straight line — <b>${pickA}</b> and <b>${pickB}</b> are not consecutive stops on any line</div>
      <div class="walk">Pick stop A first; stop B then offers only its connected stops.</div>`;
    L.polyline([pa, pb], { color: '#999', weight: 5, dashArray: '4 8' }).addTo(custom);
    map.flyToBounds(L.latLngBounds([pa, pb]).pad(1.5), { duration: 0.7, maxZoom: 17 });
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

/* ------------------------------------------- "where am I" — live tracking */

const meLayer = L.layerGroup().addTo(map);
let watchId = null;

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

  let best = null;
  PAIRS.slice(0, RANK_POOL).forEach((p, idx) => {
    const eA = p[4][0];
    const eB = p[4][p[4].length - 1];
    const dA = dist(me, eA);
    const dB = dist(me, eB);
    const d = Math.min(dA, dB);
    if (!best || d < best.d) best = { d, idx, p, end: dA <= dB ? 0 : 1, dEnd: Math.min(dA, dB) };
  });

  const [a, b, line, len, coords, fromName, toName] = best.p;
  const stopName = best.end === 0 ? fromName : toName;
  const otherName = best.end === 0 ? toName : fromName;
  const sp = coords[0];
  const op = coords[coords.length - 1];
  const target = best.end === 0 ? sp : op;

  if (best.dEnd <= 100) {
    L.polyline([me, target], { color: '#1668c1', weight: 5, dashArray: '2 8', opacity: 0.9 }).addTo(meLayer);
    nearcard.hidden = false;
    nearcard.innerHTML = `
      <div class="big">You're ${Math.round(best.dEnd)} m from a really short bus stop pair!</div>
      <div class="sub2">${stopName} &harr; ${otherName} <span class="line-badge">${line}</span>
        is <b>#${best.idx + 1}</b> shortest of ${PAIRS.length} (top-${RANK_POOL} hunt) — at <b>${len} m</b></div>
      <div class="walk">🚶 ${stopName} is right there — head ${bearing(me, target)}!</div>`;
    map.flyToBounds(L.latLngBounds([me, sp, op]).pad(1.5), { duration: 0.7, maxZoom: 17 });
    L.polyline(coords, { color: col(best.idx), weight: 6, opacity: 0.9 }).addTo(meLayer);
    [[sp, stopName], [op, otherName]].forEach(([p, n]) =>
      L.circleMarker(p, { radius: 8, color: '#fff', weight: 3, fillColor: col(best.idx), fillOpacity: 1 }).addTo(meLayer).bindPopup(n));
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
    locBtn.textContent = '📍 Track my position';
    nearcard.hidden = true;
    return;
  }
  nearcard.hidden = false;
  nearcard.innerHTML = '<div class="sub2">Locating…</div>';
  watchId = navigator.geolocation.watchPosition(
    (pos) => setUser(pos.coords.latitude, pos.coords.longitude),
    () => {
      nearcard.innerHTML = '<div class="sub2">📍 Geolocation blocked — allow location and serve over HTTPS.</div>';
    },
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  locBtn.textContent = '⏸ Stop tracking';
};

select(0);
