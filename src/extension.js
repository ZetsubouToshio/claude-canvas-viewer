'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { loadCanvas } = require('./canvas');
const { getWebviewHtml } = require('./webview');

const EDITOR_VIEW_TYPE = 'claudeCanvas.canvasEditor';
const RELOAD_DEBOUNCE_MS = 150;

const normalizePath = p => {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      EDITOR_VIEW_TYPE,
      new CanvasEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    ),
    vscode.commands.registerCommand('claudeCanvas.open', async uri => {
      const target = uri || activeResourceUri();
      if (!target) {
        vscode.window.showInformationMessage('Select canvas.json or a .canvas file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, EDITOR_VIEW_TYPE);
    }),
    vscode.commands.registerCommand('claudeCanvas.openAsText', async uri => {
      const target = uri || activeResourceUri();
      if (!target) {
        vscode.window.showInformationMessage('Open a canvas file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'default', vscode.ViewColumn.Beside);
    })
  );
}

/** URI of whatever is in the active tab: works for text editors and custom editors alike. */
function activeResourceUri() {
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input && input.uri) return input.uri;
  const editor = vscode.window.activeTextEditor;
  return editor && editor.document.uri;
}

class CanvasEditorProvider {
  constructor(context) {
    this.context = context;
  }

  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  resolveCustomEditor(document, webviewPanel) {
    const view = new CanvasView(this.context.extensionUri, document.uri, webviewPanel);
    view.start();
  }
}

/**
 * One instance per open canvas editor. All state (file, watchers, load sequencing) lives here,
 * so several canvases can be open at once without interfering with each other.
 */
class CanvasView {
  constructor(extensionUri, uri, panel) {
    this.extensionUri = extensionUri;
    this.uri = uri;
    this.panel = panel;
    this.webview = panel.webview;
    this.disposables = [];
    this.watchers = new Map();   // directory -> FileSystemWatcher
    this.watched = new Set();    // normalised file paths that should trigger a reload
    this.paths = [];             // artboard index -> absolute source path
    this.loadSeq = 0;
    this.reloadTimer = undefined;
    this.disposed = false;
  }

  start() {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };

    if (this.uri.scheme !== 'file') {
      this.webview.html = '<!doctype html><body style="font:14px sans-serif;padding:24px">'
        + 'Claude Canvas Viewer supports local files only.</body>';
      return;
    }

    this.webview.html = getWebviewHtml({
      cspSource: this.webview.cspSource,
      cssUri: this.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'viewer.css')).toString(),
      jsUri: this.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'viewer.js')).toString()
    });

    this.disposables.push(
      this.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeCanvas')) this.reload();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.reload())
    );
    // The webview asks for the first render with a 'ready' message once its script has loaded.
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
      case 'reload':
        this.reload();
        break;
      case 'openArtboard':
        this.openArtboard(msg.index);
        break;
      case 'openAsText':
        vscode.commands.executeCommand('vscode.openWith', this.uri, 'default', vscode.ViewColumn.Beside);
        break;
    }
  }

  async openArtboard(index) {
    const file = Number.isInteger(index) ? this.paths[index] : null;
    if (!file) return;
    try {
      await fs.promises.access(file);
    } catch {
      vscode.window.showWarningMessage(`File not found: ${path.basename(file)}`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
  }

  allowScripts() {
    const enabled = vscode.workspace.getConfiguration('claudeCanvas').get('runArtboardScripts', true);
    return Boolean(enabled && vscode.workspace.isTrusted);
  }

  async reload() {
    if (this.disposed) return;
    const seq = ++this.loadSeq;
    const roots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const result = await loadCanvas(this.uri.fsPath, roots);
    // A newer load started (or the panel closed) while we were reading: drop this result.
    if (this.disposed || seq !== this.loadSeq) return;

    if (result.error) {
      // Keep the previous artboards on screen: this is often just a half-written file.
      this.webview.postMessage({ type: 'error', message: result.error });
      this.syncWatchers([this.uri.fsPath]);
      return;
    }
    this.paths = result.paths;
    this.syncWatchers(result.watch);
    this.webview.postMessage({ type: 'update', canvas: result.canvas, allowScripts: this.allowScripts() });
  }

  scheduleReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.reload(), RELOAD_DEBOUNCE_MS);
  }

  /**
   * Watch the canvas file and every artboard it references. One non-recursive watcher per
   * directory keeps this cheap even in large workspaces.
   */
  syncWatchers(files) {
    this.watched = new Set(files.map(normalizePath));
    const dirs = new Set(files.map(f => path.dirname(f)));

    for (const [dir, watcher] of this.watchers) {
      if (!dirs.has(dir)) {
        watcher.dispose();
        this.watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*'));
      const onEvent = uri => {
        if (this.watched.has(normalizePath(uri.fsPath))) this.scheduleReload();
      };
      watcher.onDidChange(onEvent);
      watcher.onDidCreate(onEvent);
      watcher.onDidDelete(onEvent);
      this.watchers.set(dir, watcher);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.reloadTimer);
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
