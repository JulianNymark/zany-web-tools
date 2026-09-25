(function () {
  'use strict';

  const VENDOR = '../../assets/vendor/mediapipe/';
  const MODEL_URL = VENDOR + 'face_landmarker.task';
  const WASM_PATH = VENDOR + 'wasm';
  const CAM_KEY = 'eyegaze.camera';

  const EYES = [
    { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 },
    { inner: 362, outer: 263, top: 386, bottom: 374, iris: 473 },
  ];
  const NOSE = 1;

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

  let landmarker = null;
  let running = false;
  let lastVideoTime = -1;
  let lastTs = 0;
  let stream = null;
  let currentDeviceId = null;
  let frames = 0;
  let fpsClock = performance.now();

  let featureVec = null;
  let gaze = null;
  let smooth = null;
  let trail = [];
  let calib = null;
  let calibError = null;

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
      trail: cssVar('--ds-color-brand2-base-default') || '#f472b6',
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

  /* ------------------------------------------------------------- features */

  function eyeRatios(lm, e) {
    const outer = lm[e.outer], inner = lm[e.inner], top = lm[e.top], bottom = lm[e.bottom], iris = lm[e.iris];
    const x0 = Math.min(outer.x, inner.x), x1 = Math.max(outer.x, inner.x);
    const y0 = Math.min(top.y, bottom.y), y1 = Math.max(top.y, bottom.y);
    const dx = Math.max(x1 - x0, 1e-6), dy = Math.max(y1 - y0, 1e-6);
    const midY = (outer.y + inner.y) / 2;
    return [(iris.x - x0) / dx, (iris.y - midY) / dy];
  }

  function extractFeatures(lm) {
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

  function expand(f) {
    const out = f.slice();
    for (const v of f) out.push(v * v);
    out.push(f[0] * f[2], f[1] * f[3], f[4] * f[5], f[8] * f[9]);
    return out;
  }

  /* ------------------------------------------------------- linear algebra */

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

  function predictGaze(f) {
    const x = expand(f);
    return { x: calib.mx.predict(x), y: calib.my.predict(x) };
  }

  function setCalibration(samples) {
    const X = samples.map((s) => expand(s.f));
    const mx = new Ridge().fit(X, samples.map((s) => s.tx));
    const my = new Ridge().fit(X, samples.map((s) => s.ty));
    calib = { mx, my };
    let err = 0;
    for (const s of samples) {
      const p = predictGaze(s.f);
      err += Math.hypot(p.x - s.tx, p.y - s.ty);
    }
    return err / samples.length;
  }

  /* -------------------------------------------------------------- drawing */

  function drawPreview(lm) {
    const w = video.videoWidth, h = video.videoHeight;
    if (previewCanvas.width !== w) { previewCanvas.width = w; previewCanvas.height = h; }
    previewCtx.clearRect(0, 0, w, h);
    if (!lm) return;
    previewCtx.save();
    previewCtx.translate(w, 0); previewCtx.scale(-1, 1);
    previewCtx.fillStyle = colors.accent;
    previewCtx.globalAlpha = 0.7;
    for (const e of EYES) {
      for (const idx of [e.outer, e.inner, e.top, e.bottom, e.iris]) {
        const p = lm[idx];
        previewCtx.beginPath();
        previewCtx.arc(p.x * w, p.y * h, 2.5, 0, 7);
        previewCtx.fill();
      }
      const c = lm[e.iris];
      previewCtx.strokeStyle = colors.trail;
      previewCtx.lineWidth = 2;
      previewCtx.beginPath();
      previewCtx.arc(c.x * w, c.y * h, 6, 0, 7);
      previewCtx.stroke();
    }
    previewCtx.restore();
  }

  function drawGaze() {
    const w = innerWidth, h = innerHeight;
    overlayCtx.clearRect(0, 0, w, h);
    if (trail.length > 1) {
      overlayCtx.lineWidth = 2;
      for (let i = 1; i < trail.length; i++) {
        const a = (i / trail.length) * 0.5;
        overlayCtx.strokeStyle = colors.trail;
        overlayCtx.globalAlpha = a;
        overlayCtx.beginPath();
        overlayCtx.moveTo(trail[i - 1].x, trail[i - 1].y);
        overlayCtx.lineTo(trail[i].x, trail[i].y);
        overlayCtx.stroke();
      }
      overlayCtx.globalAlpha = 1;
    }
    if (!smooth) return;
    const { x, y } = smooth;
    overlayCtx.save();
    overlayCtx.translate(x, y);
    overlayCtx.strokeStyle = colors.accent;
    overlayCtx.globalAlpha = 0.9;
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath(); overlayCtx.arc(0, 0, 16, 0, 7); overlayCtx.stroke();
    overlayCtx.globalAlpha = 0.4;
    overlayCtx.beginPath(); overlayCtx.arc(0, 0, 26, 0, 7); overlayCtx.stroke();
    overlayCtx.globalAlpha = 1;
    const grad = overlayCtx.createRadialGradient(0, 0, 0, 0, 0, 8);
    grad.addColorStop(0, colors.ink); grad.addColorStop(1, colors.accent);
    overlayCtx.fillStyle = grad;
    overlayCtx.beginPath(); overlayCtx.arc(0, 0, 6, 0, 7); overlayCtx.fill();
    overlayCtx.restore();
  }

  /* --------------------------------------------------------- deterministic */

  const layout = {
    grid: 5,
    dwell: 0.65,
  };

  function readSettings() {
    layout.grid = Number(el('gridSize').value) || 5;
    layout.dwell = Number(el('dwell').value) || 0.65;
  }

  function buildTargets() {
    clearTargets();
    const cols = layout.grid, rows = layout.grid;
    const count = cols * rows;

    const topPad = 108;
    const margin = 28;
    const areaW = Math.max(innerWidth - margin * 2, 200);
    const areaH = Math.max(innerHeight - topPad - margin, 200);
    const cellW = areaW / cols;
    const cellH = areaH / rows;

    const rMax = Math.max(18, Math.min(cellW, cellH) * 0.42);
    const rMin = Math.max(10, rMax * 0.4);

    let k = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const t = count === 1 ? 0 : k / (count - 1);
        const r = rMin + (rMax - rMin) * t;
        const x = margin + cellW * (col + 0.5);
        const y = topPad + cellH * (row + 0.5);

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
    readSettings();
    finished = false;
    hits = 0;
    runStart = performance.now();
    runTime = 0;
    summary.hidden = true;
    clearTargets();
    buildTargets();
    updateHud();
    const left = targets.length;
    setStatus('Calibrated \u00b7 ' + left + ' targets \u00b7 fixate the smallest first');
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
    if (!calib || !smooth || finished) return;
    if (targets.length === 0) return;
    let left = 0;
    for (const t of targets) {
      if (t.popped) continue;
      const d = Math.hypot(smooth.x - t.x, smooth.y - t.y);
      const on = d < t.r;
      t.dwell = on ? t.dwell + dt : Math.max(0, t.dwell - dt * 2);
      const p = Math.min(t.dwell / layout.dwell, 1);
      t.el.style.setProperty('--p', p + 'turn');
      if (t.dwell >= layout.dwell) {
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

  /* --------------------------------------------------------- calibration */

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

  function runCalibration() {
    return new Promise(async (resolve) => {
      if (!running || !featureVec) { resolve(null); return; }
      summary.hidden = true;
      clearTargets();
      calibEl.classList.add('on');
      const m = 0.14;
      const xs = [innerWidth * m, innerWidth * 0.5, innerWidth * (1 - m)];
      const ys = [innerHeight * m, innerHeight * 0.5, innerHeight * (1 - m)];
      const points = [];
      for (const y of ys) for (const x of xs) points.push({ x, y });

      const SETTLE = 550, COLLECT = 1300;
      const samples = [];

      calibHint.innerHTML = 'Keep your head still and follow the <b>accent dot</b> with your eyes.<br>No clicking needed \u2014 it advances by itself.';
      await new Promise((r) => setTimeout(r, 1400));

      for (let i = 0; i < points.length; i++) {
        calibHint.innerHTML = 'Calibrating \u2014 point <b>' + (i + 1) + ' / ' + points.length + '</b>';
        const cp = makeCalPoint(points[i].x, points[i].y);
        cp.wrap.classList.add('active');
        const t0 = performance.now();
        await new Promise((resolveStep) => {
          const step = (now) => {
            const t = now - t0;
            if (t < SETTLE) {
              cp.c.setAttribute('stroke-dashoffset', String(cp.circumference));
            } else {
              const p = Math.min((t - SETTLE) / COLLECT, 1);
              cp.c.setAttribute('stroke-dashoffset', String(cp.circumference * (1 - p)));
              if (featureVec) samples.push({ f: featureVec.slice(), tx: points[i].x, ty: points[i].y });
              if (p >= 1) { resolveStep(); return; }
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        cp.wrap.remove();
      }

      calibPointsEl.innerHTML = '';
      const err = samples.length > 25 ? setCalibration(samples) : null;
      calibEl.classList.remove('on');
      if (err == null) {
        calibHint.textContent = 'Not enough face data \u2014 try again with better lighting.';
        setStatus('Calibration failed');
        resolve(null);
      } else {
        calibError = err;
        smooth = null; trail = [];
        updateHud();
        setStatus('Calibrated \u00b7 mean error ' + err.toFixed(0) + ' px');
        startRun();
        resolve(err);
      }
    });
  }

  /* ------------------------------------------------------------ frame loop */

  const scheduleFrame = video.requestVideoFrameCallback
    ? (cb) => video.requestVideoFrameCallback(cb)
    : (cb) => requestAnimationFrame(() => cb(performance.now()));

  function onFrame() {
    if (!running) return;
    const now = performance.now();
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const ts = Math.max(now, lastTs + 1);
      lastTs = ts;
      let result = null;
      try { result = landmarker.detectForVideo(video, ts); } catch (e) { result = null; }
      const lm = result && result.faceLandmarks ? result.faceLandmarks[0] || null : null;
      faceStateEl.textContent = lm ? 'tracked' : 'not found';
      drawPreview(lm);
      if (lm) {
        featureVec = extractFeatures(lm);
        if (calib) {
          const g = predictGaze(featureVec);
          if (Number.isFinite(g.x) && Number.isFinite(g.y)) {
            gaze = g;
            smooth = smooth
              ? { x: smooth.x + (g.x - smooth.x) * 0.35, y: smooth.y + (g.y - smooth.y) * 0.35 }
              : { x: g.x, y: g.y };
            trail.push({ x: smooth.x, y: smooth.y });
            if (trail.length > 18) trail.shift();
          }
        }
      } else {
        featureVec = null;
      }
      drawGaze();
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
    scheduleFrame(onFrame);
  }

  /* --------------------------------------------------------------- camera */

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
    const picker = el('camPicker');
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch (e) { devices = []; }
    picker.innerHTML = '';
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Camera ' + (i + 1);
      picker.appendChild(opt);
    });
    if (currentDeviceId) picker.value = currentDeviceId;
    picker.hidden = devices.length < 2;
    return devices;
  }

  async function switchCamera(deviceId) {
    if (!running || !deviceId || deviceId === currentDeviceId) return;
    setStatus('Switching camera\u2026');
    try {
      const label = await openStream(deviceId);
      resetGazeState();
      try { localStorage.setItem(CAM_KEY, deviceId); } catch (e) {}
      setStatus('Now using "' + label + '" \u2014 recalibrate');
    } catch (err) {
      setStatus('Could not switch camera');
    }
  }

  function resetGazeState() {
    calib = null; calibError = null; smooth = null; gaze = null; trail = [];
    finished = false; hits = 0; runTime = 0;
    summary.hidden = true;
    clearTargets();
    overlayCtx.clearRect(0, 0, innerWidth, innerHeight);
    updateHud();
  }

  async function loadLandmarker() {
    const m = await import(VENDOR + 'vision_bundle.mjs');
    const fileset = await m.FilesetResolver.forVisionTasks(WASM_PATH);
    try {
      return await m.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    } catch (e) {
      setStatus('GPU failed \u2014 falling back to CPU');
      const fileset2 = await m.FilesetResolver.forVisionTasks(WASM_PATH);
      return await m.FaceLandmarker.createFromOptions(fileset2, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
    }
  }

  async function start() {
    el('btnStart').disabled = true;
    game.hidden = false;
    document.body.classList.add('game-open');
    setStatus('Loading model\u2026');
    introStatus.textContent = 'Loading model\u2026';

    try {
      landmarker = await loadLandmarker();
    } catch (e) {
      setStatus('Could not load the model');
      introStatus.textContent = 'Could not load the model \u2014 serve the page over HTTPS or localhost.';
      game.hidden = true;
      document.body.classList.remove('game-open');
      el('btnStart').disabled = false;
      return;
    }

    let savedId = null;
    try { savedId = localStorage.getItem(CAM_KEY); } catch (e) {}

    setStatus('Requesting camera\u2026');
    let label;
    try {
      label = await openStream(savedId || undefined);
    } catch (err) {
      if (savedId) {
        try { label = await openStream(undefined); }
        catch (err2) {
          cameraFailed(err2);
          return;
        }
      } else {
        cameraFailed(err);
        return;
      }
    }

    await refreshCameraList();

    running = true;
    el('preview').hidden = false;
    el('btnCalibrate').disabled = false;
    el('btnToggleCam').disabled = false;
    el('btnStop').disabled = false;
    setStatus('Using "' + label + '" \u2014 calibrate to start');
    scheduleFrame(onFrame);
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
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    currentDeviceId = null;
    resetGazeState();
    overlayCtx.clearRect(0, 0, innerWidth, innerHeight);
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
  el('btnToggleCam').addEventListener('click', (e) => {
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
