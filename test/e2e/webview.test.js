'use strict';

// Browser-level test of the webview client (media/viewer.js) in headless Chromium.
// `acquireVsCodeApi` is stubbed, everything else is the real shipped code.
//
// Run with:  npm run test:e2e
// Needs Chromium: set CHROMIUM_PATH to a browser binary, or install Playwright's one with
//   npx playwright install chromium
// The test is skipped (not failed) when no browser can be launched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { getWebviewHtml } = require('../../src/webview');
const { loadCanvas, injectScrollReset } = require('../../src/canvas');

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE = path.join(ROOT, 'examples', 'basic', 'canvas.json');

function loadPlaywright() {
  for (const name of ['playwright-core', 'playwright']) {
    try { return require(name); } catch { /* try next */ }
  }
  return null;
}

async function launch() {
  const pw = loadPlaywright();
  if (!pw) return { reason: 'playwright-core is not installed' };
  const candidates = [process.env.CHROMIUM_PATH, undefined];
  let lastError;
  for (const executablePath of candidates) {
    try {
      return { browser: await pw.chromium.launch({ executablePath }) };
    } catch (e) {
      lastError = e;
    }
  }
  return { reason: `cannot launch Chromium (${String(lastError && lastError.message).split('\n')[0]})` };
}

// Stand-in for the VS Code webview host: records what the page posts and persists state.
const STUB = `
  window.__posted = [];
  window.__state = undefined;
  window.acquireVsCodeApi = () => ({
    postMessage: m => window.__posted.push(m),
    getState: () => window.__state,
    setState: s => { window.__state = s; }
  });
`;

async function openViewer(browser, { state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-e2e-'));
  const html = getWebviewHtml({
    cspSource: 'file:',
    cssUri: pathToFileURL(path.join(ROOT, 'media', 'viewer.css')).href,
    jsUri: pathToFileURL(path.join(ROOT, 'media', 'viewer.js')).href
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const csp = [];
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
  await page.addInitScript(STUB);
  if (state) await page.addInitScript(`window.__state = ${JSON.stringify(state)};`);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
  return { page, csp };
}

const send = (page, msg) => page.evaluate(m => window.postMessage(m, '*'), msg);
const zoomText = page => page.locator('#zoom').textContent();
const worldTransform = page => page.locator('#world').evaluate(n => n.style.transform);
const artboardFrames = page => page.frames().filter(f => f !== page.mainFrame());
const counterText = frame => frame.evaluate(() => { const n = document.getElementById('n'); return n && n.textContent; }).catch(() => null);
const scriptRan = frame => frame.evaluate(() => { const n = document.getElementById('n'); return n && n.dataset.scriptRan; }).catch(() => null);
const settle = page => page.waitForTimeout(300);

test('webview client', async t => {
  const { browser, reason } = await launch();
  if (!browser) return t.skip(reason);
  t.after(() => browser.close());

  const example = await loadCanvas(EXAMPLE);
  assert.ok(example.canvas, 'example canvas must load');

  await t.test('announces itself and renders artboards, notes and the sidebar list', async () => {
    const { page } = await openViewer(browser);
    assert.deepEqual((await page.evaluate(() => window.__posted))[0], { type: 'ready' });

    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard');
    assert.equal(await page.locator('.artboard').count(), 3);
    assert.equal(await page.locator('.annotation').count(), 2);
    assert.equal(await page.locator('.toc-item').count(), 3);
    assert.equal(await page.locator('#status').textContent(), '3 artboards');
    assert.equal(await page.locator('#empty').isHidden(), true);
    // first load fits everything into view
    assert.notEqual(await zoomText(page), '100%');
    await page.close();
  });

  await t.test('runs scripts inside artboards (CSP does not block them) when allowed', async () => {
    const { page, csp } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard iframe');
    await settle(page);
    const results = await Promise.all(artboardFrames(page).map(scriptRan));
    assert.ok(results.includes('yes'), 'the counter artboard script should have executed');
    assert.deepEqual(csp, [], 'no CSP violations expected');
    await page.close();
  });

  await t.test('does not run artboard scripts when disabled', async () => {
    const { page } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: false });
    await page.waitForSelector('.artboard iframe');
    await settle(page);
    const results = await Promise.all(artboardFrames(page).map(scriptRan));
    assert.ok(!results.includes('yes'));
    await page.close();
  });

  await t.test('wheel zoom and drag pan work with the pointer over an artboard', async () => {
    const { page } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard iframe');
    const box = await page.locator('.artboard').first().boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

    const z0 = await zoomText(page);
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(50);
    assert.notEqual(await zoomText(page), z0, 'wheel over an artboard must zoom');

    const t0 = await worldTransform(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 40, { steps: 6 });
    await page.mouse.up();
    assert.notEqual(await worldTransform(page), t0, 'dragging over an artboard must pan');

    // pan must end with the button: moving afterwards does nothing
    const t1 = await worldTransform(page);
    await page.mouse.move(cx + 200, cy + 100, { steps: 4 });
    assert.equal(await worldTransform(page), t1);
    await page.close();
  });

  await t.test('interactive mode lets the user click inside an artboard', async () => {
    const { page } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard iframe');
    await settle(page);

    const board = page.locator('.artboard').nth(2);
    const isInteractive = () => board.evaluate(n => n.classList.contains('interactive'));
    const frames = artboardFrames(page);
    const counter = (await Promise.all(frames.map(async f => ({ f, t: await counterText(f) })))).find(x => x.t !== null).f;
    const clickIncrement = async () => {
      const b = await (await counter.frameElement()).boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2 + 40); // the button is centred, below the number
    };

    await clickIncrement(); // not interactive yet: the click must not reach the artboard
    assert.equal(await counterText(counter), '0');

    await board.locator('.frame').dblclick();
    assert.equal(await isInteractive(), true);
    await clickIncrement();
    assert.equal(await counterText(counter), '1');

    // Leave by clicking the empty canvas (keys typed inside the artboard go to the artboard, not to us).
    await page.mouse.click(8, 880);
    assert.equal(await isInteractive(), false);

    // Esc works while the viewer itself has focus; the toolbar button toggles too.
    await board.locator('.interact-btn').click();
    assert.equal(await isInteractive(), true);
    await page.keyboard.press('Escape');
    assert.equal(await isInteractive(), false);
    await page.close();
  });

  await t.test('artboards lay out like a browser viewport: body padding/margins are not clipped', async () => {
    const { page } = await openViewer(browser);
    const padded = '<!doctype html><html><head><style>body{padding:32px;background:#eee}</style></head>'
      + '<body><div id="row" style="margin:0 auto;max-width:200px;height:20px;background:#c00"></div></body></html>';
    const canvas = {
      annotations: [],
      artboards: [{ file: 'p.html', title: 'padded', x: 0, y: 0, w: 390, h: 400, srcdoc: injectScrollReset(padded) }]
    };
    await send(page, { type: 'update', canvas, allowScripts: true });
    await page.waitForSelector('.artboard iframe');
    await settle(page);
    const m = await artboardFrames(page)[0].evaluate(() => ({
      bodyRight: document.body.getBoundingClientRect().right,
      innerWidth: window.innerWidth,
      rowLeft: document.getElementById('row').getBoundingClientRect().left,
      rowRight: document.getElementById('row').getBoundingClientRect().right
    }));
    assert.ok(m.bodyRight <= m.innerWidth, 'body must not overflow the artboard');
    assert.ok(Math.abs(m.rowLeft - (m.innerWidth - m.rowRight)) < 1, 'margin: 0 auto must stay centred');
    await page.close();
  });

  await t.test('renders very large artboards (data: URLs are capped at ~2 MB)', async () => {
    const { page } = await openViewer(browser);
    const big = '<!doctype html><body><div id="ok">ok</div>' + 'Привет мир '.repeat(100000) + '</body>';
    assert.ok(Buffer.byteLength(big) > 1.9e6);
    const canvas = { annotations: [], artboards: [{ file: 'big.html', title: 'big', x: 0, y: 0, w: 390, h: 400, srcdoc: big }] };
    await send(page, { type: 'update', canvas, allowScripts: true });
    await page.waitForSelector('.artboard iframe');
    await page.waitForTimeout(800);
    const frame = artboardFrames(page)[0];
    assert.equal(await frame.evaluate(() => !!document.getElementById('ok')), true);
    await page.close();
  });

  await t.test('reload only touches artboards whose content changed', async () => {
    const { page } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard iframe');
    await settle(page);

    await Promise.all(artboardFrames(page).map(f => f.evaluate(() => { window.__marker = true; })));

    const changed = structuredClone(example.canvas);
    changed.artboards[0].srcdoc = changed.artboards[0].srcdoc.replace('Welcome back', 'Welcome again');
    await send(page, { type: 'update', canvas: changed, allowScripts: true });
    await page.waitForTimeout(400);

    const survivors = await Promise.all(artboardFrames(page).map(f => f.evaluate(() => !!window.__marker).catch(() => false)));
    assert.equal(survivors.filter(Boolean).length, 2, 'two untouched artboards keep their state');
    await page.close();
  });

  await t.test('view state is persisted and restored without refitting', async () => {
    const { page } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard');
    await page.locator('#plus').click();
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => window.__state);
    assert.ok(Number.isFinite(state.scale) && Number.isFinite(state.tx) && Number.isFinite(state.ty));
    await page.close();

    const restored = await openViewer(browser, { state: { scale: 2, tx: 10, ty: 20 } });
    await send(restored.page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await restored.page.waitForSelector('.artboard');
    assert.equal(await zoomText(restored.page), '200%');
    await restored.page.close();
  });

  await t.test('messages from artboard scripts are ignored; markup in data is not interpreted', async () => {
    const { page } = await openViewer(browser);
    const evil = structuredClone(example.canvas);
    evil.artboards[0].title = '<img src=x onerror="window.__pwned=1">';
    evil.annotations[0].text = '<b id="injected">hi</b>';
    await send(page, { type: 'update', canvas: evil, allowScripts: true });
    await page.waitForSelector('.artboard iframe');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#injected').count(), 0);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);

    const frame = artboardFrames(page)[0];
    await frame.evaluate(() => parent.postMessage({ type: 'error', message: 'spoofed' }, '*'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#banner').isHidden(), true);
    await page.close();
  });

  await t.test('errors keep the previous artboards on screen; warnings are shown', async () => {
    const { page } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard');
    await send(page, { type: 'error', message: 'Invalid JSON: boom' });
    assert.equal(await page.locator('#banner').textContent(), 'Invalid JSON: boom');
    assert.equal(await page.locator('.artboard').count(), 3);

    await send(page, { type: 'update', canvas: { ...example.canvas, warning: 'careful' }, allowScripts: true });
    assert.equal(await page.locator('#banner').textContent(), 'careful');
    assert.equal(await page.locator('#banner').getAttribute('class'), 'warning');
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    assert.equal(await page.locator('#banner').isHidden(), true);
    await page.close();
  });

  await t.test('buttons talk to the extension host', async () => {
    const { page } = await openViewer(browser);
    await send(page, { type: 'update', canvas: example.canvas, allowScripts: true });
    await page.waitForSelector('.artboard');
    await page.locator('.open-btn').nth(1).click();
    await page.locator('#reload').click();
    await page.locator('#source').click();
    const posted = await page.evaluate(() => window.__posted);
    assert.deepEqual(posted.slice(1), [
      { type: 'openArtboard', index: 1 },
      { type: 'reload' },
      { type: 'openAsText' }
    ]);
    await page.close();
  });
});
