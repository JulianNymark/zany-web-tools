/* Comparator: the browser eye-tracking libraries we considered.
   `tech` is the one-line label shown in the dropdown/subtitle; `integrated`
   means it can actually be selected in the toolbar. Baked counts are a
   snapshot; live values are fetched (and cached) from the GitHub API. */

const SNAPSHOT_DATE = '2026-09-25';

const ALTERNATIVES = [
  {
    name: 'MediaPipe Face Landmarker',
    tech: 'Neural net · WebAssembly · iris landmarks',
    integrated: true,
    repo: 'google-ai-edge/mediapipe',
    demo: 'https://mediapipe-studio.webapps.google.com/',
    license: 'Apache-2.0',
    approach: '478-point face model (incl. iris) + our own ridge regression',
    note: 'Precise iris landmarks, and you bring the calibration. Note that FaceLandmarker\u2019s iris landmarks are known to be weaker than the older FaceMesh refine pass for gaze, so a constant offset can remain. Actively maintained.',
    stars: 37072,
    pushed: '2026-09-25',
  },
  {
    name: 'clmtrackr',
    tech: 'Classic CV · no ML · no iris',
    integrated: true,
    repo: 'auduno/clmtrackr',
    demo: 'https://www.auduno.com/clmtrackr/examples/',
    license: 'MIT',
    approach: 'Constrained local models (regularized landmark mean-shift)',
    note: 'Tiny and dependency-free, but head-pose-only gaze and unmaintained since 2020.',
    stars: 6498,
    pushed: '2020-01-10',
  },
  {
    name: 'WebGazer.js',
    tech: 'Regression \u00b7 TF.js + MediaPipe \u00b7 self-trained from dots',
    integrated: true,
    repo: 'brownhci/WebGazer',
    demo: 'https://webgazer.cs.brown.edu/',
    license: 'GPL-3.0-or-later',
    approach: 'Pixel-feature regression, trained live from your calibration samples',
    note: 'Runs here too. It owns the camera and self-calibrates from the dots; the script and face-mesh assets are fetched from jsDelivr, so the video still never leaves the page.',
    stars: 3897,
    pushed: '2026-02-24',
  },
  {
    name: 'TensorFlow.js face-landmarks-detection',
    tech: 'Neural net · TF.js WebGL · no iris',
    repo: 'tensorflow/tfjs-models',
    demo: 'https://github.com/tensorflow/tfjs-models/tree/master/face-landmarks-detection',
    license: 'Apache-2.0',
    approach: 'MediaPipe FaceMesh ported to the TF.js runtime (468 pts)',
    note: 'Useful if you already load TF.js; slower and coarser than the WebAssembly path.',
    stars: 14812,
    pushed: '2026-06-23',
  },
  {
    name: 'face-api.js',
    tech: 'Neural net · TF.js · unmaintained',
    repo: 'justadudewhohacks/face-api.js',
    demo: 'https://justadudewhohacks.github.io/face-api.js/',
    license: 'MIT',
    approach: 'SSD detection + landmark CNNs on TF.js',
    note: 'Popular and easy, but effectively unmaintained since 2024.',
    stars: 17967,
    pushed: '2024-01-24',
  },
  {
    name: 'ml5.js faceMesh',
    tech: 'Wrapper · neural net · teaching',
    repo: 'ml5js/ml5-library',
    demo: 'https://docs.ml5js.org/#/reference/facemesh',
    license: 'Custom / MIT-style',
    approach: 'Friendly wrapper around MediaPipe FaceMesh',
    note: 'Made for teaching and creative coding; an extra abstraction over this same model.',
    stars: 6583,
    pushed: '2024-10-11',
  },
  {
    name: 'SeeSo / Eyedid web SDK',
    tech: 'Commercial · hosted model',
    repo: null,
    demo: 'https://eyedid.com/',
    license: 'Commercial',
    approach: 'Hosted gaze model + calibration service',
    note: 'Strong out-of-the-box accuracy, but closed source, paid and usage-limited.',
  },
  {
    name: 'GazeCloudAPI',
    tech: 'Commercial · hosted script',
    repo: null,
    demo: 'https://gazerecorder.com/gazecloudapi/',
    license: 'Commercial / freemium',
    approach: 'Drop-in hosted webcam gaze tracking',
    note: 'Fastest to integrate if you accept a hosted service you do not control.',
  },
];

const STAR_CACHE_KEY = 'eyegaze.stars.v1';
const STAR_TTL_MS = 60 * 60 * 1000;

function formatStars(n) {
  if (!Number.isFinite(n)) return null;
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

function repoUrl(repo) { return 'https://github.com/' + repo; }

function readCache() {
  try {
    const raw = localStorage.getItem(STAR_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}

function writeCache(cache) {
  try { localStorage.setItem(STAR_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
}

function starsLabel(item, live) {
  if (!item.repo) return item.license;
  const stars = live && Number.isFinite(live.stars) ? live.stars : item.stars;
  const pushed = live && live.pushed ? live.pushed : item.pushed;
  const f = formatStars(stars);
  if (f == null) return '';
  const when = pushed ? ' \u00b7 ' + pushed.slice(0, 7) : '';
  return '\u2605 ' + f + when;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function render() {
  const root = document.getElementById('comparator');
  if (!root) return;
  root.textContent = '';

  ALTERNATIVES.forEach((item, i) => {
    const details = el('details', 'tracker');
    if (i === 0) details.open = true;

    const summary = el('summary');
    summary.appendChild(el('span', 'tracker__name', item.name));
    if (item.integrated) summary.appendChild(el('span', 'tracker__used', 'runs here'));

    const stars = el('span', 'tracker__stars', starsLabel(item));
    if (item.repo) {
      stars.dataset.loading = 'true';
      stars.dataset.repo = item.repo;
    }
    summary.appendChild(stars);
    summary.appendChild(el('span', 'tracker__arrow', '\u203a'));
    details.appendChild(summary);

    const body = el('div', 'tracker__body');
    body.appendChild(el('p', 'tracker__tech', item.tech));

    const dl = el('dl', 'tracker__row');
    const rows = [];
    if (item.repo) rows.push(['Repo', repoUrl(item.repo), item.repo]);
    rows.push(['Approach', null, item.approach]);
    rows.push(['Licence', null, item.license]);
    rows.push(['Maintenance', null, item.pushed ? 'last push ' + item.pushed : 'hosted service']);
    for (const [label, href, value] of rows) {
      dl.appendChild(el('dt', null, label));
      const dd = el('dd');
      if (href) {
        const a = el('a', 'ds-link', value);
        a.href = href;
        a.rel = 'noopener';
        dd.appendChild(a);
      } else {
        dd.textContent = value;
      }
      dl.appendChild(dd);
    }
    body.appendChild(dl);
    body.appendChild(el('p', 'ds-paragraph', item.note));

    const links = el('div', 'tracker__links');
    if (item.repo) {
      const repoLink = el('a', 'ds-link', 'GitHub repo');
      repoLink.href = repoUrl(item.repo);
      repoLink.rel = 'noopener';
      links.appendChild(repoLink);
    }
    const demoLink = el('a', 'ds-link', 'Try it / demo');
    demoLink.href = item.demo;
    demoLink.rel = 'noopener';
    links.appendChild(demoLink);
    body.appendChild(links);

    details.appendChild(body);
    root.appendChild(details);
  });
}

async function hydrateStars() {
  const cache = readCache();
  const now = Date.now();
  const nodes = document.querySelectorAll('.tracker__stars[data-repo]');

  for (const node of nodes) {
    const repo = node.dataset.repo;
    const item = ALTERNATIVES.find((a) => a.repo === repo);
    const cached = cache[repo];
    if (cached && now - cached.at < STAR_TTL_MS) {
      node.textContent = starsLabel(item, cached);
      node.dataset.loading = 'false';
      continue;
    }
    try {
      const res = await fetch('https://api.github.com/repos/' + repo, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const live = { stars: data.stargazers_count, pushed: (data.pushed_at || '').slice(0, 10) };
      cache[repo] = { ...live, at: now };
      node.textContent = starsLabel(item, live);
      node.dataset.loading = 'false';
    } catch (e) {
      node.textContent = starsLabel(item);
      node.dataset.loading = 'false';
    }
  }
  writeCache(cache);
}

function note() {
  const node = document.getElementById('compareNote');
  if (!node) return;
  node.textContent = 'Stars and last-push dates come from the GitHub API on load '
    + '(cached for an hour); a ' + SNAPSHOT_DATE + ' snapshot is shown if the request is blocked.';
}

render();
note();
hydrateStars();
