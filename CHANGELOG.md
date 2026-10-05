# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) once 1.0 is released (see [ROADMAP.md](ROADMAP.md)).

## [0.3.0] - Unreleased

Stabilisation release: the result of a full code review. No new canvas format features; the viewer
now behaves the way the README always claimed.

### Fixed

- **Two canvases open at once broke each other.** State lived in module globals, so opening a second
  canvas disabled auto-reload of the first, and the first one's Reload button showed the second file.
  Every editor now owns its file, watchers and load sequencing.
- **Scripts inside artboards never ran.** `data:` iframes inherit the webview's CSP, whose
  `script-src` only allowed the viewer's own nonce. The viewer script is now an external file and the
  policy allows artboard scripts (still sandboxed, see *Security*).
- **Declared but unregistered contributions.** The `claudeCanvas.viewer` editor (a second, identical
  "Claude Canvas" entry in *Open With…*) and the `claudeCanvas.openViewer` command (used by the Explorer
  context menu) were never registered and failed when used. There is now one editor and working
  commands; the `onCustomEditor:claudeCanvas.viewer` activation event pointed at the dead editor.
- `Ctrl+Alt+C` was bound globally, and while a custom editor was focused it only answered "Select
  canvas.json or a .canvas file first." It is now limited to canvas files and resolves the file from
  the active tab.
- Wheel zoom and drag-to-pan did nothing over an artboard (the iframe swallowed the events), and a
  drag that ended over an artboard stayed "stuck". Artboards are now click-through until put in
  interactive mode.
- **Layout fidelity:** the injected stylesheet forced `width/height: 100%` and `margin: 0` on `html`/`body`,
  which clipped pages with body padding and broke `margin: 0 auto`. Only scrollbars are suppressed now.
  The stylesheet is also no longer placed before `<!doctype>`, which switched pages into quirks mode.
- A canvas with `"file": ""`, an artboard pointing at a directory, or a JSON file containing `null`
  threw inside the provider and left a blank editor. They now produce an in-frame or banner error.
- Zoom speed on trackpads (a fixed 10% step per wheel event) — zoom is now proportional to the delta.
- Keyboard shortcuts no longer fire for `Ctrl`/`Cmd`/`Alt` combinations (e.g. VS Code's `Ctrl+-`).
- Reloading no longer resets pan/zoom, and a half-written canvas file keeps the previous render on
  screen with an error banner instead of emptying the view.
- Artboards of about 2 MB or more rendered blank: Chromium refuses `data:` URLs that large, and
  percent-encoding makes non-ASCII text or embedded images grow quickly. Artboards use `srcdoc` now.
- The "file deleted" toast was sent to a webview that never listened for it.

### Added

- Live reload when a referenced `.dc.html` changes (previously only `canvas.json` was watched),
  debounced, with one cheap non-recursive watcher per directory. Only artboards whose content changed
  are redrawn.
- Interactive mode per artboard (double-click / **Interact** button) and the `1` key for 100%.
- Pan/zoom persisted per editor across reloads and tab switches.
- Toolbar button and command **Claude Canvas: Open Canvas as Text**.
- Warning banner for files without an `artboards` array (e.g. Obsidian `.canvas` files).
- Setting `claudeCanvas.runArtboardScripts`; Workspace Trust and virtual-workspace declarations.
- Unit tests (`node:test`, fake `vscode`), browser tests (headless Chromium), ESLint, GitHub Actions
  CI and release workflows, `.vscodeignore`, F5 launch config, `examples/basic`.
- Build and release documentation in the README; [ROADMAP.md](ROADMAP.md).

### Changed

- Source layout: `extension.js` → `src/extension.js`, `src/canvas.js` (pure logic), `src/webview.js`,
  `media/viewer.{js,css}`. The webview is now a static shell filled via `postMessage`; no canvas data is
  ever interpolated into markup.
- Artboard files must be inside the canvas folder or an open workspace folder (symlinks resolved).
  Previously any readable path was loaded, including `../../…` and absolute paths.
- The webview only has access to the extension's `media/` folder (was: the canvas folder).
- Artboards are click-through by default (see interactive mode above).
- Package metadata: `license`, `repository`, `bugs`, `homepage`, `keywords`, categories, `engines.node`.

### Security

- Artboard file paths are validated against allowed roots; the webview can only ask the host to open an
  artboard by index, never by path.
- Artboard scripts are disabled in untrusted workspaces and can be turned off with a setting.
- Messages posted by artboard scripts to the viewer are ignored.

## [0.2.1]

- Fixed scrollbars appearing inside `.dc.html` artboards.
- Hidden scrollbars on html/body and nested elements in embedded artboards.
- Added `scrolling="no"` to artboard iframes.

## Earlier

See the git history.
