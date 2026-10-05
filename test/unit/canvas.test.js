'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  escapeHtml, parseCanvas, isInside, injectScrollReset, readArtboard, loadCanvas
} = require('../../src/canvas');

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-unit-')));
}

test('escapeHtml escapes markup characters and tolerates null', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('parseCanvas', async t => {
  await t.test('applies defaults and normalises numbers', () => {
    const { canvas } = parseCanvas(JSON.stringify({
      artboards: [
        { file: 'a.html' },
        { file: 'b.html', title: 'B', x: '10', y: -5, w: 100, h: 200 },
        { file: 'c.html', x: 'nope', w: 0, h: -3 }
      ],
      annotations: [{ text: 'hi' }, { text: 'sized', x: 1, y: 2, w: 50 }]
    }));
    assert.deepEqual(canvas.artboards[0], { file: 'a.html', title: 'a.html', x: 0, y: 0, w: 390, h: 844 });
    assert.deepEqual(canvas.artboards[1], { file: 'b.html', title: 'B', x: 10, y: -5, w: 100, h: 200 });
    assert.deepEqual(canvas.artboards[2], { file: 'c.html', title: 'c.html', x: 0, y: 0, w: 390, h: 844 });
    assert.deepEqual(canvas.annotations[0], { text: 'hi', x: 0, y: 0, w: 300 });
    assert.deepEqual(canvas.annotations[1], { text: 'sized', x: 1, y: 2, w: 50 });
    assert.equal(canvas.warning, undefined);
  });

  await t.test('names artboards without file or title', () => {
    const { canvas } = parseCanvas('{"artboards":[{},{"title":"T"}]}');
    assert.equal(canvas.artboards[0].title, 'Artboard 1');
    assert.equal(canvas.artboards[0].file, '');
    assert.equal(canvas.artboards[1].title, 'T');
  });

  await t.test('skips junk entries instead of throwing', () => {
    const { canvas } = parseCanvas('{"artboards":[null,1,"x",{"file":"ok.html"}],"annotations":[null,[]]}');
    assert.equal(canvas.artboards.length, 1);
    assert.equal(canvas.artboards[0].file, 'ok.html');
    assert.equal(canvas.annotations.length, 1); // [] is an object; it just gets defaults
  });

  await t.test('rejects invalid JSON with a readable message', () => {
    assert.match(parseCanvas('{ nope').error, /^Invalid JSON/);
    assert.match(parseCanvas('').error, /^Invalid JSON/);
  });

  await t.test('rejects JSON that is not an object (null used to crash the editor)', () => {
    for (const text of ['null', '42', '"str"', '[]', 'true']) {
      assert.match(parseCanvas(text).error, /Not a Claude canvas file/, text);
    }
  });

  await t.test('accepts a UTF-8 BOM', () => {
    assert.equal(parseCanvas('\uFEFF{"artboards":[]}').canvas.artboards.length, 0);
  });

  await t.test('warns when there is no artboards array', () => {
    assert.match(parseCanvas('{}').canvas.warning, /No "artboards" array/);
    assert.match(parseCanvas('{"nodes":[],"edges":[]}').canvas.warning, /another tool/);
    assert.deepEqual(parseCanvas('{}').canvas.artboards, []);
  });
});

test('isInside', () => {
  const root = path.resolve('/a/b');
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, 'c', 'd.html')), true);
  assert.equal(isInside(root, path.resolve('/a/bc')), false); // prefix, not parent
  assert.equal(isInside(root, path.resolve('/a')), false);
  assert.equal(isInside(root, path.resolve('/etc/passwd')), false);
  assert.equal(isInside(root, path.join(root, '..', 'x')), false);
});

test('injectScrollReset keeps the document mode and never touches layout properties', () => {
  const css = 'data-claude-canvas-scroll-reset';

  const full = injectScrollReset('<!doctype html><html><head><title>t</title></head><body>x</body></html>');
  assert.ok(full.startsWith('<!doctype html>'), 'doctype must stay first (otherwise quirks mode)');
  assert.ok(full.indexOf(css) < full.indexOf('</head>'));

  const noClosingHead = injectScrollReset('<!doctype html><html><head><title>t</title><body>x');
  assert.ok(noClosingHead.startsWith('<!doctype html>'));
  assert.ok(noClosingHead.includes(css));

  const noHead = injectScrollReset('<!DOCTYPE html>\n<html lang="en"><body>x</body></html>');
  assert.ok(noHead.startsWith('<!DOCTYPE html>'));
  assert.ok(noHead.indexOf(css) > noHead.indexOf('<html lang="en">'));

  const onlyDoctype = injectScrollReset('<!doctype html><div>x</div>');
  assert.ok(onlyDoctype.startsWith('<!doctype html>'));

  const fragment = injectScrollReset('<div>x</div>');
  assert.ok(fragment.startsWith('<style'));

  // regression: forcing these broke body padding and `margin: 0 auto`
  const rootRule = /html,body\{([^}]*)\}/.exec(full)[1];
  assert.doesNotMatch(rootRule, /(^|[;{\s])(width|height|margin)\s*:/);
  assert.match(rootRule, /overflow:hidden!important/);
});

test('readArtboard / loadCanvas', async t => {
  const dir = tmpDir();
  const outside = tmpDir();
  fs.mkdirSync(path.join(dir, 'screens'));
  fs.writeFileSync(path.join(dir, 'screens', 'a.dc.html'), '<!doctype html><html><head></head><body>A</body></html>');
  fs.writeFileSync(path.join(outside, 'secret.html'), '<body>SECRET</body>');
  fs.mkdirSync(path.join(dir, 'folder.html'));
  let symlinkWorks = true;
  try { fs.symlinkSync(path.join(outside, 'secret.html'), path.join(dir, 'link.html')); } catch { symlinkWorks = false; }

  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const canvasFile = path.join(dir, 'canvas.json');
  const write = obj => fs.writeFileSync(canvasFile, JSON.stringify(obj));

  await t.test('reads a normal artboard', async () => {
    const r = await readArtboard(dir, 'screens/a.dc.html', [dir]);
    assert.match(r.html, />A</);
    assert.equal(r.path, path.join(dir, 'screens', 'a.dc.html'));
  });

  await t.test('reports missing files, empty names and directories without throwing', async () => {
    assert.match((await readArtboard(dir, 'nope.html', [dir])).error, /File not found: nope\.html/);
    assert.match((await readArtboard(dir, '', [dir])).error, /No "file"/);
    const d = await readArtboard(dir, 'folder.html', [dir]);
    assert.match(d.error, /Cannot read folder\.html/); // used to throw EISDIR and blank the whole editor
  });

  await t.test('refuses paths outside the allowed roots', async () => {
    for (const file of ['../' + path.basename(outside) + '/secret.html', path.join(outside, 'secret.html'), '/etc/passwd']) {
      const r = await readArtboard(dir, file, [dir]);
      assert.equal(r.html, undefined, file);
      assert.ok(r.error, file);
    }
    assert.match((await readArtboard(dir, 'a\0b', [dir])).error, /Invalid/);
  });

  await t.test('refuses symlinks that point outside the roots', { skip: !symlinkWorks }, async () => {
    const r = await readArtboard(dir, 'link.html', [dir]);
    assert.equal(r.html, undefined);
    assert.match(r.error, /Blocked/);
  });

  await t.test('allows extra roots (workspace folders)', async () => {
    const r = await readArtboard(dir, path.join(outside, 'secret.html'), [dir, outside]);
    assert.match(r.html, /SECRET/);
  });

  await t.test('loadCanvas builds the webview model and the watch list', async () => {
    write({
      artboards: [
        { title: 'A', file: 'screens/a.dc.html', x: 1, y: 2, w: 3, h: 4 },
        { file: 'missing.html' },
        { file: '../' + path.basename(outside) + '/secret.html' },
        { file: '' }
      ],
      annotations: [{ text: 'n' }]
    });
    const r = await loadCanvas(canvasFile);
    assert.equal(r.error, undefined);
    assert.equal(r.canvas.artboards.length, 4);
    assert.match(r.canvas.artboards[0].srcdoc, /data-claude-canvas-scroll-reset/);
    assert.equal(r.canvas.artboards[0].error, undefined);
    assert.match(r.canvas.artboards[1].error, /not found/);
    assert.match(r.canvas.artboards[1].srcdoc, /File not found: missing\.html/);
    assert.match(r.canvas.artboards[2].error, /Blocked/);
    assert.doesNotMatch(JSON.stringify(r.canvas), /SECRET/);
    assert.match(r.canvas.artboards[3].error, /No "file"/);
    assert.equal(r.canvas.annotations.length, 1);

    assert.equal(r.paths[0], path.join(dir, 'screens', 'a.dc.html'));
    assert.equal(r.paths[2], null);
    // missing files are watched (so they show up when created); blocked ones are not
    assert.deepEqual(r.watch.sort(), [
      canvasFile,
      path.join(dir, 'missing.html'),
      path.join(dir, 'screens', 'a.dc.html')
    ].sort());
  });

  await t.test('loadCanvas escapes the file name in error documents', async () => {
    write({ artboards: [{ file: '<img src=x onerror=alert(1)>.html' }] });
    const r = await loadCanvas(canvasFile);
    assert.doesNotMatch(r.canvas.artboards[0].srcdoc, /<img/);
    assert.match(r.canvas.artboards[0].srcdoc, /&lt;img/);
  });

  await t.test('loadCanvas returns { error } for unreadable or invalid canvas files', async () => {
    assert.match((await loadCanvas(path.join(dir, 'absent.json'))).error, /Cannot read absent\.json/);
    fs.writeFileSync(canvasFile, '{"artboards": [');
    assert.match((await loadCanvas(canvasFile)).error, /Invalid JSON/);
    fs.writeFileSync(canvasFile, 'null');
    assert.match((await loadCanvas(canvasFile)).error, /Not a Claude canvas file/);
  });
});

test('the bundled example loads without errors', async () => {
  const example = path.resolve(__dirname, '..', '..', 'examples', 'basic', 'canvas.json');
  const r = await loadCanvas(example);
  assert.equal(r.error, undefined);
  assert.equal(r.canvas.artboards.length, 3);
  assert.ok(r.canvas.artboards.every(a => !a.error), 'no artboard should be broken');
});
