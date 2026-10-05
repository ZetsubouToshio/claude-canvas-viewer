// Webview client for Claude Canvas Viewer.
// Receives { type: 'update' | 'error', ... } messages from the extension host and renders
// them with DOM APIs only (textContent / properties), so canvas data is never parsed as markup.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const main = $('main');
  const world = $('world');
  const zoomEl = $('zoom');
  const sidebar = $('sidebar');
  const toc = $('toc');
  const statusEl = $('status');
  const emptyEl = $('empty');
  const banner = $('banner');

  const MIN_SCALE = 0.1;
  const MAX_SCALE = 4;
  const DRAG_THRESHOLD = 3;

  let scale = 1, tx = 60, ty = 90;
  let hasView = false;       // true once the user (or restored state) has a meaningful viewport
  let allowScripts = true;
  const boards = [];         // one entry per artboard, see createBoard()
  let interactive = -1;      // index of the artboard currently receiving pointer input
  let drag = null;
  let persistTimer = 0;

  const saved = vscode.getState();
  if (saved && [saved.scale, saved.tx, saved.ty].every(Number.isFinite)) {
    ({ scale, tx, ty } = saved);
    hasView = true;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const clampScale = s => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

  // ---- viewport ---------------------------------------------------------------------------

  function apply() {
    world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    zoomEl.textContent = Math.round(scale * 100) + '%';
    // Keep pan/zoom across reloads and tab switches.
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => vscode.setState({ scale, tx, ty }), 150);
  }

  function zoomAt(factor, cx = main.clientWidth / 2, cy = main.clientHeight / 2) {
    const next = clampScale(scale * factor);
    const k = next / scale;
    tx = cx - (cx - tx) * k;
    ty = cy - (cy - ty) * k;
    scale = next;
    apply();
  }

  function resetView() {
    scale = 1; tx = 60; ty = 90;
    apply();
  }

  function fit() {
    if (!boards.length) { resetView(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { data: a } of boards) {
      minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h);
    }
    const pad = 80;
    const vw = main.clientWidth - pad * 2;
    const vh = main.clientHeight - pad * 2 - 30;
    const w = maxX - minX, h = maxY - minY;
    scale = clampScale(Math.min(1.5, vw / w, vh / h));
    tx = (main.clientWidth - w * scale) / 2 - minX * scale;
    ty = (main.clientHeight - h * scale) / 2 - minY * scale + 10;
    apply();
  }

  function go(i) {
    const b = boards[i];
    if (!b) return;
    const { x, y, w, h } = b.data;
    scale = Math.min(1.3, Math.max(0.3, Math.min((main.clientWidth - 180) / w, (main.clientHeight - 180) / h)));
    tx = (main.clientWidth - w * scale) / 2 - x * scale;
    ty = (main.clientHeight - h * scale) / 2 - y * scale + 20;
    apply();
    sidebar.classList.remove('open');
  }

  // ---- interactive mode -------------------------------------------------------------------

  function setInteractive(i) {
    if (interactive === i) return;
    if (boards[interactive]) {
      boards[interactive].root.classList.remove('interactive');
      boards[interactive].interact.setAttribute('aria-pressed', 'false');
    }
    interactive = i;
    if (boards[i]) {
      boards[i].root.classList.add('interactive');
      boards[i].interact.setAttribute('aria-pressed', 'true');
    }
  }

  const toggleInteractive = i => setInteractive(interactive === i ? -1 : i);

  // ---- rendering --------------------------------------------------------------------------

  function createBoard() {
    const root = el('div', 'artboard');
    const bar = el('div', 'board-title');
    const num = el('span', 'board-num');
    const name = el('span', 'board-name');
    const open = el('button', 'open-btn', '↗');
    open.type = 'button';
    const interact = el('button', 'interact-btn', 'Interact');
    interact.type = 'button';
    interact.title = 'Interact with this artboard (or double-click it). Click the empty canvas to leave.';
    interact.setAttribute('aria-pressed', 'false');
    bar.append(num, name, open, interact);
    const frame = el('div', 'frame');
    root.append(bar, frame);
    return { root, num, name, open, interact, frame, iframe: null, srcdoc: null, scripts: null, data: null };
  }

  function updateBoard(b, a, i) {
    b.data = a;
    b.root.dataset.index = i;
    b.root.style.left = a.x + 'px';
    b.root.style.top = a.y + 'px';
    b.root.style.width = a.w + 'px';
    b.root.style.height = a.h + 'px';
    b.num.textContent = i + 1;
    b.name.textContent = a.title;
    b.open.title = a.file ? 'Open ' + a.file : 'No source file';
    b.open.hidden = !a.file;

    // Only touch the iframe when its content (or the sandbox policy) actually changed,
    // so reloading a canvas does not flash or re-run every untouched artboard.
    if (!b.iframe || b.scripts !== allowScripts) {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', allowScripts ? 'allow-scripts allow-forms' : 'allow-forms');
      iframe.setAttribute('scrolling', 'no');
      iframe.title = a.title;
      iframe.srcdoc = a.srcdoc;
      b.frame.replaceChildren(iframe);
      b.iframe = iframe;
      b.scripts = allowScripts;
      b.srcdoc = a.srcdoc;
    } else if (b.srcdoc !== a.srcdoc) {
      b.iframe.srcdoc = a.srcdoc;
      b.srcdoc = a.srcdoc;
    }
  }

  function renderToc(artboards) {
    toc.replaceChildren(...artboards.map((a, i) => {
      const item = el('button', 'toc-item' + (a.error ? ' broken' : ''));
      item.type = 'button';
      item.dataset.index = i;
      item.title = a.error || a.file;
      item.append(el('span', null, i + 1), el('span', null, a.title));
      return item;
    }));
  }

  function renderNotes(annotations) {
    world.querySelectorAll(':scope > .annotation').forEach(n => n.remove());
    const notes = annotations.map(a => {
      const n = el('div', 'annotation', a.text);
      n.style.left = a.x + 'px';
      n.style.top = a.y + 'px';
      n.style.width = a.w + 'px';
      return n;
    });
    world.prepend(...notes);
  }

  function showBanner(text, kind) {
    banner.textContent = text || '';
    banner.className = kind || '';
    banner.hidden = !text;
  }

  function onUpdate(msg) {
    allowScripts = msg.allowScripts !== false;
    const { artboards, annotations, warning } = msg.canvas;

    while (boards.length > artboards.length) boards.pop().root.remove();
    artboards.forEach((a, i) => {
      if (!boards[i]) {
        boards[i] = createBoard();
        world.append(boards[i].root);
      }
      updateBoard(boards[i], a, i);
    });
    if (!boards[interactive]) interactive = -1;

    renderNotes(annotations);
    renderToc(artboards);
    statusEl.textContent = artboards.length + (artboards.length === 1 ? ' artboard' : ' artboards');
    emptyEl.textContent = 'No artboards to show.';
    emptyEl.hidden = artboards.length > 0;
    showBanner(warning, 'warning');

    if (!hasView && artboards.length) {
      fit();
      hasView = true;
    } else {
      apply();
    }
  }

  function onError(message) {
    showBanner(message, 'error');
    if (!boards.length) {
      emptyEl.textContent = 'Could not load the canvas.';
      emptyEl.hidden = false;
    }
  }

  window.addEventListener('message', e => {
    // Scripts inside artboards can post to us too; only trust the extension host.
    if (boards.some(b => b.iframe && b.iframe.contentWindow === e.source)) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'update' && msg.canvas) onUpdate(msg);
    else if (msg.type === 'error') onError(String(msg.message || 'Unknown error'));
  });

  // ---- input ------------------------------------------------------------------------------

  $('plus').onclick = () => zoomAt(1.15);
  $('minus').onclick = () => zoomAt(1 / 1.15);
  $('fit').onclick = fit;
  $('reset').onclick = resetView;
  $('list').onclick = () => sidebar.classList.add('open');
  $('close').onclick = () => sidebar.classList.remove('open');
  $('reload').onclick = () => vscode.postMessage({ type: 'reload' });
  $('source').onclick = () => vscode.postMessage({ type: 'openAsText' });

  toc.addEventListener('click', e => {
    const item = e.target.closest('.toc-item');
    if (item) go(Number(item.dataset.index));
  });

  world.addEventListener('click', e => {
    const btn = e.target.closest('button');
    const ab = btn && btn.closest('.artboard');
    if (!ab) return;
    const index = Number(ab.dataset.index);
    if (btn.classList.contains('open-btn')) vscode.postMessage({ type: 'openArtboard', index });
    else if (btn.classList.contains('interact-btn')) toggleInteractive(index);
  });

  main.addEventListener('dblclick', e => {
    const ab = e.target.closest('.artboard');
    if (ab && !e.target.closest('button')) toggleInteractive(Number(ab.dataset.index));
  });

  // Panning. Pointer capture starts only after a small movement so plain clicks and
  // double-clicks keep their original target.
  main.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('button')) return;
    const ab = e.target.closest('.artboard');
    if (interactive >= 0 && !(ab && Number(ab.dataset.index) === interactive)) setInteractive(-1);
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: tx, oy: ty, active: false };
    if (e.button === 1) e.preventDefault(); // no middle-click autoscroll
  });

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    main.classList.remove('dragging');
  }

  main.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.buttons === 0) { endDrag(e); return; } // missed the pointerup (released outside the window)
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_THRESHOLD) return;
      drag.active = true;
      main.setPointerCapture(e.pointerId);
      main.classList.add('dragging');
    }
    tx = drag.ox + e.clientX - drag.sx;
    ty = drag.oy + e.clientY - drag.sy;
    apply();
  });
  main.addEventListener('pointerup', endDrag);
  main.addEventListener('pointercancel', endDrag);
  main.addEventListener('lostpointercapture', endDrag);

  main.addEventListener('wheel', e => {
    e.preventDefault();
    // Normalise line/page deltas, clamp huge ones, and zoom proportionally to the delta so
    // trackpads (many tiny events) and mouse wheels (few big ones) both feel right.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? main.clientHeight : 1;
    const dy = Math.max(-120, Math.min(120, e.deltaY * unit));
    zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0012)), e.clientX, e.clientY);
  }, { passive: false });

  window.addEventListener('keydown', e => {
    // Leave Ctrl/Cmd/Alt combos to VS Code (e.g. Ctrl+- is the editor zoom).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '0') fit();
    else if (e.key === '1') resetView();
    else if (e.key === '+' || e.key === '=') zoomAt(1.15);
    else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.15);
    else if (e.key === 'Escape') {
      sidebar.classList.remove('open');
      setInteractive(-1);
    }
  });

  apply();
  vscode.postMessage({ type: 'ready' });
})();
