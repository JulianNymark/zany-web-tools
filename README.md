# Zany Web Tools

Small, single-purpose web pages. Static files, no build step, no framework,
no accounts. Styled with [Designsystemet](https://designsystemet.no/).

**Live site:** <https://juliannymark.github.io/zany-web-tools/>

## Tools

| Tool | What it does |
|---|---|
| [`tools/tree-coverage/`](tools/tree-coverage/) | Park & tree coverage sampler — the "30" of the 3-30-300 rule, sampled per square |
| [`tools/webcam-eye-tracking/`](tools/webcam-eye-tracking/) | Pop a deterministic grid of bubbles with your gaze — on-device webcam eye tracking, swap between MediaPipe, clmtrackr and WebGazer.js |

## Layout

```
index.html                 hub — one card per tool
DESIGN.md                  design guide: shell, components, rules, checklist
assets/site.css            shared shell (header, footer, hub grid, app layout)
assets/vendor/             pinned third-party CSS/JS (designsystemet, maplibre, mediapipe, clmtrackr; WebGazer loads from CDN)
tools/<name>/index.html    one folder per tool, entry point
```

Read [`DESIGN.md`](DESIGN.md) before adding a tool. The short version: relative
paths only, DS components for UI, the answer at the top, the explanation inside
a `<details>` at the bottom, and a card on the hub.

## Preview locally

Any static server works:

```sh
python3 -m http.server 8000      # then open http://localhost:8000/
```

Some tools (anything with a map or web workers) do **not** work when opened as
`file://` — the browser blocks workers and canvas fetches from a null origin.
Use the server above, or the live GitHub Pages URL.

## Publish (GitHub Pages)

1. Commit and push `main`:

   ```sh
   git add -A
   git commit -S -m "Add zany web tools hub and tree-coverage tool"
   git push -u origin main
   ```

2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, pick **Deploy from a branch**.
4. **Branch:** `main`, **folder:** `/ (root)` → **Save**.
5. Wait ~1 minute, reload the Pages settings, and it shows the URL:
   `https://<user>.github.io/zany-web-tools/`.
6. Notes:
   - Pages on a **private** repo needs a paid plan; on a free account the repo
     must be public.
   - `.nojekyll` is present so GitHub serves the files as-is (Jekyll otherwise
     skips some paths and adds build time).
   - Everything must use **relative** links, because the site lives under
     `/<repo>/` — `/assets/...` would 404.
   - Each push to `main` redeploys automatically; allow a minute and hard-refresh.
   - Optional custom domain: Settings → Pages → Custom domain (adds a `CNAME`).