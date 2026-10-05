# Claude Canvas Viewer

[![CI](https://github.com/ZetsubouToshio/claude-canvas-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/ZetsubouToshio/claude-canvas-viewer/actions/workflows/ci.yml)

VS Code viewer for Claude Code Design `canvas.json` / `.canvas` files: every `.dc.html` artboard is
rendered at its declared position and size on a pan-and-zoom canvas, and updates live while Claude
(or you) edits the files.

> Status: pre-1.0. See the [roadmap](ROADMAP.md) and the [changelog](CHANGELOG.md).

## Features

- Custom editor for `canvas.json` and `*.canvas`
- Renders `.dc.html` artboards at their declared x / y / w / h, with scripts running (see [Security](#security-model))
- Pan (drag) and zoom (mouse wheel / pinch) — also when the pointer is over an artboard
- Fit / Reset, artboard list with jump-to-screen
- Interactive mode: click inside an artboard (double-click it, or press its **Interact** button)
- Live reload when `canvas.json` **or any referenced `.dc.html`** changes; only changed artboards are redrawn
- Pan/zoom is remembered across reloads and tab switches
- Several canvases can be open side by side
- Open an artboard's source (`↗`) or the canvas file itself as text (`{ }`)

## Install

### From a `.vsix`

1. Get `claude-canvas-viewer-x.y.z.vsix` from the [Releases](https://github.com/ZetsubouToshio/claude-canvas-viewer/releases) page,
   or [build it yourself](#building-from-source).
2. `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file
   (or run `code --install-extension claude-canvas-viewer-x.y.z.vsix`).
3. Open a `canvas.json` or `*.canvas` file. It opens in **Claude Canvas** by default; use
   **Reopen Editor With…** to get the text editor back.

Requires VS Code 1.85 or newer, with a local (non-virtual) workspace.

## Usage

| Action | How |
| --- | --- |
| Pan | Drag anywhere on the canvas (also over artboards) |
| Zoom | Mouse wheel / trackpad pinch at the pointer, `+` / `-`, toolbar buttons |
| Fit all artboards | `0` or **Fit** |
| 100% | `1` or **Reset** |
| Jump to an artboard | **☰ Screens**, then pick one |
| Click inside an artboard | Double-click it, or its **Interact** button; click the empty canvas to leave |
| Close the list / leave interactive mode | `Esc` (only while the viewer, not an artboard, has keyboard focus) |
| Open an artboard's HTML | `↗` next to its title |
| Open the canvas file as text | `{ }` in the toolbar, or **Claude Canvas: Open Canvas as Text** |
| Force the viewer for a file | **Claude Canvas: Open Canvas**, the Explorer context menu, or `Ctrl+Alt+C` on a canvas file |

Keyboard shortcuts ignore `Ctrl` / `Cmd` / `Alt` combinations so VS Code's own shortcuts keep working.

### Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeCanvas.runArtboardScripts` | `true` | Run scripts inside artboards. Always off in untrusted workspaces. |

## Canvas file format

The viewer understands this subset of a Claude Code Design canvas:

```jsonc
{
  "artboards": [
    // x, y: position on the canvas; w, h: size in px (defaults: 0, 0, 390, 844)
    { "title": "Login", "file": "screens/login.dc.html", "x": 0, "y": 0, "w": 390, "h": 844 }
  ],
  "annotations": [
    // free-text sticky notes (default width 300)
    { "text": "Entry point", "x": 0, "y": 880, "w": 390 }
  ]
}
```

`file` is resolved relative to the canvas file. Unknown fields are ignored. Broken input never
blanks the editor: a bad entry is skipped, a missing artboard file is shown as an error inside its
frame, and invalid JSON keeps the previous render on screen with an error banner (handy while a file
is being written). Try it on [`examples/basic`](examples/basic/canvas.json).

## Security model

Canvas files and artboards can come from anywhere (a cloned repo, a model), so:

- **Artboards run in a sandboxed `<iframe>`** without `allow-same-origin`: they cannot touch the viewer,
  the VS Code API or your files. The page's Content-Security-Policy gives them no `fetch`/XHR;
  images, fonts, styles and scripts over `https:` and inline code are allowed.
- **Scripts only run in trusted workspaces**, and only if `claudeCanvas.runArtboardScripts` is on.
  In an untrusted workspace artboards render as static HTML.
- **Artboard files must live inside the canvas folder or an open workspace folder** (symlinks are
  resolved first). Anything else, such as `"file": "../../.ssh/config"`, is refused.
- The viewer never builds markup from file contents; everything is set with DOM properties.

Known limitation: relative assets referenced from an artboard (`<img src="img/a.png">`) don't load yet;
inline them as `data:` URIs or use `https:` URLs. See the [roadmap](ROADMAP.md).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `.canvas` file from another tool (e.g. Obsidian) shows an empty canvas and a yellow banner | Only the Claude canvas format is supported; use **Reopen Editor With… → Text Editor** |
| "Blocked: … is outside the canvas folder and the workspace" | Move the artboard under the canvas folder, or open its parent folder in VS Code |
| Artboard shows "File not found" | Check `file` (paths are relative to the canvas file); the artboard appears as soon as the file is created |
| Buttons in an artboard do nothing | Double-click the artboard first (interactive mode). Scripts are also off in untrusted workspaces — trust the workspace |
| Keys do nothing after clicking inside an artboard | Keyboard focus is inside the artboard; click the empty canvas first |

## Building from source

Requirements: [Node.js](https://nodejs.org/) **22+** (the VSIX packager requires it), npm, Git, and
VS Code 1.85+ for trying the result. The extension has **no runtime dependencies and no build step** —
the sources in `src/` and `media/` are what ships.

```bash
git clone https://github.com/ZetsubouToshio/claude-canvas-viewer.git
cd claude-canvas-viewer
npm ci                      # installs dev tooling only (eslint, vsce, playwright-core)
```

### Run it while developing

Open the folder in VS Code and press **F5** (*Run Extension*): an Extension Development Host starts with
[`examples/basic`](examples/basic) open. Open `canvas.json` there. Without the debugger:

```bash
code --extensionDevelopmentPath=. examples/basic
```

After editing code, reload the host window (`Ctrl+R` in it) or restart the debug session.

### Check

```bash
npm run lint        # ESLint
npm test            # unit tests (node:test, no VS Code needed)
npm run test:e2e    # webview tests in headless Chromium
npm run check       # lint + unit tests
```

`npm run test:e2e` needs a Chromium: either `npx playwright-core install chromium`, or point
`CHROMIUM_PATH` at an existing Chrome/Chromium binary. Without a browser the test is skipped, not failed.

### Build the `.vsix`

```bash
npm run package     # writes claude-canvas-viewer-<version>.vsix into the repo root
```

`npm run package` first runs lint and the unit tests (via `vscode:prepublish`), then
[`vsce`](https://github.com/microsoft/vscode-vsce) packs `src/`, `media/`, `package.json`, `README.md`,
`CHANGELOG.md` and `LICENSE` (see [`.vscodeignore`](.vscodeignore)). Install the result as described in
[Install](#from-a-vsix).

### Release

1. Update `CHANGELOG.md` and bump the version: `npm version <patch|minor|major> --no-git-tag-version`.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin master vX.Y.Z`.
3. The [Release workflow](.github/workflows/release.yml) checks that the tag matches `package.json`,
   builds the VSIX and attaches it to a GitHub Release. CI ([`ci.yml`](.github/workflows/ci.yml)) runs the same checks on
   every push and pull request.

Publishing to the VS Code Marketplace / Open VSX needs a registered publisher ID instead of `"local"`
in `package.json` and an access token; this is tracked in the [roadmap](ROADMAP.md).

### Project layout

```
src/extension.js    activation, custom editor provider, per-canvas view (watchers, reload, messages)
src/canvas.js       pure logic: parsing, path safety, artboard loading (no vscode dependency)
src/webview.js      HTML shell and Content-Security-Policy of the webview
media/viewer.js     webview client: rendering, pan/zoom, interactive mode
media/viewer.css    webview styles
examples/basic/     sample canvas used for development, F5 and tests
test/unit/          node:test unit tests (fake `vscode` in test/unit/helpers)
test/e2e/           headless-Chromium tests of the webview client
```

## License

[MIT](LICENSE)
