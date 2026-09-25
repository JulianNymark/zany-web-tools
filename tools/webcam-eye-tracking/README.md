# Webcam eye tracking

Gaze estimation from an ordinary webcam, entirely in the browser. Calibrate to
thirteen points, then pop a deterministic 5×5 grid of bubbles with your eyes.
Swap the tracker from the toolbar to compare a neural-net model, a classic
computer-vision one and WebGazer's self-trained regression. The grid layout and
bubble sizes are fixed, so a run is repeatable.

Open it at [`tools/webcam-eye-tracking/`](.) on the site, or run the repo locally
(see the [root README](../../README.md)).

## How it works

1. A tracker produces a feature vector per frame.
2. Thirteen calibration points collect samples; a **ridge regression** (fit
   in-page, not a neural net) maps features to screen coordinates.
3. Predictions are smoothed and drawn as a red gaze trace (lines plus a dot per
   sample, fading over ~8 s) in the style of Tobii Pro. A bubble pops once the
   gaze dwells inside it (0.65 s).

Calibration uses 13 points (a 3&times;3 grid plus four corners) so the fit does
not have to extrapolate at the screen edges. **Click to recalibrate** (on by
default) then keeps it honest: people look at what they click, so every click
pairs the cursor position with the current face features and refits &mdash;
a constant offset is usually head movement, not a bad fit.

No build step, no framework, no API key. MediaPipe and clmtrackr are vendored in
`assets/vendor/`; WebGazer.js loads its script and face-mesh assets from
jsDelivr at runtime.

## Trackers

| Tracker | Tech | Gaze signal |
|---|---|---|
| **MediaPipe Face Landmarker** | Neural net, WebAssembly, 478 landmarks | Iris ratios + head pose |
| **clmtrackr** | Classic CV (constrained local models), no ML | Head pose / eye-centre only (no iris) |
| **WebGazer.js** | TF.js + MediaPipe face mesh | Self-trained ridge regression over eye patches |

Switch them from the **Tracker** dropdown in the toolbar at any time; switching
restarts the session (WebGazer owns its own camera stream). WebGazer then
self-calibrates from the same calibration dots via
`webgazer.recordScreenPosition()`. The page also lists other options (TF.js
face-landmarks-detection, face-api.js, ml5.js and the commercial SeeSo/Eyedid and
GazeCloudAPI) with short tech notes and external demo links.

## The repeatable test

Bubbles sit on a fixed 5×5 grid; positions come from one tracking area (below
the toolbar, clear of the HUD and the camera preview), and sizes increase from
smallest to largest in a fixed order. Calibration points use the same area, so no
dot lands on the header. There is no randomness, so the same window size produces
the same layout every run. The HUD shows targets left, elapsed time, hits and the
calibration error in pixels; clearing the grid shows a summary you can repeat.

## Privacy

Video never leaves the machine — inference happens in your browser, and the
camera stream is stopped when you press stop or leave the page. Network requests
are only for code/assets: the pinned WebGazer script and its MediaPipe face-mesh
files from jsDelivr, plus the optional live star count in the comparison section
(GitHub API). No frame is ever uploaded.

## Requirements

- A **secure context**: HTTPS or `localhost`. `file://` blocks the camera and the
  WebAssembly module.
- Serve the folder. On GitHub Pages that is automatic; locally run
  `python3 -m http.server` from the repo root.
- Sit roughly 50–70 cm from the screen, face lit from the front, head fairly
  still. Expect centimetre accuracy, not millimetre. A constant offset after
  calibration is usually head movement; the click-to-recalibrate samples fix it.
- WebGazer needs network access to jsDelivr the first time (then it is cached).

## Files

| File | Purpose |
|---|---|
| `index.html` | the page: intro, method/compare details and the game layer |
| `tool.css` | tool-specific styles, built from Designsystemet tokens |
| `app.js` | camera, tracker adapters, calibration, gaze trace and the bubble grid |
| `alternatives.js` | comparator list and live GitHub star counts |

## Vendored dependencies

`assets/vendor/mediapipe/` holds a pinned copy of **`@mediapipe/tasks-vision`
1.0.1** (Apache-2.0):

| File | What |
|---|---|
| `vision_bundle.mjs` | the tasks-vision ES module |
| `wasm/vision_wasm_internal.{js,wasm}` | the SIMD WebAssembly build |
| `wasm/vision_wasm_nosimd_internal.{js,wasm}` | the non-SIMD fallback |
| `face_landmarker.task` | the float16 Face Landmarker model |

`assets/vendor/clmtrackr/clmtrackr.min.js` holds **clmtrackr 1.1.2** (MIT), whose
default face model is bundled in the build. Do not edit these files. To upgrade,
bump the version here and in `DESIGN.md` and re-download from the same npm paths.

**WebGazer.js 3.5.3** (GPL-3.0-or-later) is *not* vendored: its script
(`dist/webgazer.js`, ~1.9 MB) and the MediaPipe face-mesh solution it needs
(`dist/mediapipe/face_mesh/`, ~10.6 MB) are both fetched from jsDelivr when you
select it. That keeps ~12 MB out of the repo; the trade-off is a network
dependency and a GPL-licensed dependency. To pin a different version, change
`WG_SCRIPT`/`WG_SOLUTION` in `app.js` and the version here.
