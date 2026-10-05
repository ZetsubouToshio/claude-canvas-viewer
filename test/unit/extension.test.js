'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadExtension, fileUri } = require('./helpers/fake-vscode');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SETTLE_MS = 450; // longer than the extension's reload debounce

/** Create a canvas folder with one artboard; returns paths and a helper to rewrite the artboard. */
function makeCanvas(label = 'one') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `canvas-ext-${label}-`)));
  fs.mkdirSync(path.join(dir, 'screens'));
  const canvasFile = path.join(dir, 'canvas.json');
  const artboard = path.join(dir, 'screens', 'a.dc.html');
  fs.writeFileSync(canvasFile, JSON.stringify({ artboards: [{ title: label, file: 'screens/a.dc.html' }] }));
  fs.writeFileSync(artboard, `<body>${label} v1</body>`);
  return {
    dir, canvasFile, artboard,
    setArtboard: html => fs.writeFileSync(artboard, html),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

/** Open a canvas in the extension and wait for the first render. */
async function openView(ctx, provider, canvas) {
  const panel = ctx.fake.createPanel();
  const doc = provider.openCustomDocument(fileUri(canvas.canvasFile));
  provider.resolveCustomEditor(doc, panel);
  panel.send({ type: 'ready' });
  await wait(100);
  return panel;
}

const watcherFor = (ctx, dir) => ctx.fake.state.watchers.find(w => w.pattern.base === dir && !w.disposed);
const lastUpdate = panel => panel.ofType('update').at(-1);

test('activation registers what the manifest declares', () => {
  const pkg = require('../../package.json');
  const ctx = loadExtension();
  ctx.activate();
  const { providers, commands } = ctx.fake.state;

  for (const editor of pkg.contributes.customEditors) {
    assert.ok(providers.has(editor.viewType), `custom editor ${editor.viewType} is declared but never registered`);
  }
  for (const viewType of providers.keys()) {
    assert.ok(pkg.contributes.customEditors.some(e => e.viewType === viewType), `${viewType} is registered but not declared`);
  }
  for (const cmd of pkg.contributes.commands) {
    assert.ok(commands.has(cmd.command), `command ${cmd.command} is declared but never registered`);
  }
  for (const entries of Object.values(pkg.contributes.menus)) {
    for (const entry of entries) assert.ok(commands.has(entry.command), `menu entry uses unregistered ${entry.command}`);
  }
  for (const key of pkg.contributes.keybindings) {
    assert.ok(commands.has(key.command), `keybinding uses unregistered ${key.command}`);
  }
  assert.deepEqual(pkg.activationEvents, [], 'activation events are generated from contributions');
});

test('webview shell: restricted resource roots, CSP and media URIs', async t => {
  const canvas = makeCanvas();
  t.after(canvas.cleanup);
  const ctx = loadExtension();
  const provider = ctx.activate();
  const panel = await openView(ctx, provider, canvas);

  assert.equal(panel.webview.options.enableScripts, true);
  assert.equal(panel.webview.options.localResourceRoots.length, 1);
  assert.equal(panel.webview.options.localResourceRoots[0].fsPath, path.join(ctx.context.extensionUri.fsPath, 'media'));
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /src="webview-uri:[^"]*viewer\.js"/);
  assert.match(panel.webview.html, /href="webview-uri:[^"]*viewer\.css"/);
  assert.ok(ctx.fake.state.providers.get('claudeCanvas.canvasEditor').options.webviewOptions.retainContextWhenHidden);
});

test('renders on ready and re-renders only its own canvas on change', async t => {
  const a = makeCanvas('alpha');
  const b = makeCanvas('beta');
  t.after(() => { a.cleanup(); b.cleanup(); });
  const ctx = loadExtension();
  const provider = ctx.activate();

  const panelA = await openView(ctx, provider, a);
  const panelB = await openView(ctx, provider, b);

  assert.equal(panelA.ofType('update').length, 1);
  assert.equal(panelB.ofType('update').length, 1);
  assert.match(lastUpdate(panelA).canvas.artboards[0].srcdoc, /alpha v1/);
  assert.match(lastUpdate(panelB).canvas.artboards[0].srcdoc, /beta v1/);

  // The original implementation kept the watcher in a module global, so opening B killed A's
  // auto-reload and A's reload re-rendered B's file. Each canvas must stay independent.
  a.setArtboard('<body>alpha v2</body>');
  watcherFor(ctx, path.join(a.dir, 'screens')).fireChange(a.artboard);
  await wait(SETTLE_MS);

  assert.equal(panelA.ofType('update').length, 2, 'A re-rendered');
  assert.match(lastUpdate(panelA).canvas.artboards[0].srcdoc, /alpha v2/);
  assert.equal(panelB.ofType('update').length, 1, 'B untouched');

  // Closing B must not take A's watchers with it.
  panelB.close();
  a.setArtboard('<body>alpha v3</body>');
  watcherFor(ctx, path.join(a.dir, 'screens')).fireChange(a.artboard);
  await wait(SETTLE_MS);
  assert.match(lastUpdate(panelA).canvas.artboards[0].srcdoc, /alpha v3/);
  assert.ok(ctx.fake.state.watchers.filter(w => w.pattern.base.startsWith(b.dir)).every(w => w.disposed));
});

test('watches the canvas file and each artboard directory, ignoring unrelated files', async t => {
  const canvas = makeCanvas();
  t.after(canvas.cleanup);
  const ctx = loadExtension();
  const panel = await openView(ctx, ctx.activate(), canvas);

  const bases = ctx.fake.state.watchers.map(w => w.pattern.base).sort();
  assert.deepEqual(bases, [canvas.dir, path.join(canvas.dir, 'screens')].sort());
  assert.ok(ctx.fake.state.watchers.every(w => w.pattern.pattern === '*'), 'non-recursive');

  watcherFor(ctx, canvas.dir).fireChange(path.join(canvas.dir, 'notes.txt'));
  await wait(SETTLE_MS);
  assert.equal(panel.ofType('update').length, 1, 'unrelated file must not trigger a reload');

  watcherFor(ctx, canvas.dir).fireChange(canvas.canvasFile);
  await wait(SETTLE_MS);
  assert.equal(panel.ofType('update').length, 2, 'canvas file change reloads');

  // atomic-save style: delete then create
  watcherFor(ctx, path.join(canvas.dir, 'screens')).fireDelete(canvas.artboard);
  watcherFor(ctx, path.join(canvas.dir, 'screens')).fireCreate(canvas.artboard);
  await wait(SETTLE_MS);
  assert.equal(panel.ofType('update').length, 3, 'bursts of events are debounced into one reload');
});

test('a broken canvas file reports an error and recovers once fixed', async t => {
  const canvas = makeCanvas();
  t.after(canvas.cleanup);
  const ctx = loadExtension();
  const panel = await openView(ctx, ctx.activate(), canvas);

  fs.writeFileSync(canvas.canvasFile, '{"artboards": [');
  watcherFor(ctx, canvas.dir).fireChange(canvas.canvasFile);
  await wait(SETTLE_MS);
  assert.match(panel.ofType('error').at(-1).message, /Invalid JSON/);
  assert.equal(panel.ofType('update').length, 1, 'previous artboards stay on screen');

  fs.writeFileSync(canvas.canvasFile, 'null');
  watcherFor(ctx, canvas.dir).fireChange(canvas.canvasFile);
  await wait(SETTLE_MS);
  assert.match(panel.ofType('error').at(-1).message, /Not a Claude canvas file/);

  fs.writeFileSync(canvas.canvasFile, JSON.stringify({ artboards: [{ file: 'screens/a.dc.html' }] }));
  watcherFor(ctx, canvas.dir).fireChange(canvas.canvasFile);
  await wait(SETTLE_MS);
  assert.equal(panel.ofType('update').length, 2);
});

test('script policy follows workspace trust and the setting', async t => {
  const canvas = makeCanvas();
  t.after(canvas.cleanup);
  const ctx = loadExtension();
  const panel = await openView(ctx, ctx.activate(), canvas);
  assert.equal(lastUpdate(panel).allowScripts, true);

  ctx.fake.state.config.runArtboardScripts = false;
  ctx.fake.state.configEmitter.fire({ affectsConfiguration: s => s === 'claudeCanvas' });
  await wait(100);
  assert.equal(lastUpdate(panel).allowScripts, false);

  ctx.fake.state.config.runArtboardScripts = true;
  ctx.fake.state.trusted = false;
  ctx.fake.state.trustEmitter.fire();
  await wait(100);
  assert.equal(lastUpdate(panel).allowScripts, false, 'untrusted workspaces never run artboard scripts');

  const before = panel.ofType('update').length;
  ctx.fake.state.configEmitter.fire({ affectsConfiguration: s => s === 'editor' });
  await wait(100);
  assert.equal(panel.ofType('update').length, before, 'unrelated settings are ignored');
});

test('messages from the webview', async t => {
  const canvas = makeCanvas();
  t.after(canvas.cleanup);
  const ctx = loadExtension();
  const panel = await openView(ctx, ctx.activate(), canvas);
  const { executed, warnings } = ctx.fake.state;

  panel.send({ type: 'openArtboard', index: 0 });
  await wait(50);
  assert.deepEqual(executed.at(-1).slice(0, 1), ['vscode.open']);
  assert.equal(executed.at(-1)[1].fsPath, canvas.artboard);

  const count = executed.length;
  for (const index of [1, -1, 0.5, '0', null, undefined, '../../etc/passwd', {}]) {
    panel.send({ type: 'openArtboard', index });
  }
  panel.send(null);
  panel.send('junk');
  panel.send({ type: 'nope' });
  await wait(50);
  assert.equal(executed.length, count, 'invalid indexes and unknown messages are ignored');

  fs.rmSync(canvas.artboard);
  panel.send({ type: 'openArtboard', index: 0 });
  await wait(50);
  assert.equal(executed.length, count);
  assert.match(warnings.at(-1), /File not found/);

  panel.send({ type: 'openAsText' });
  await wait(50);
  const last = executed.at(-1);
  assert.equal(last[0], 'vscode.openWith');
  assert.equal(last[1].fsPath, canvas.canvasFile);
  assert.equal(last[2], 'default');

  const updates = panel.ofType('update').length;
  panel.send({ type: 'reload' });
  await wait(100);
  assert.equal(panel.ofType('update').length, updates + 1);
});

test('disposing the panel stops watching and posting', async t => {
  const canvas = makeCanvas();
  t.after(canvas.cleanup);
  const ctx = loadExtension();
  const panel = await openView(ctx, ctx.activate(), canvas);
  const watchers = ctx.fake.state.watchers.slice();
  assert.ok(watchers.length > 0);

  watcherFor(ctx, canvas.dir).fireChange(canvas.canvasFile); // reload pending...
  panel.close();                                              // ...and the panel goes away
  await wait(SETTLE_MS);

  assert.ok(watchers.every(w => w.disposed));
  assert.equal(panel.ofType('update').length, 1, 'no post after dispose');
  panel.send({ type: 'reload' });
  await wait(100);
  assert.equal(panel.ofType('update').length, 1);
});

test('non-file documents get a friendly message instead of a crash', () => {
  const ctx = loadExtension();
  const provider = ctx.activate();
  const panel = ctx.fake.createPanel();
  const doc = provider.openCustomDocument({ scheme: 'vscode-vfs', fsPath: '/x/canvas.json', path: '/x/canvas.json' });
  provider.resolveCustomEditor(doc, panel);
  assert.match(panel.webview.html, /local files only/);
});

test('commands', async () => {
  const ctx = loadExtension();
  ctx.activate();
  const { commands, executed, infoMessages } = ctx.fake.state;

  await commands.get('claudeCanvas.open')();
  assert.equal(infoMessages.length, 1, 'asks for a file when nothing is selected');
  assert.equal(executed.length, 0);

  // custom editor tab (activeTextEditor is undefined while a custom editor is focused)
  const tabUri = fileUri('/work/design/canvas.json');
  ctx.fake.state.activeTab = { input: { uri: tabUri } };
  await commands.get('claudeCanvas.open')();
  assert.deepEqual(executed.at(-1), ['vscode.openWith', tabUri, 'claudeCanvas.canvasEditor']);

  // explorer context menu passes the URI explicitly
  const explorerUri = fileUri('/work/other.canvas');
  await commands.get('claudeCanvas.open')(explorerUri);
  assert.deepEqual(executed.at(-1), ['vscode.openWith', explorerUri, 'claudeCanvas.canvasEditor']);

  await commands.get('claudeCanvas.openAsText')();
  assert.deepEqual(executed.at(-1), ['vscode.openWith', tabUri, 'default', -2]);
});
