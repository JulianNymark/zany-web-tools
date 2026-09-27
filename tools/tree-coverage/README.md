# Park & tree coverage sampler

Drop a pin and check the [3-30-300 rule](https://www.treesforcities.org/resources/growing-urban-forests-the-3-30-300-rule)
for that spot, one card per rule in the sidebar:

- **3**: yours to answer. Tick the checkbox if 3 mature trees are visible from
  where you stand.
- **30**: what share of the sampled square is parks and woodland. The square
  turns green when coverage reaches the threshold (30% by default).
- **300**: straight-line distance from the pin to the nearest public green
  space, with the 300 m circle and the nearest patch drawn on the map.

Open it at [`tools/tree-coverage/`](.) on the site, or run the repo locally
(see the [root README](../../README.md)).

## How it works

1. The square is a rectangle in web-Mercator world coordinates — either the
   slippy tile at a chosen zoom, or a fixed size centred on the pin.
2. The vector tiles covering it are fetched (data zoom capped at **z14**, the
   planet maxzoom of the tileset), decoded by `mvt.js`, and the polygons of the
   selected categories are drawn into one offscreen 1024×1024 canvas per
   category.
3. Canvas clipping and the even-odd fill rule handle tile-edge clipping, holes
   and multipolygons; then pixels are counted per category plus a **union**
   (overlaps counted once), and pixel share becomes area share.

No build step, no framework, no API key. The design system CSS and MapLibre are
vendored in `assets/vendor/`.

## Categories

| Category | What it matches |
|---|---|
| Parks & protected areas | `landcover` subclass `park` (where `leisure=park` ends up) + polygons from the `park` layer (national parks, nature reserves, protected areas) |
| Woods & forest | `landcover` class `wood` |
| Grass & meadows | `landcover` class `grass` (lawns, verges, meadows, recreation grounds) |
| Gardens & allotments | `garden`, `allotments`, `orchard`, `vineyard`, `flowerbed` |
| Scrub, heath & wetland | `natural` scrub/heath, wetland, dunes, rock |
| Sports & urban green | `landuse` pitch, playground, cemetery, zoo, theme park |
| Farmland | `landcover` class `farmland` |

Default is **parks + woods**, the closest available proxy for tree cover. The
headline number is the union, so a wood inside a park counts once.

## The 300 rule

`greenspace.js` measures the walk-to-green number:

1. A 600 m box is centred on the pin (the inscribed circle is the rule's
   300 m radius) and its z14 vector tiles are fetched and decoded.
2. The qualifying categories (parks, woods, grass, gardens, sports and urban
   green, scrub/wetland; **not farmland**, it is private) are rasterised into
   one union mask at 512×512.
3. The mask is split into 4-connected patches, so a park split across tile
   edges still counts as one. Each patch gets an area (pixels × ground
   pixel size) and a straight-line distance from the pin (0 when the pin is
   inside it).
4. A patch qualifies when its area is at least the selected minimum:
   **1 ha** (WHO 2017, Konijnendijk 2023) or **0.5 ha** (the Browning et al.
   2024 methods review). The card shows the nearest qualifying distance.
5. On the map the rule is one binary indicator, always on: a connector line
   from the pin to the start of the nearest qualifying green space, green
   when it is within 300 m and red when it is beyond (no line when the pin
   is inside a green space, or when none of at least the chosen size exists
   in the 600 m search box). The sampled square itself is drawn with the
   counted categories' own colours, the same palette as the sidebar preview.

Limits: straight-line only (the rule's authors specify walking distance),
"high-quality" cannot be judged from OSM polygons, and the usual z14 caveats
apply. Farmland is excluded but e.g. a golf course counts as urban green.

## Data and limits

- Tiles: [OpenFreeMap](https://openfreemap.org/) ([OpenMapTiles schema](https://openmaptiles.org/schema/)), map data © OpenStreetMap contributors.
- **No canopy layer exists.** A park counts as fully covered, so *parks + woods*
  is an optimistic upper bound and *woods alone* the conservative tree-only
  number. A mostly-lawn park is over-counted.
- Individual street trees are not in the data at all.
- Data stops at zoom 14, so a z16/z18 square is overzoomed z14 geometry and
  small patches disappear.
- Marine protected areas are in the `park` layer, so a point at sea can score
  "parks".

## Square sizes

There is no official "neighbourhood" size. The presets cover both readings used
in the literature ([Browning et al. 2024](https://doi.org/10.1016/j.scitotenv.2023.167739)):

- **Zoom squares** (allocentric / statistical): `z15` ~750 m = neighbourhood
  (Perry's 160-acre unit), `z16` ~375 m = 5-minute walk, `z14` ~1.5 km =
  statistical area (Dutch CBS *buurt* average), `z13` = district, `z17` = block,
  `z18` = plot.
- **Fixed buffers** (egocentric): `530 m` = same area as a 300 m-radius circle,
  `600 m` = the pin is 300 m from each edge.

## Per-country cover defaults

"What counts as cover" is preselected from where the pin lands (`countries.js`),
until the user touches the checkboxes or presets:

- **Global default (best fit, most of the time):** parks + woods.
- **Treed-cemetery profile** (adds *Sports & urban green*, the bucket that
  holds cemeteries): the Nordics, Baltics, UK, Ireland and Western/Central
  Europe. There cemeteries are mature-treed de-facto parks. North America and
  Oceania favour lawn memorial parks — sweeping grass with flush markers — so
  they keep the conservative default.
- The applied profile is stated in the card ("Norway: cemeteries are treed
  here and count as canopy too. Override below if you disagree."); the note
  disappears the moment the user edits.
- On the map (tick "Overlay countries" in the "how it's made" section, on by
  default) countries are tinted by profile: **green = treed cemeteries**,
  **orange = conservative base**. The overlay shows only at country zoom
  (below z9); zooming back into city mode hides it and re-runs sampling for
  the current pin. At country zoom, clicking around only does the country
  lookup and switches the profile note — no tile fetches.

Natural Earth's ring winding and antimeridian handling both needed care:
rings are unwrapped at decode (Russia's Chukotka/Wrangel, Fiji and Antarctica
cross ±180 and would otherwise paint horizontal bands across the map) and
latitudes are clamped to web-mercator's valid band (Antarctica dips to -85.6°,
past the projection's ±85.05 limit). Antarctica additionally needs an explicit
closure along the bottom of the projection: its ring starts and ends on
opposite sides of the antimeridian, and the implicit closing edge would run
straight across the continent, double-filling a giant wedge. Single-polygon
countries also get the correct GeoJSON nesting — a `[[ring]]` Polygon is
silently invisible in MapLibre.

The lookup is Natural Earth admin-0 at 1:110m (public domain), 177 countries
converted from the world-atlas TopoJSON into delta-encoded rings quantised to
0.01 degrees, ~78 KB with the defaults table. Even-odd point-in-polygon, per
polygon with holes (verified on the Lesotho enclave). To rebuild after
changing profiles or the source data:

```bash
node -e "
const topo = require('world-atlas/countries-110m.json'); // npm i world-atlas
const { scale, translate } = topo.transform;
const arcs = topo.arcs.map(a => { let x=0, y=0; return a.map(([dx,dy]) => {
  x += dx; y += dy;
  return [Math.round((translate[0]+scale[0]*x)*100), Math.round((translate[1]+scale[1]*y)*100)];
}); });
const c = [];
for (const g of topo.objects.countries.geometries) {
  const polys = (g.type === 'Polygon' ? [g.arcs] : g.arcs).map(poly => poly.map(arcIdxs => {
    const flat = []; let last = null;
    for (const ai of arcIdxs) {
      const arc = ai < 0 ? arcs[~ai].slice().reverse() : arcs[ai];
      for (const [x, y] of (last ? arc.slice(1) : arc)) {
        if (last && x === last[0] && y === last[1]) continue;
        flat.push(x - (last ? last[0] : 0), y - (last ? last[1] : 0)); last = [x, y];
      }
    }
    return flat.length >= 8 ? flat : null;
  }).filter(Boolean));
  if (polys.length) c.push([g.id, polys]);
}
require('fs').writeFileSync('countries.compact.json',
  JSON.stringify({ q: 100, c }));
"
```

Then paste the JSON into `countries.js` (the rest of the file is hand-written:
decoder, `find()`, `PROFILES`, `TREED_CEMETERIES`).

## Files

| File | Purpose |
|---|---|
| `index.html` | the page |
| `tool.css` | tool-specific styles, built from Designsystemet tokens |
| `app.js` | map, controls, checklist cards, map health diagnostics |
| `coverage.js` | projection, square/tile maths, category rules, pixel counting |
| `countries.js` | crude country lookup for per-country cover defaults |
| `greenspace.js` | the 300 rule: green-space patches, distances |
| `mvt.js` | dependency-free Mapbox Vector Tile reader |
| `selftest.html` | dev page: runs `coverage.js` against live tiles and asserts |

`selftest.html` needs a local server (it fetches tiles), and prints JSON with one
row per sample plus a `problems` list.

Note: some browsers block web workers on `file://`, which leaves the MapLibre map
blank (the panel keeps working). Serve the folder over http — the page shows a
notice and reports the reason in its "how it's made" section if that happens.