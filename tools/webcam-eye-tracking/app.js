(function () {
  'use strict';

  const MP_BUNDLE = '../../assets/vendor/mediapipe/vision_bundle.mjs';
  const MP_MODEL = '../../assets/vendor/mediapipe/face_landmarker.task';
  const MP_WASM = '../../assets/vendor/mediapipe/wasm';
  const CLM_SCRIPT = '../../assets/vendor/clmtrackr/clmtrackr.min.js';
  const WG_SCRIPT = 'https://cdn.jsdelivr.net/npm/webgazer@3.5.3/dist/webgazer.js';
  const WG_SOLUTION = 'https://cdn.jsdelivr.net/npm/webgazer@3.5.3/dist/mediapipe/face_mesh';
  const CAM_KEY = 'eyegaze.camera';

  const GRID = 5;
  const DWELL = 0.65;
  const PERSIST_MS = 8000;
  const GAZE_RGB = '224,30,30';

  const EYES = [
    { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 },
    { inner: 362, outer: 263, top: 386, bottom: 374, iris: 473 },
  ];
  const NOSE = 1;

  const CLM_LEFT = [63, 23, 24, 64, 25, 66, 26, 65];
  const CLM_RIGHT = [68, 29, 67, 30, 28, 69, 31, 70];
  const CLM_NOSE = 62;
  const CLM_FACE_L = 0;
  const CLM_FACE_R = 14;

  const BUBBLE_COLORS = ['accent', 'brand1', 'brand2', 'success', 'info', 'warning'];

  const el = (id) => document.getElementById(id);

  const video = el('video');
  const previewCanvas = el('previewCanvas');
  const previewCtx = previewCanvas.getContext('2d');
  const overlay = el('gazeOverlay');
  const overlayCtx = overlay.getContext('2d');
  const stage = el('stage');
  const game = el('game');
  const statusEl = el('status');
  const introStatus = el('introStatus');
  const fpsEl = el('fps');
  const faceStateEl = el('faceState');
  const summary = el('summary');
  const hudLeft = el('hudLeft');
  const hudTime = el('hudTime');
  const hudScore = el('hudScore');
  const hudErr = el('hudErr');
  const trackerPicker = el('trackerPicker');
  const trackerTech = el('trackerTech');

  let active = null;
  let activeId = null;

  let stream = null;
  let currentDeviceId = null;
  let running = false;
  let lastVideoTime = -1;
  let lastTs = 0;
  let frames = 0;
  let fpsClock = performance.now();

  let landmarker = null;
  let clmTracker = null;
  let wgLatest = null;

  let featureVec = null;
  let gaze = null;
  let smooth = null;
  let samples = [];
  let calib = null;
  let calibError = null;
  let previewCalib = null;
  let calibrating = false;
  let calSamples = [];
  let frameMode = 'video';

  let targets = [];
  let hits = 0;
  let runStart = 0;
  let runTime = 0;
  let finished = false;

  let colors = readColors();

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      || getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function readColors() {
    return {
      accent: cssVar('--ds-color-accent-base-default') || '#0062ba',
      ink: cssVar('--ds-color-neutral-text-default') || '#111',
    };
  }

  function setStatus(t) { statusEl.textContent = t; }

  function resizeOverlay() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    overlay.width = Math.floor(innerWidth * dpr);
    overlay.height = Math.floor(innerHeight * dpr);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resizeOverlay);
  resizeOverlay();

  if (matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colors = readColors(); });
  }

  /* -------------------------------------------------------------- features */

  function eyeRatios(lm, e) {
    const outer = lm[e.outer], inner = lm[e.inner], top = lm[e.top], bottom = lm[e.bottom], iris = lm[e.iris];
    const x0 = Math.min(outer.x, inner.x), x1 = Math.max(outer.x, inner.x);
    const y0 = Math.min(top.y, bottom.y), y1 = Math.max(top.y, bottom.y);
    const dx = Math.max(x1 - x0, 1e-6), dy = Math.max(y1 - y0, 1e-6);
    const midY = (outer.y + inner.y) / 2;
    return [(iris.x - x0) / dx, (iris.y - midY) / dy];
  }

  function mpFeatures(lm) {
    const [ax, ay] = eyeRatios(lm, EYES[0]);
    const [bx, by] = eyeRatios(lm, EYES[1]);
    const lo = lm[33], ro = lm[263], li = lm[133], ri = lm[362], nose = lm[NOSE];
    const eyeMidX = (lo.x + ro.x + li.x + ri.x) / 4;
    const eyeMidY = (lo.y + ro.y + li.y + ri.y) / 4;
    const faceW = Math.hypot(ro.x - lo.x, ro.y - lo.y) || 1e-6;
    const yaw = (nose.x - eyeMidX) / faceW;
    const pitch = (nose.y - eyeMidY) / faceW;
    const roll = Math.atan2(ro.y - lo.y, ro.x - lo.x);
    const scale = faceW;
    const gx = ((lm[468].x + lm[473].x) / 2 - eyeMidX) / faceW;
    const gy = ((lm[468].y + lm[473].y) / 2 - eyeMidY) / faceW;
    return [ax, ay, bx, by, yaw, pitch, roll, scale, gx, gy];
  }

  function centroid(p, set) {
    let x = 0, y = 0, c = 0;
    for (const i of set) {
      const q = p[i];
      if (!q) continue;
      x += q[0]; y += q[1]; c++;
    }
    return c ? [x / c, y / c] : null;
  }

  function clmFeatures(p) {
    const lC = centroid(p, CLM_LEFT);
    const rC = centroid(p, CLM_RIGHT);
    const fl = p[CLM_FACE_L], fr = p[CLM_FACE_R], nose = p[CLM_NOSE];
    const lTop = p[24], lBot = p[26], lL = p[63], lR = p[25];
    const rTop = p[29], rBot = p[31], rL = p[68], rR = p[28];
    if (!lC || !rC || !fl || !fr || !nose) return null;
    const faceW = Math.hypot(fr[0] - fl[0], fr[1] - fl[1]) || 1e-6;
    const eyeMidX = (lC[0] + rC[0]) / 2;
    const eyeMidY = (lC[1] + rC[1]) / 2;
    const yaw = (nose[0] - eyeMidX) / faceW;
    const pitch = (nose[1] - eyeMidY) / faceW;
    const roll = Math.atan2(rC[1] - lC[1], rC[0] - lC[0]);
    const lW = (lL && lR ? Math.hypot(lR[0] - lL[0], lR[1] - lL[1]) : 0) || 1e-6;
    const rW = (rL && rR ? Math.hypot(rR[0] - rL[0], rR[1] - rL[1]) : 0) || 1e-6;
    const lOpen = lTop && lBot ? (lBot[1] - lTop[1]) / lW : 0;
    const rOpen = rTop && rBot ? (rBot[1] - rTop[1]) / rW : 0;
    const lx = (lC[0] - eyeMidX) / faceW, ly = (lC[1] - eyeMidY) / faceW;
    const rx = (rC[0] - eyeMidX) / faceW, ry = (rC[1] - eyeMidY) / faceW;
    return [lx, ly, rx, ry, lOpen, rOpen, yaw, pitch, roll, faceW];
  }

  function expand(f) {
    const out = f.slice();
    for (const v of f) out.push(v * v);
    out.push(f[0] * f[2], f[1] * f[3], f[4] * f[5], f[8] * f[9]);
    return out;
  }

  /* -------------------------------------------------------- linear algebra */

  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      [M[col], M[piv]] = [M[piv], M[col]];
      const d = M[col][col] || 1e-9;
      for (let r = col + 1; r < n; r++) {
        const f = M[r][col] / d;
        if (!f) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
      x[r] = s / (M[r][r] || 1e-9);
    }
    return x;
  }

  class Ridge {
    constructor(lambda = 0.35) { this.lambda = lambda; }
    fit(X, Y) {
      const n = X.length, d = X[0].length;
      const mean = new Array(d).fill(0), std = new Array(d).fill(0);
      for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j];
      for (let j = 0; j < d; j++) mean[j] /= n;
      for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2;
      for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
      const D = d + 1;
      const A = Array.from({ length: D }, () => new Array(D).fill(0));
      const b = new Array(D).fill(0);
      for (let i = 0; i < n; i++) {
        const z = new Array(D);
        z[0] = 1;
        for (let j = 0; j < d; j++) z[j + 1] = (X[i][j] - mean[j]) / std[j];
        for (let p = 0; p < D; p++) {
          b[p] += z[p] * Y[i];
          for (let q = 0; q < D; q++) A[p][q] += z[p] * z[q];
        }
      }
      for (let p = 1; p < D; p++) A[p][p] += this.lambda;
      this.mean = mean; this.std = std; this.w = solve(A, b);
      return this;
    }
    predict(x) {
      let s = this.w[0];
      for (let j = 0; j < x.length; j++) s += this.w[j + 1] * ((x[j] - this.mean[j]) / this.std[j]);
      return s;
    }
  }

  function fitCalibration(samplesIn, lambda) {
    const X = samplesIn.map((s) => expand(s.f));
    return {
      mx: new Ridge(lambda).fit(X, samplesIn.map((s) => s.tx)),
      my: new Ridge(lambda).fit(X, samplesIn.map((s) => s.ty)),
    };
  }

  function predictFrom(model, f) {
    const x = expand(f);
    return { x: model.mx.predict(x), y: model.my.predict(x) };
  }

  function predictGaze(f) { return predictFrom(calib, f); }

  function setCalibration(samplesIn) {
    calib = fitCalibration(samplesIn);
    let err = 0;
    for (const s of samplesIn) {
      const p = predictGaze(s.f);
      err += Math.hypot(p.x - s.tx, p.y - s.ty);
    }
    return err / samplesIn.length;
  }

  /* --------------------------------------------------------------- tracker */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function makeMediapipe() {
    return {
      id: 'mediapipe',
      label: 'MediaPipe Face Landmarker',
      tech: 'Neural net · WebAssembly · 478 pts incl. iris',
      async load() {
        const m = await import(MP_BUNDLE);
        const fileset = await m.FilesetResolver.forVisionTasks(MP_WASM);
        try {
          landmarker = await m.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
          });
        } catch (e) {
          setStatus('GPU failed \u2014 falling back to CPU');
          const fileset2 = await m.FilesetResolver.forVisionTasks(MP_WASM);
          landmarker = await m.FaceLandmarker.createFromOptions(fileset2, {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' },
            runningMode: 'VIDEO',
            numFaces: 1,
          });
        }
      },
      sample(v, ts) {
        let r = null;
        try { r = landmarker.detectForVideo(v, ts); } catch (e) { r = null; }
        const lm = r && r.faceLandmarks ? r.faceLandmarks[0] || null : null;
        return { features: lm ? mpFeatures(lm) : null, data: lm };
      },
      preview(ctx, w, h, lm) {
        if (!lm) return;
        ctx.save();
        ctx.translate(w, 0); ctx.scale(-1, 1);
        ctx.fillStyle = colors.accent;
        ctx.globalAlpha = 0.7;
        for (const e of EYES) {
          for (const idx of [e.outer, e.inner, e.top, e.bottom, e.iris]) {
            const p = lm[idx];
            ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 2.5, 0, 7); ctx.fill();
          }
          const c = lm[e.iris];
          ctx.strokeStyle = colors.ink;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(c.x * w, c.y * h, 6, 0, 7); ctx.stroke();
        }
        ctx.restore();
      },
      stop() { landmarker = null; },
    };
  }

  function makeClmtrackr() {
    return {
      id: 'clmtrackr',
      label: 'clmtrackr',
      tech: 'Classic CV · constrained local models · no ML, no iris',
      restartOnStream: true,
      async load(v) {
        if (!window.clm) await loadScript(CLM_SCRIPT);
        // clmtrackr's Haar detector reads video.width/video.height (the HTML
        // attributes), not videoWidth/videoHeight. Without them it builds a
        // 0x0 canvas and never finds a face. Mirror the real frame size across.
        if (!v.videoWidth) {
          await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
        }
        v.width = v.videoWidth;
        v.height = v.videoHeight;
        clmTracker = new window.clm.tracker();
        clmTracker.init();
        clmTracker.start(v);
      },
      sample() {
        const p = clmTracker ? clmTracker.getCurrentPosition() : false;
        return { features: p ? clmFeatures(p) : null, data: p || null };
      },
      preview(ctx, w, h, p) {
        if (!p) return;
        const dots = (set) => {
          ctx.fillStyle = colors.accent;
          ctx.globalAlpha = 0.7;
          for (const i of set) {
            const q = p[i];
            if (!q) continue;
            ctx.beginPath(); ctx.arc(w - q[0], q[1], 2.5, 0, 7); ctx.fill();
          }
          ctx.globalAlpha = 1;
        };
        dots(CLM_LEFT);
        dots(CLM_RIGHT);
        const nose = p[CLM_NOSE];
        if (nose) {
          ctx.strokeStyle = colors.ink;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(w - nose[0], nose[1], 5, 0, 7); ctx.stroke();
        }
      },
      stop() {
        if (clmTracker) { try { clmTracker.stop(); } catch (e) {} clmTracker = null; }
      },
    };
  }

  function makeWebGazer() {
    return {
      id: 'webgazer',
      label: 'WebGazer.js',
      tech: 'TF.js + MediaPipe face mesh \u00b7 self-trained ridge regression',
      ownsCamera: true,
      selfRegress: true,
      async load() {
        if (!window.webgazer) await loadScript(WG_SCRIPT);
        const wg = window.webgazer;
        // Load the MediaPipe face_mesh solution from the CDN (same pinned
        // version as the script); the webcam video itself never leaves the page.
        wg.params.faceMeshSolutionPath = WG_SOLUTION;
        wg.saveDataAcrossSessions(false);
        wg.params.showVideo = true;
        wg.params.mirrorVideo = true;
        wg.params.showFaceOverlay = false;
        wg.params.showFaceFeedbackBox = false;
        wg.params.showGazeDot = false;
        wg.params.applyKalmanFilter = true;
        // WebGazer's defaults demand width.min 320, which rejects some
        // low-resolution cameras; ask for an ideal size instead.
        wg.params.camConstraints = {
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        };
        wg.setGazeListener((data) => { wgLatest = data; });
        // Start every WebGazer session with an untrained regression.
        try { await wg.clearData(); } catch (e) {}
        await wg.begin();
        // From here on, only our calibration dots train the model.
        wg.removeMouseEventListeners();
        wg.showPredictionPoints(false);
      },
      sample() {
        return { features: null, data: null, gaze: wgLatest };
      },
      preview() {},
      recordPoint(x, y) {
        if (window.webgazer) window.webgazer.recordScreenPosition(x, y, 'click');
      },
      stop() {
        wgLatest = null;
        const wg = window.webgazer;
        if (!wg) return;
        try { wg.clearGazeListener(); } catch (e) {}
        try { wg.pause(); } catch (e) {}
        try { wg.end(); } catch (e) {}
        try { wg.stopVideo(); } catch (e) {}
      },
    };
  }

  const TRACKERS = { mediapipe: makeMediapipe(), clmtrackr: makeClmtrackr(), webgazer: makeWebGazer() };

  function initTrackers() {
    for (const id of Object.keys(TRACKERS)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = TRACKERS[id].label;
      trackerPicker.appendChild(opt);
    }
    activeId = 'mediapipe';
    active = TRACKERS[activeId];
    trackerPicker.value = activeId;
    trackerTech.textContent = active.tech;
    trackerPicker.addEventListener('change', (e) => setActiveTracker(e.target.value));
  }

  async function setActiveTracker(id) {
    if (id === activeId || !TRACKERS[id]) return;
    const wasRunning = running;
    if (active && active.stop) active.stop();
    activeId = id;
    active = TRACKERS[id];
    trackerTech.textContent = active.tech;
    if (wasRunning) {
      // Trackers disagree on who owns the camera (WebGazer opens its own),
      // so the simplest correct hand-off is a full restart.
      stop();
      trackerPicker.value = id;
      await start();
    } else {
      resetGazeState();
    }
  }

  /* --------------------------------------------------- gaze trace (Tobii) */

  function pushSample(x, y, t) {
    const last = samples[samples.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 1 && t - last.t < 120) return;
    samples.push({ x, y, t });
    const cutoff = t - PERSIST_MS;
    while (samples.length && samples[0].t < cutoff) samples.shift();
  }

  function drawGaze(now) {
    const w = innerWidth, h = innerHeight;
    overlayCtx.clearRect(0, 0, w, h);
    overlayCtx.lineWidth = 1;
    for (let i = 1; i < samples.length; i++) {
      const a = 1 - (now - samples[i].t) / PERSIST_MS;
      if (a <= 0) continue;
      overlayCtx.strokeStyle = 'rgba(' + GAZE_RGB + ',' + a.toFixed(3) + ')';
      overlayCtx.beginPath();
      overlayCtx.moveTo(samples[i - 1].x, samples[i - 1].y);
      overlayCtx.lineTo(samples[i].x, samples[i].y);
      overlayCtx.stroke();
    }
    for (let i = 0; i < samples.length; i++) {
      const a = (1 - (now - samples[i].t) / PERSIST_MS) * 0.9;
      if (a <= 0) continue;
      overlayCtx.fillStyle = 'rgba(' + GAZE_RGB + ',' + a.toFixed(3) + ')';
      overlayCtx.beginPath();
      overlayCtx.arc(samples[i].x, samples[i].y, 2, 0, 7);
      overlayCtx.fill();
    }
    if (smooth) {
      overlayCtx.fillStyle = 'rgba(' + GAZE_RGB + ',1)';
      overlayCtx.beginPath();
      overlayCtx.arc(smooth.x, smooth.y, 4, 0, 7);
      overlayCtx.fill();
    }
  }

  function clearGaze() {
    samples = [];
    smooth = null;
    overlayCtx.clearRect(0, 0, innerWidth, innerHeight);
  }

  /* --------------------------------------------------------- deterministic */

  // The region we actually track: below the toolbar, above the HUD and any
  // camera preview. Calibration points and bubbles both live inside it, so no
  // dot ever lands on the header text or off-screen.
  function trackArea() {
    const pad = 28;
    const bar = document.querySelector('.game-bar');
    const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
    const hud = el('hud');
    let bottom = hud && !hud.hidden ? hud.getBoundingClientRect().top : innerHeight;
    for (const id of ['preview', 'webgazerVideoContainer']) {
      const n = document.getElementById(id);
      if (n && n.getClientRects().length) bottom = Math.min(bottom, n.getBoundingClientRect().top);
    }
    const left = pad;
    const right = innerWidth - pad;
    const top = Math.max(barBottom + pad, pad);
    bottom = Math.min(bottom - pad, innerHeight - pad);
    return {
      left, top, right, bottom,
      w: Math.max(right - left, 160),
      h: Math.max(bottom - top, 160),
    };
  }

  function buildTargets() {
    clearTargets();
    const count = GRID * GRID;
    const a = trackArea();
    const cellW = a.w / GRID;
    const cellH = a.h / GRID;
    const rMax = Math.max(18, Math.min(cellW, cellH) * 0.42);
    const rMin = Math.max(10, rMax * 0.4);

    let k = 0;
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const t = count === 1 ? 0 : k / (count - 1);
        const r = rMin + (rMax - rMin) * t;
        const x = a.left + cellW * (col + 0.5);
        const y = a.top + cellH * (row + 0.5);
        const node = document.createElement('div');
        node.className = 'bubble';
        node.style.width = node.style.height = r * 2 + 'px';
        node.style.left = x + 'px';
        node.style.top = y + 'px';
        node.style.setProperty('--bubble-color', 'var(--ds-color-' + BUBBLE_COLORS[k % BUBBLE_COLORS.length] + '-base-default)');
        node.innerHTML = '<span class="bubble__ring"></span><span class="bubble__label">' + (k + 1) + '</span>';
        stage.appendChild(node);
        targets.push({ el: node, x, y, r, dwell: 0, popped: false });
        k++;
      }
    }
  }

  function clearTargets() {
    for (const t of targets) t.el.remove();
    targets = [];
  }

  function updateHud() {
    hudLeft.textContent = targets.filter((t) => !t.popped).length + ' / ' + targets.length;
    hudScore.textContent = String(hits);
    hudErr.textContent = calibError == null ? '\u2013' : calibError.toFixed(0) + ' px';
  }

  function startRun() {
    if (!calib) return;
    finished = false;
    hits = 0;
    runStart = performance.now();
    runTime = 0;
    summary.hidden = true;
    clearTargets();
    buildTargets();
    updateHud();
    setStatus('Calibrated \u00b7 ' + targets.length + ' targets \u00b7 smallest first');
  }

  function finishRun() {
    finished = true;
    sumTargets.textContent = String(targets.length);
    sumHits.textContent = String(hits);
    sumTime.textContent = runTime.toFixed(1) + ' s';
    sumErr.textContent = calibError == null ? '\u2013' : calibError.toFixed(0) + ' px';
    summary.hidden = false;
    setStatus('Run complete \u00b7 ' + hits + ' / ' + targets.length + ' in ' + runTime.toFixed(1) + ' s');
  }

  function updateTargets(dt) {
    if (!calib || !smooth || finished || targets.length === 0) return;
    let left = 0;
    for (const t of targets) {
      if (t.popped) continue;
      const on = Math.hypot(smooth.x - t.x, smooth.y - t.y) < t.r;
      t.dwell = on ? t.dwell + dt : Math.max(0, t.dwell - dt * 2);
      t.el.style.setProperty('--p', Math.min(t.dwell / DWELL, 1) + 'turn');
      if (t.dwell >= DWELL) {
        t.popped = true;
        t.el.classList.add('bubble--hit');
        const node = t.el;
        setTimeout(() => node.remove(), 340);
        hits++;
        updateHud();
      } else {
        left++;
      }
    }
    if (left === 0) finishRun();
  }

  /* ------------------------------------------------------------ calibration */

  const calibEl = el('calib');
  const calibHint = el('calibHint');
  const calibPointsEl = el('calibPoints');

  function makeCalPoint(x, y) {
    const wrap = document.createElement('div');
    wrap.className = 'calpoint';
    wrap.style.left = x + 'px';
    wrap.style.top = y + 'px';
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('width', '1'); ring.setAttribute('height', '1');
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '20'); c.setAttribute('cx', '0'); c.setAttribute('cy', '0');
    c.setAttribute('stroke-dasharray', String(2 * Math.PI * 20));
    c.setAttribute('stroke-dashoffset', String(2 * Math.PI * 20));
    ring.appendChild(c);
    wrap.innerHTML = '<span class="calpoint__dot"></span>';
    wrap.appendChild(ring);
    calibPointsEl.appendChild(wrap);
    return { wrap, c, circumference: 2 * Math.PI * 20 };
  }

  function waitUntil(pred, ms) {
    return new Promise((res) => {
      const t0 = performance.now();
      const step = () => {
        if (pred()) res(true);
        else if (performance.now() - t0 > ms) res(false);
        else requestAnimationFrame(step);
      };
      step();
    });
  }

  function runCalibration() {
    return new Promise(async (resolve) => {
      if (!running) { resolve(null); return; }
      const isSelf = active && active.selfRegress;
      // Don't silently bail if the first face frame hasn't arrived yet.
      // WebGazer has no prediction until it is trained, so wait on its face
      // tracker's landmarks instead.
      const ready = await waitUntil(() => (isSelf
        ? !!(window.webgazer && window.webgazer.getTracker && window.webgazer.getTracker().getPositions())
        : !!featureVec), 8000);
      if (!ready) {
        setStatus('No face detected \u2014 check the camera and lighting');
        resolve(null);
        return;
      }
      summary.hidden = true;
      clearTargets();
      clearGaze();
      previewCalib = null;
      calibrating = true;
      // WebGazer keeps only its last 50 samples, so start from an empty model.
      if (active && active.selfRegress && window.webgazer && window.webgazer.clearData) {
        try { await window.webgazer.clearData(); } catch (e) {}
      }
      calibEl.classList.add('on');
      // 9 inner points + 4 corner points inside the tracking area: the corners
      // widen the convex hull so the regression extrapolates less at the edges.
      const a = trackArea();
      const m = 0.16, e = 0.06;
      const xs = [a.left + a.w * m, a.left + a.w * 0.5, a.left + a.w * (1 - m)];
      const ys = [a.top + a.h * m, a.top + a.h * 0.5, a.top + a.h * (1 - m)];
      const points = [];
      for (const y of ys) for (const x of xs) points.push({ x, y });
      const ex = a.w * e, ey = a.h * e;
      points.push(
        { x: a.left + ex, y: a.top + ey }, { x: a.right - ex, y: a.top + ey },
        { x: a.left + ex, y: a.bottom - ey }, { x: a.right - ex, y: a.bottom - ey },
      );

      const SETTLE = 550, COLLECT = 1300;
      const collected = [];

      calibHint.innerHTML = 'Keep your head still and follow the <b>dot</b> with your eyes. The red trace shows the fit improving.<br>No clicking needed \u2014 it advances by itself.';
      await new Promise((r) => setTimeout(r, 1400));

      for (let i = 0; i < points.length; i++) {
        calibHint.innerHTML = 'Calibrating \u2014 point <b>' + (i + 1) + ' / ' + points.length + '</b>';
        const cp = makeCalPoint(points[i].x, points[i].y);
        cp.wrap.classList.add('active');
        const marks = [0.4, 0.65, 0.9];
        let mi = 0;
        const t0 = performance.now();
        await new Promise((resolveStep) => {
          const step = (now) => {
            const t = now - t0;
            if (t < SETTLE) {
              cp.c.setAttribute('stroke-dashoffset', String(cp.circumference));
            } else {
              const p = Math.min((t - SETTLE) / COLLECT, 1);
              cp.c.setAttribute('stroke-dashoffset', String(cp.circumference * (1 - p)));
              // A few samples per dot, not one per frame: WebGazer's ridge only
              // keeps the last 50, so flooding it evicts every earlier point.
              if (mi < marks.length && p >= marks[mi]) {
                if (active && active.recordPoint) active.recordPoint(points[i].x, points[i].y);
                mi++;
              }
              if (featureVec) collected.push({ f: featureVec.slice(), tx: points[i].x, ty: points[i].y });
              if (p >= 1) { resolveStep(); return; }
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        cp.wrap.remove();
        // Only start the preview after a few dots, with extra smoothing, so it
        // does not fling across the screen while it is still underdetermined.
        if (i >= 3 && collected.length > 10) previewCalib = fitCalibration(collected, 2.5);
      }

      calibPointsEl.innerHTML = '';
      calibEl.classList.remove('on');
      calibrating = false;
      previewCalib = null;

      if (active && active.selfRegress) {
        const reg = window.webgazer && window.webgazer.getRegression ? window.webgazer.getRegression()[0] : null;
        const trained = reg && typeof reg.getData === 'function' && reg.getData().length >= 20;
        if (!trained) {
          calibHint.textContent = 'WebGazer could not train \u2014 check the camera and try again.';
          setStatus('Calibration failed');
          resolve(null);
          return;
        }
        calib = { selfRegress: true };
        calibError = null;
        clearGaze();
        updateHud();
        setStatus('Calibrated \u00b7 WebGazer regression trained');
        startRun();
        resolve(0);
        return;
      }

      const err = collected.length > 25 ? setCalibration((calSamples = collected)) : null;
      if (err == null) {
        calibHint.textContent = 'Not enough face data \u2014 try again with better lighting.';
        setStatus('Calibration failed');
        resolve(null);
      } else {
        calibError = err;
        clearGaze();
        updateHud();
        setStatus('Calibrated \u00b7 mean error ' + err.toFixed(0) + ' px');
        startRun();
        resolve(err);
      }
    });
  }

  /* --------------------------------------------------- click recalibration */

  // People look at what they click, so a click is a free calibration sample:
  // pair the cursor position with the current face features and refit. Works
  // for the ridge trackers directly; WebGazer takes it as a training sample.
  function onDocumentClick(e) {
    if (!running || calibrating || !calib) return;
    const chk = el('chkClick');
    if (!chk || !chk.checked) return;
    if (active && active.selfRegress) {
      if (window.webgazer) window.webgazer.recordScreenPosition(e.clientX, e.clientY, 'click');
      setStatus('Recalibrated \u00b7 ' + active.label);
      return;
    }
    if (!featureVec) return;
    calSamples.push({ f: featureVec.slice(), tx: e.clientX, ty: e.clientY });
    if (calSamples.length > 600) calSamples.splice(0, calSamples.length - 600);
    calibError = setCalibration(calSamples);
    updateHud();
    setStatus('Recalibrated \u00b7 look-and-click samples: ' + calSamples.length);
  }

  /* ------------------------------------------------------------ frame loop */

  const scheduleVideoFrame = video.requestVideoFrameCallback
    ? (cb) => video.requestVideoFrameCallback(cb)
    : (cb) => requestAnimationFrame(() => cb(performance.now()));

  function scheduleNext() {
    if (frameMode === 'raf') requestAnimationFrame(() => onFrame());
    else scheduleVideoFrame(() => onFrame());
  }

  function onFrame() {
    if (!running) return;
    const now = performance.now();
    const raf = frameMode === 'raf';
    if (raf || (video.readyState >= 2 && video.currentTime !== lastVideoTime)) {
      if (!raf) lastVideoTime = video.currentTime;
      const ts = raf ? now : Math.max(now, lastTs + 1);
      lastTs = ts;

      const result = active && active.sample ? active.sample(video, ts) : null;
      const features = result ? result.features : null;
      let point = result && result.gaze ? result.gaze : null;

      const pw = video.videoWidth, ph = video.videoHeight;
      if (!raf && pw) {
        if (previewCanvas.width !== pw) { previewCanvas.width = pw; previewCanvas.height = ph; }
        previewCtx.clearRect(0, 0, pw, ph);
        if (active && active.preview) active.preview(previewCtx, pw, ph, result ? result.data : null);
      }

      if (point) {
        // Tracker owns the regression (WebGazer) \u2014 values are already screen px.
        featureVec = null;
      } else if (features) {
        featureVec = features;
        const model = calib || previewCalib;
        if (model) {
          const g = predictFrom(model, featureVec);
          if (Number.isFinite(g.x) && Number.isFinite(g.y)) {
            // Keep the in-progress preview on screen; it has little data and
            // can extrapolate to silly coordinates.
            point = model === previewCalib
              ? { x: Math.min(Math.max(g.x, 0), innerWidth), y: Math.min(Math.max(g.y, 0), innerHeight) }
              : g;
          }
        }
      } else {
        featureVec = null;
      }

      faceStateEl.textContent = (features || point) ? 'tracked' : 'not found';

      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        gaze = { x: point.x, y: point.y };
        const k = active && active.selfRegress ? 0.65 : 0.4;
        smooth = smooth
          ? { x: smooth.x + (gaze.x - smooth.x) * k, y: smooth.y + (gaze.y - smooth.y) * k }
          : { x: gaze.x, y: gaze.y };
        pushSample(smooth.x, smooth.y, now);
      }

      drawGaze(now);

      if (calib && !finished) {
        runTime = (now - runStart) / 1000;
        hudTime.textContent = runTime.toFixed(1) + ' s';
        updateTargets(1 / 60);
      }
    }
    frames++;
    if (now - fpsClock > 500) {
      fpsEl.textContent = Math.round((frames * 1000) / (now - fpsClock)) + ' fps';
      frames = 0; fpsClock = now;
    }
    scheduleNext();
  }

  /* ---------------------------------------------------------------- camera */

  async function openStream(deviceId) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const videoConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) {
      await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
    }
    lastVideoTime = -1;
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    currentDeviceId = deviceId || settings.deviceId || null;
    return track.label || 'camera';
  }

  async function refreshCameraList() {
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch (e) { devices = []; }
    el('camPicker').innerHTML = '';
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Camera ' + (i + 1);
      el('camPicker').appendChild(opt);
    });
    if (currentDeviceId) el('camPicker').value = currentDeviceId;
    el('camPicker').hidden = devices.length < 2;
    return devices;
  }

  async function openCamera() {
    let savedId = null;
    try { savedId = localStorage.getItem(CAM_KEY); } catch (e) {}
    let label;
    try {
      label = await openStream(savedId || undefined);
    } catch (err) {
      if (!savedId) throw err;
      label = await openStream(undefined);
    }
    await refreshCameraList();
    return label;
  }

  async function switchCamera(deviceId) {
    if (!running || !deviceId || deviceId === currentDeviceId) return;
    setStatus('Switching camera\u2026');
    try {
      const label = await openStream(deviceId);
      resetGazeState();
      if (active && active.restartOnStream) {
        try { await active.load(video); } catch (e) {}
      }
      try { localStorage.setItem(CAM_KEY, deviceId); } catch (e) {}
      setStatus('Now using "' + label + '" \u2014 recalibrate');
    } catch (err) {
      setStatus('Could not switch camera');
    }
  }

  function resetGazeState() {
    calib = null;
    calibError = null;
    previewCalib = null;
    calibrating = false;
    featureVec = null;
    gaze = null;
    smooth = null;
    calSamples = [];
    finished = false;
    hits = 0;
    runTime = 0;
    summary.hidden = true;
    clearTargets();
    clearGaze();
    updateHud();
  }

  /* ------------------------------------------------------------- lifecycle */

  async function start() {
    el('btnStart').disabled = true;
    game.hidden = false;
    document.body.classList.add('game-open');
    const owns = !!(active && active.ownsCamera);
    const requesting = owns ? 'Starting ' + active.label + '\u2026' : 'Requesting camera\u2026';
    setStatus(requesting);
    introStatus.textContent = requesting;

    let label = active.label;
    if (!owns) {
      try {
        label = await openCamera();
      } catch (err) {
        cameraFailed(err);
        return;
      }
    }

    setStatus('Loading ' + active.label + '\u2026');
    try {
      await active.load(video);
    } catch (e) {
      const msg = 'Could not load ' + active.label + ' \u2014 check your connection, and serve over HTTPS or localhost.';
      setStatus(msg);
      introStatus.textContent = msg;
      stop();
      return;
    }

    running = true;
    frameMode = owns ? 'raf' : 'video';
    el('preview').hidden = owns;
    el('btnCalibrate').disabled = false;
    el('btnToggleCam').disabled = false;
    el('btnStop').disabled = false;
    setStatus(owns
      ? 'Using ' + active.label + ' \u2014 calibrate to start'
      : 'Using "' + label + '" \u00b7 ' + active.label + ' \u2014 calibrate to start');
    scheduleNext();
  }

  function cameraFailed(err) {
    const msg = err && err.name === 'NotAllowedError'
      ? 'Camera blocked \u2014 check permissions'
      : 'No camera found';
    setStatus(msg);
    introStatus.textContent = msg;
    game.hidden = true;
    document.body.classList.remove('game-open');
    el('btnStart').disabled = false;
  }

  function stop() {
    running = false;
    if (active && active.stop) active.stop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    currentDeviceId = null;
    resetGazeState();
    el('camPicker').hidden = true;
    el('btnCalibrate').disabled = true;
    el('btnToggleCam').disabled = true;
    el('btnStop').disabled = true;
    el('btnStart').disabled = false;
    el('preview').hidden = true;
    el('btnToggleCam').textContent = 'Hide camera';
    game.hidden = true;
    document.body.classList.remove('game-open');
    setStatus('Stopped');
    introStatus.textContent = 'Stopped. Press start to run again.';
  }

  /* ---------------------------------------------------------------- wiring */

  initTrackers();

  el('btnStart').addEventListener('click', start);
  el('btnStop').addEventListener('click', stop);
  el('btnSummaryStop').addEventListener('click', stop);
  el('btnRepeat').addEventListener('click', () => {
    summary.hidden = true;
    if (!calib) { runCalibration(); return; }
    startRun();
  });
  el('camPicker').addEventListener('change', (e) => switchCamera(e.target.value));
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { if (running) refreshCameraList(); });
  }
  el('btnCalibrate').addEventListener('click', async () => {
    el('btnCalibrate').disabled = true;
    await runCalibration();
    el('btnCalibrate').disabled = false;
  });
  document.addEventListener('click', onDocumentClick, true);
  el('btnToggleCam').addEventListener('click', (e) => {
    if (active && active.ownsCamera) {
      const show = !(window.webgazer && window.webgazer.params.showVideo);
      if (window.webgazer) window.webgazer.showVideoPreview(show);
      e.target.textContent = show ? 'Hide camera' : 'Show camera';
      return;
    }
    const p = el('preview');
    p.hidden = !p.hidden;
    e.target.textContent = p.hidden ? 'Show camera' : 'Hide camera';
  });

  let resizeTimer = null;
  addEventListener('resize', () => {
    if (!running || !calib) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (running && calib) startRun(); }, 300);
  });
})();
