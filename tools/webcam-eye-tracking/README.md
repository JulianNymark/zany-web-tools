# Webcam eye tracking

Gaze estimation from an ordinary webcam, entirely in the browser. Calibrate to
nine points, then pop a deterministic grid of bubbles with your eyes. The grid
layout and bubble sizes are fixed, so a run is repeatable — handy for comparing
attempts, lighting or trackers.

Open it at [`tools/webcam-eye-tracking/`](.) on the site, or run the repo locally
(see the [root README](../../README.md)).

## How it works

1. [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
   detects 478 face landmarks per frame, including 8 iris points. It runs
   on-device via a vendored WebAssembly bundle (GPU, with a CPU fallback).
2. Each frame becomes a feature vector: horizontal/vertical iris ratios per eye,
   head yaw/pitch/roll, face scale and the combined iris offset.
3. Nine calibration points collect samples; a **ridge regression** (fit in-page,
   not a neural net) maps features to screen coordinates.
4. Predictions are smoothed and drawn as a gaze dot with a trail. A bubble pops
   once your gaze dwells inside it for the selected time.

No build step, no framework, no API key. The design system CSS and the MediaPipe
runtime are vendored in `assets/vendor/`.

## The repeatable test

Bubbles sit on a fixed grid (3×3, 4×4 or 5×5). Positions come from the viewport
and the grid size; sizes increase in a fixed order from smallest to largest.
There is no randomness, so the same window size and grid setting produce the
same layout every run. The HUD shows targets left, elapsed time, hits and the
calibration error in pixels; clearing the grid shows a summary you can repeat.

## Privacy

Video never leaves the machine — inference happens in your browser, and the
camera stream is stopped when you press stop or leave the page. The only network
request is the optional live star count in the comparison section (GitHub API).

## Requirements

- A **secure context**: HTTPS or `localhost`. `file://` blocks the camera and the
  WebAssembly module.
- Serve the folder. On GitHub Pages that is automatic; locally run
  `python3 -m http.server` from the repo root.
- Sit roughly 50–70 cm from the screen, face lit from the front, head fairly
  still. Expect centimetre accuracy, not millimetre.

## Alternatives

The page includes a comparison of other browser eye-tracking options (WebGazer.js,
TF.js face-landmarks-detection, face-api.js, ml5.js, clmtrackr and the commercial
SeeSo/Eyedid and GazeCloudAPI). Star counts come from the GitHub API on load with
a baked snapshot as fallback.

## Files

| File | Purpose |
|---|---|
| `index.html` | the page: intro, comparison, method notes and the game layer |
| `tool.css` | tool-specific styles, built from Designsystemet tokens |
| `app.js` | camera, model, calibration, gaze rendering and the bubble grid |
| `alternatives.js` | comparator list and live GitHub star counts |

## Vendored dependency

`assets/vendor/mediapipe/` holds a pinned copy of **`@mediapipe/tasks-vision`
1.0.1** (Apache-2.0):

| File | What |
|---|---|
| `vision_bundle.mjs` | the tasks-vision ES module |
| `wasm/vision_wasm_internal.{js,wasm}` | the SIMD WebAssembly build |
| `wasm/vision_wasm_nosimd_internal.{js,wasm}` | the non-SIMD fallback |
| `face_landmarker.task` | the float16 Face Landmarker model |

Do not edit these files. To upgrade, bump the version in this table and in
`DESIGN.md`, and re-download from the same npm paths.
