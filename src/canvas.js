'use strict';

// Pure canvas logic: parsing, path safety and artboard loading.
// Deliberately free of any `vscode` dependency so it can be unit-tested with plain Node.

const fs = require('fs');
const path = require('path');

const DEFAULT_ARTBOARD_W = 390;
const DEFAULT_ARTBOARD_H = 844;
const DEFAULT_NOTE_W = 300;

// Artboards must look like a browser viewport of exactly w x h, minus scrollbars.
// Only overflow/scrollbars are touched on purpose: forcing width/height/margin on <html>/<body>
// breaks pages that use body padding (content-box overflow) or `margin: 0 auto`.
const SCROLL_RESET_CSS = `<style data-claude-canvas-scroll-reset>
html,body{
  overflow:hidden!important;
  scrollbar-width:none!important;
  -ms-overflow-style:none!important;
  overscroll-behavior:none!important;
}
*,*::before,*::after{
  scrollbar-width:none!important;
  -ms-overflow-style:none!important;
}
::-webkit-scrollbar,
*::-webkit-scrollbar{
  display:none!important;
  width:0!important;
  height:0!important;
}
</style>`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toSize(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse and normalise the text of a canvas.json / *.canvas file.
 * Returns `{ canvas }` on success or `{ error }` when the file is unusable.
 * Never throws.
 */
function parseCanvas(text) {
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (e) {
    return { error: `Invalid JSON: ${e.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Not a Claude canvas file: expected a JSON object with an "artboards" array.' };
  }

  let warning;
  if (!Array.isArray(raw.artboards)) {
    warning = Array.isArray(raw.nodes)
      ? 'This looks like a canvas from another tool (it has "nodes", not "artboards").'
      : 'No "artboards" array found in this file.';
  }

  const isObject = v => v && typeof v === 'object';
  const artboards = (Array.isArray(raw.artboards) ? raw.artboards : [])
    .filter(isObject)
    .map((a, i) => {
      const file = typeof a.file === 'string' ? a.file : '';
      return {
        file,
        title: String(a.title || file || `Artboard ${i + 1}`),
        x: toNumber(a.x, 0),
        y: toNumber(a.y, 0),
        w: toSize(a.w, DEFAULT_ARTBOARD_W),
        h: toSize(a.h, DEFAULT_ARTBOARD_H)
      };
    });

  const annotations = (Array.isArray(raw.annotations) ? raw.annotations : [])
    .filter(isObject)
    .map(a => ({
      text: String(a.text ?? ''),
      x: toNumber(a.x, 0),
      y: toNumber(a.y, 0),
      w: toSize(a.w, DEFAULT_NOTE_W)
    }));

  return { canvas: { artboards, annotations, warning } };
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

async function realpathOrSelf(p) {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Inject the scroll-reset stylesheet without disturbing the document's mode:
 * putting a <style> before <!doctype> would switch the page into quirks mode.
 */
function injectScrollReset(html) {
  const before = (re) => {
    const m = re.exec(html);
    return m ? html.slice(0, m.index) + SCROLL_RESET_CSS + html.slice(m.index) : null;
  };
  const after = (re) => {
    const m = re.exec(html);
    return m ? html.slice(0, m.index + m[0].length) + SCROLL_RESET_CSS + html.slice(m.index + m[0].length) : null;
  };
  return before(/<\/head\s*>/i)
    || after(/<head(\s[^>]*)?>/i)
    || after(/<html(\s[^>]*)?>/i)
    || after(/^\s*<!doctype[^>]*>/i)
    || SCROLL_RESET_CSS + html;
}

function errorDocument(message) {
  return '<!doctype html><meta charset="utf-8">'
    + `<div style="padding:24px;font:14px sans-serif;color:#b00020">${escapeHtml(message)}</div>`;
}

/**
 * Resolve an artboard's `file` against the canvas directory and read it.
 * The file must live inside one of `roots` (after symlink resolution).
 * Returns `{ html, path }` or `{ error, path?, blocked? }`.
 */
async function readArtboard(baseDir, file, roots) {
  if (!file) return { error: 'No "file" specified for this artboard.' };
  if (file.includes('\0')) return { error: 'Invalid file name.', blocked: true };

  const full = path.resolve(baseDir, file);
  let real;
  try {
    real = await fs.promises.realpath(full);
  } catch {
    return { error: `File not found: ${file}`, path: full };
  }
  if (!roots.some(root => isInside(root, real))) {
    return { error: `Blocked: ${file} is outside the canvas folder and the workspace.`, blocked: true };
  }
  try {
    return { html: await fs.promises.readFile(real, 'utf8'), path: full };
  } catch (e) {
    return { error: `Cannot read ${file}: ${e.code || e.message}`, path: full };
  }
}

/**
 * Load a canvas file and every artboard it references.
 *
 * Returns either `{ error }` or
 *   `{ canvas, paths, watch }` where
 *   - `canvas`  is the webview-facing model (artboards carry a ready-to-use `srcdoc`),
 *   - `paths`   maps artboard index -> absolute source path (host side only),
 *   - `watch`   lists every absolute path whose change should trigger a reload.
 */
async function loadCanvas(canvasFile, extraRoots = []) {
  const baseDir = path.dirname(canvasFile);

  let text;
  try {
    text = await fs.promises.readFile(canvasFile, 'utf8');
  } catch (e) {
    return { error: `Cannot read ${path.basename(canvasFile)}: ${e.code || e.message}` };
  }

  const parsed = parseCanvas(text);
  if (parsed.error) return parsed;

  const roots = await Promise.all([baseDir, ...extraRoots].map(realpathOrSelf));
  const results = await Promise.all(
    parsed.canvas.artboards.map(a => readArtboard(baseDir, a.file, roots))
  );

  const artboards = parsed.canvas.artboards.map((a, i) => {
    const r = results[i];
    return {
      ...a,
      srcdoc: r.error ? errorDocument(r.error) : injectScrollReset(r.html),
      error: r.error
    };
  });

  return {
    canvas: { ...parsed.canvas, artboards },
    paths: results.map(r => r.path || null),
    watch: [canvasFile, ...results.filter(r => r.path && !r.blocked).map(r => r.path)]
  };
}

module.exports = {
  escapeHtml,
  parseCanvas,
  isInside,
  injectScrollReset,
  readArtboard,
  loadCanvas
};
