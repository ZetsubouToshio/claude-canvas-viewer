# Claude Canvas Viewer

VS Code viewer for Claude Code Design `canvas.json` / `.canvas` files.

## VS Code install: 
- Ctrl+Shift+P
- Extensions: Install from VSIX...
- Choose claude-canvas-viewer-x.x.x.vsix
- Open canvas.json
- If VS Code asks editor — choose Claude Canvas

## Features:
- Custom editor for `canvas.json` and `*.canvas`
- Renders `.dc.html` artboards at their declared x/y/w/h
- Pan and mouse-wheel zoom
- Fit / Reset
- Artboard sidebar with jump-to-screen
- Open source `.dc.html` from each artboard
- Auto-reload when canvas.json changes
- Reload button
- Keyboard: `0` fit, `+`/`-` zoom, `Esc` close sidebar


## 0.2.1
- Fixed scrollbars appearing inside `.dc.html` artboards.
- Hidden scrollbars on html/body and nested elements in embedded artboards.
- Added `scrolling="no"` to artboard iframes.
