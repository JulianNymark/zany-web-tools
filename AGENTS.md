# Agent notes

Read [DESIGN.md](DESIGN.md) before adding or changing a page — it holds the page
shell, the Designsystemet component list (verified against the vendored version),
the rules and a checklist.

- Static only. No build step, no framework, no `npm install`. Vendored CSS/JS in
  `assets/vendor/` is pinned; don't edit it.
- One folder per tool under `tools/<kebab-name>/`, entry point `index.html`.
- Relative paths only — the site is served from `/<repo>/` on GitHub Pages.
- Answer first, caveats inside a `<details class="ds-details">` at the bottom.
- Register a new tool with a card on the hub `index.html`.
- Verify before calling it done: serve locally and screenshot it. In a
  cplt-sandboxed DSH session use the `browser-playwright` skill — `file://` can
  break map web workers, which shows up as a blank map.

## Lessons learned (busstop-golf, 2026-09)

- **Leaflet zoom scaling**: during zoom animations Leaflet transform-scales the
  SVG overlay pane — polylines stretch, `circleMarker`s balloon into blobs at
  large zoom deltas. DOM icons (`L.marker` + `divIcon`) move translate-only and
  keep their size. So: dots/positions = DOM markers, never circleMarkers; and
  for programmatic multi-level flights, fade the overlay pane out on
  `zoomstart` and back on `zoomend` (manual wheel zoom stays visible — 1-level
  steps scale only 2×, same as the official demos).
- **Entur data traps**: `pointsOnLink.length` is a placeholder (2.0 m for
  everything) — decode the polyline and sum haversine segments instead.
  A quay is not a stop place: direction-true quays can sit a block apart, so
  anchor dots/labels to the geometry's own endpoints, never to a stop-place
  centroid.
- **Route-line colours**: fetch `line.presentation.colour` from the API
  instead of guessing brand colours (Ruter: `E60000` city, `76A300` regional).
- **Buttons: command vs state (NN/g)**: a button that performs an action is
  labelled with the *action it will perform* ("Longest first ↓"), not the
  current state; the state goes in `aria-pressed` (and a pressed style). Don't
  mix state into the command label.
- **Numeric sanity checks**: when an API returns both a claimed metric and the
  raw data (length + polyline), diff them pairwise before trusting the metric.