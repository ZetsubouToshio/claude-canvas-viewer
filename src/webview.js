'use strict';

// Static HTML shell for the canvas webview. All dynamic content (artboards, notes)
// is delivered later via postMessage and built with DOM APIs in media/viewer.js,
// so nothing user-controlled is ever interpolated into markup here.

/**
 * @param {{ cspSource: string, cssUri: string, jsUri: string }} opts
 *
 * CSP notes: artboards are rendered in <iframe srcdoc> and inherit this policy, which is why
 * `script-src` allows 'unsafe-inline' (artboard scripts) and the viewer's own script is loaded
 * from `cspSource` instead of an inline nonce (a nonce would make browsers ignore
 * 'unsafe-inline' and block every artboard script). The iframes are sandboxed without
 * `allow-same-origin`, and `connect-src` falls back to 'none', so artboards cannot reach
 * the VS Code API or make network requests.
 */
function getWebviewHtml({ cspSource, cssUri, jsUri }) {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data: blob: https:`,
    `font-src ${cspSource} data: https:`,
    `style-src ${cspSource} 'unsafe-inline' https:`,
    `script-src ${cspSource} 'unsafe-inline' https:`,
    'frame-src https:'
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>Claude Canvas</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="Canvas controls">
  <button id="minus" title="Zoom out (-)" aria-label="Zoom out">−</button>
  <span id="zoom" aria-live="off">100%</span>
  <button id="plus" title="Zoom in (+)" aria-label="Zoom in">+</button>
  <button id="fit" title="Fit all artboards (0)">Fit</button>
  <button id="reset" title="Reset view (1)">Reset</button>
  <div class="sep"></div>
  <button id="list" title="Artboards">☰ Screens</button>
  <button id="reload" title="Reload" aria-label="Reload">↻</button>
  <button id="source" title="Open canvas file as text" aria-label="Open as text">{ }</button>
  <span id="status"></span>
</div>
<div id="sidebar">
  <div id="sidehead"><span>Artboards</span><button id="close" aria-label="Close">×</button></div>
  <div id="toc"></div>
</div>
<div id="main"><div id="world"></div></div>
<div id="empty" hidden>No artboards to show.</div>
<div id="banner" role="alert" hidden></div>
<script src="${jsUri}"></script>
</body>
</html>`;
}

module.exports = { getWebviewHtml };
