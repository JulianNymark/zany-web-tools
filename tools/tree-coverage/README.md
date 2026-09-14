# Park & tree coverage sampler

Drop a pin, pick a square, and see what share of it is parks and woodland —
the "30" of the [3-30-300 rule](https://www.treesforcities.org/resources/growing-urban-forests-the-3-30-300-rule).
The square turns green when coverage reaches the threshold (30% by default).

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

## Files

| File | Purpose |
|---|---|
| `index.html` | the page |
| `tool.css` | tool-specific styles, built from Designsystemet tokens |
| `app.js` | map, controls, map health diagnostics |
| `coverage.js` | projection, square/tile maths, category rules, pixel counting |
| `mvt.js` | dependency-free Mapbox Vector Tile reader |
| `selftest.html` | dev page: runs `coverage.js` against live tiles and asserts |

`selftest.html` needs a local server (it fetches tiles), and prints JSON with one
row per sample plus a `problems` list.

Note: some browsers block web workers on `file://`, which leaves the MapLibre map
blank (the panel keeps working). Serve the folder over http — the page shows a
notice and reports the reason in its "how it's made" section if that happens.