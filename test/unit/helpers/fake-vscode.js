'use strict';

// A tiny in-memory stand-in for the parts of the `vscode` API the extension uses.
// It records what the extension does so tests can assert on it, and lets tests fire
// events (file changes, messages from the webview, panel disposal) by hand.

const Module = require('module');
const path = require('path');

class Emitter {
  constructor() { this.listeners = new Set(); }
  event = fn => {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  };
  fire(value) { for (const fn of [...this.listeners]) fn(value); }
}

const fileUri = fsPath => ({
  scheme: 'file',
  fsPath,
  path: fsPath,
  toString: () => 'file://' + fsPath
});

function createFakeVscode() {
  const state = {
    providers: new Map(),     // viewType -> { provider, options }
    commands: new Map(),      // id -> handler
    executed: [],             // [command, ...args] from executeCommand
    infoMessages: [],
    warnings: [],
    watchers: [],             // every watcher ever created
    config: { runArtboardScripts: true },
    trusted: true,
    workspaceFolders: undefined,
    activeTab: undefined,
    activeTextEditor: undefined,
    configEmitter: new Emitter(),
    trustEmitter: new Emitter()
  };

  const vscode = {
    Uri: { file: fileUri, joinPath: (base, ...segs) => fileUri(path.join(base.fsPath, ...segs)) },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ViewColumn: { Beside: -2 },
    window: {
      registerCustomEditorProvider(viewType, provider, options) {
        state.providers.set(viewType, { provider, options });
        return { dispose() {} };
      },
      showInformationMessage: m => { state.infoMessages.push(m); },
      showWarningMessage: m => { state.warnings.push(m); },
      tabGroups: { get activeTabGroup() { return { activeTab: state.activeTab }; } },
      get activeTextEditor() { return state.activeTextEditor; }
    },
    commands: {
      registerCommand(id, handler) {
        state.commands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (...args) => { state.executed.push(args); }
    },
    workspace: {
      get workspaceFolders() { return state.workspaceFolders; },
      get isTrusted() { return state.trusted; },
      getConfiguration: () => ({ get: (key, fallback) => (key in state.config ? state.config[key] : fallback) }),
      onDidChangeConfiguration: state.configEmitter.event,
      onDidGrantWorkspaceTrust: state.trustEmitter.event,
      createFileSystemWatcher(pattern) {
        const change = new Emitter(), create = new Emitter(), del = new Emitter();
        const watcher = {
          pattern,
          disposed: false,
          onDidChange: change.event,
          onDidCreate: create.event,
          onDidDelete: del.event,
          dispose() { watcher.disposed = true; },
          // test helpers
          fireChange: file => change.fire(fileUri(file)),
          fireCreate: file => create.fire(fileUri(file)),
          fireDelete: file => del.fire(fileUri(file))
        };
        state.watchers.push(watcher);
        return watcher;
      }
    }
  };

  /** A fake WebviewPanel plus helpers to drive it. */
  function createPanel() {
    const received = new Emitter();
    const disposed = new Emitter();
    const panel = {
      posted: [],
      webview: {
        options: undefined,
        html: '',
        cspSource: 'csp-source:',
        asWebviewUri: uri => ({ toString: () => 'webview-uri:' + uri.fsPath }),
        postMessage: async msg => { panel.posted.push(msg); return true; },
        onDidReceiveMessage: received.event
      },
      onDidDispose: disposed.event,
      // test helpers
      send: msg => received.fire(msg),
      close: () => disposed.fire(),
      ofType: type => panel.posted.filter(m => m.type === type)
    };
    return panel;
  }

  return { vscode, state, createPanel, fileUri };
}

/**
 * Load a fresh copy of src/extension.js wired to a fake `vscode`.
 * Returns { extension, fake, activate() }.
 */
function loadExtension() {
  const fake = createFakeVscode();
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? fake.vscode : originalLoad.call(this, request, ...rest);
  };
  const extPath = require.resolve('../../../src/extension.js');
  delete require.cache[extPath];
  let extension;
  try {
    extension = require(extPath);
  } finally {
    Module._load = originalLoad;
  }
  const extensionUri = fileUri(path.resolve(__dirname, '..', '..', '..'));
  const context = { subscriptions: [], extensionUri };
  return {
    extension,
    fake,
    context,
    activate() { extension.activate(context); return fake.state.providers.get('claudeCanvas.canvasEditor').provider; }
  };
}

module.exports = { loadExtension, createFakeVscode, fileUri };
