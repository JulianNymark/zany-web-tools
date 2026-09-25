# Design guide

Everything here follows [Designsystemet](https://designsystemet.no/) — the
Norwegian public sector design system (Digdir). We use the **CSS-only** build:
design system classes on plain HTML elements, no React, no build step.

Vendored, version-pinned copies live in `assets/vendor/designsystemet/`:

| File | What |
|---|---|
| `designsystemet/designsystemet.css` | `@digdir/designsystemet-css` 1.21.1 — all components |
| `designsystemet/theme.css` | `@digdir/designsystemet-theme` 1.11.0 — tokens, light/dark, `data-color` |
| `mediapipe/vision_bundle.mjs` | `@mediapipe/tasks-vision` 1.0.1 — Face Landmarker JS API (loaded with a dynamic import) |
| `mediapipe/wasm/` | `@mediapipe/tasks-vision` 1.0.1 — WASM backends, SIMD + no-SIMD (~11 MB each) |
| `mediapipe/face_landmarker.task` | Face Landmarker model, float16/1 — 478 landmarks incl. iris |

Do not edit the vendored files. To upgrade the design system, re-download both
files from npm (`dist/src/index.css` and `dist/theme/designsystemet.css`) and
update the version numbers here. To upgrade MediaPipe, re-download
`vision_bundle.mjs` and both `wasm/` backends from
`@mediapipe/tasks-vision@<version>` on npm, the model from the MediaPipe model
repository, and update the version numbers here (see
`tools/webcam-eye-tracking/README.md`).

## The include block

Copy this into every page's `<head>`, fixing the relative depth
(`assets/…` from the root, `../../assets/…` from `tools/<name>/`):

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="assets/vendor/designsystemet/designsystemet.css">
<link rel="stylesheet" href="assets/vendor/designsystemet/theme.css">
<link rel="stylesheet" href="assets/site.css">
```

Then the page shell:

```html
<html lang="en" data-color-scheme="auto">   <!-- auto = follow the OS theme -->
<a class="ds-skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap site-header__bar">
    <a class="site-brand" href="../../"><span class="site-brand__mark" aria-hidden="true">z</span> Zany Web Tools</a>
    <nav class="site-nav" aria-label="Main">
      <a href="../../">All tools</a>
    </nav>
  </div>
</header>
<main id="main"> … </main>
<footer class="site-footer">
  <div class="wrap site-footer__row"><span>…</span></div>
</footer>
```

`assets/site.css` adds `.wrap`, the header/footer, the hub grid, and
`.app-shell` for full-height tools. It is unlayered so it beats DS's
`@layer ds.*` without `!important`, but **prefer DS tokens over new colours**.

## Components cheat-sheet

All verified against the vendored 1.21.1 CSS. `data-size` (`sm|md|lg`) and
`data-color` (`accent|neutral|brand1|brand2|success|warning|danger|info`)
inherit from the nearest ancestor that sets them.

```html
<button class="ds-button">Primary</button>
<button class="ds-button" data-variant="secondary" data-size="sm">Secondary</button>
<a class="ds-button" data-variant="tertiary" href="…">Button that is a link</a>

<div class="ds-card"><div class="ds-card__block">…</div></div>
<div class="ds-card" data-variant="tinted">…</div>

<details class="ds-details">
  <summary>Expandable section</summary>
  …
</details>

<div class="ds-field">
  <label class="ds-label" for="x">Label</label>
  <input class="ds-input" id="x" type="text">
</div>
<select class="ds-input">…</select>
<input class="ds-input" type="checkbox" id="c"><label class="ds-label" for="c">Choice</label>

<p class="ds-paragraph">Body copy</p>
<h2 class="ds-heading" data-size="sm">Heading</h2>
<a class="ds-link" href="…">Link</a>
<hr class="ds-divider" aria-hidden="true">

<span class="ds-tag">Tag</span>
<span class="ds-tag" data-variant="outline">Outlined tag</span>
<div class="ds-alert" data-color="warning" role="status">Notice</div>
```

Anything not in DS (a chart legend, a floating map control) gets plain markup in
the page's own stylesheet, built from `--ds-*` variables so light/dark both work.

## Rules

1. **Relative paths only.** GitHub Pages serves the site from
   `/<repo>/`, so `/assets/…` breaks. Use `../../assets/…` from a tool folder.
2. **One folder per tool** under `tools/<kebab-name>/`, entry point always
   `index.html`. Keep the tool's own CSS in `tools/<name>/tool.css`.
3. **No dependencies except vendored ones.** No npm install, no bundler, no
   framework. Vanilla JS in a plain `<script>` (no ES modules at the top level
   if you want the page to work from `file://`).
4. **Content before decoration.** The answer a visitor came for (a number, a
   result) goes at the top of the page; method notes, data sources and
   caveats go inside a `<details class="ds-details">` at the bottom.
5. **Keep small grey text out of the main flow.** If a sentence is only for
   people who care how it works, it belongs in that `<details>`.
6. **Accessibility is not optional**: one `<h1>`, labelled inputs, `alt` text,
   visible focus (DS handles it — don't remove outlines), and the skip link.
7. **Every page works with JavaScript disabled** at least to the point of
   showing its content and links.
8. **Register the tool** on `index.html` with a card: a tag, an `<h3>`, one
   paragraph, and a link to `tools/<name>/`.

## Adding a tool — checklist

- [ ] `mkdir tools/my-tool` with `index.html` (+ `tool.css`, `app.js` as needed)
- [ ] Copy the include block and page shell, fix the `../../` depths
- [ ] `<title>`, `<meta name="description">`, one `<h1>`
- [ ] Build the UI from DS components; put extras in `tool.css` using `--ds-*`
- [ ] Add a card to the hub's `.tool-grid`
- [ ] Open it with and without JavaScript, narrow the window to ~360 px
- [ ] Screenshot it (see the `browser-playwright` skill) before calling it done