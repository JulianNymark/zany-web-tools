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