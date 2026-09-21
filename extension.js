const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let currentPanel = null;
let currentFile = null;
let fileWatcher = null;

function activate(context) {
  const openCmd = vscode.commands.registerCommand('claudeCanvas.open', async (uri) => {
    const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!target) {
      vscode.window.showInformationMessage('Select canvas.json or a .canvas file first.');
      return;
    }
    await openCanvas(target);
  });

  const openEditor = vscode.window.registerCustomEditorProvider(
    'claudeCanvas.canvasEditor',
    new CanvasEditorProvider(context),
    { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
  );

  context.subscriptions.push(openCmd, openEditor);
}

class CanvasEditorProvider {
  constructor(context) {
    this.context = context;
  }

  async openCustomDocument(uri) {
    return new CanvasDocument(uri);
  }

  async resolveCustomEditor(document, webviewPanel) {
    currentPanel = webviewPanel;
    currentFile = document.uri.fsPath;
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.dirname(currentFile))]
    };

    const render = () => {
      const data = readCanvas(currentFile);
      webviewPanel.webview.html = getHtml(webviewPanel.webview, currentFile, data);
    };

    render();

    if (fileWatcher) fileWatcher.dispose();
    const dir = path.dirname(currentFile);
    const base = path.basename(currentFile);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, base)
    );
    watcher.onDidChange(() => render());
    watcher.onDidDelete(() => {
      webviewPanel.webview.postMessage({ type: 'toast', text: 'Canvas file was deleted.' });
    });
    fileWatcher = watcher;

    webviewPanel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'openFile') {
        const target = path.resolve(dir, msg.file);
        if (fs.existsSync(target)) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
        }
      } else if (msg.type === 'reload') {
        render();
      }
    });

    webviewPanel.onDidDispose(() => {
      if (fileWatcher) { fileWatcher.dispose(); fileWatcher = null; }
      if (currentPanel === webviewPanel) currentPanel = null;
    });
  }
}

class CanvasDocument {
  constructor(uri) { this.uri = uri; }
  dispose() {}
}

async function openCanvas(uri) {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'claudeCanvas.canvasEditor');
}

function readCanvas(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { artboards: [], annotations: [], error: e.message };
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function getHtml(webview, canvasFile, data) {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const baseDir = path.dirname(canvasFile);
  const artboards = Array.isArray(data.artboards) ? data.artboards : [];
  const annotations = Array.isArray(data.annotations) ? data.annotations : [];

  const boards = artboards.map((a, i) => {
    const file = String(a.file || '');
    const full = path.resolve(baseDir, file);
    let html = '';
    if (fs.existsSync(full)) {
      html = fs.readFileSync(full, 'utf8');
    } else {
      html = `<div style="padding:24px;font:14px sans-serif;color:#b00020">File not found: ${esc(file)}</div>`;
    }
    const scrollReset = `<style data-claude-canvas-scroll-reset>
html,body{
  margin:0!important;
  width:100%!important;
  height:100%!important;
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
    if (/<\/head\s*>/i.test(html)) {
      html = html.replace(/<\/head\s*>/i, scrollReset + '</head>');
    } else {
      html = scrollReset + html;
    }
    const src = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    return `
      <div class="artboard" data-index="${i}" data-x="${Number(a.x)||0}" data-y="${Number(a.y)||0}"
           data-w="${Number(a.w)||390}" data-h="${Number(a.h)||844}"
           style="left:${Number(a.x)||0}px;top:${Number(a.y)||0}px;width:${Number(a.w)||390}px;height:${Number(a.h)||844}px">
        <div class="board-title">
          <span class="board-num">${i+1}</span>
          <span class="board-name">${esc(a.title || file)}</span>
          <button class="open-btn" data-file="${esc(file)}" title="Open HTML">↗</button>
        </div>
        <div class="frame"><iframe scrolling="no" sandbox="allow-scripts allow-forms" src="${src}"></iframe></div>
      </div>`;
  }).join('');

  const notes = annotations.map((a,i) => `
    <div class="annotation" data-index="${i}" style="left:${Number(a.x)||0}px;top:${Number(a.y)||0}px;width:${Number(a.w)||300}px">
      ${esc(a.text || '')}
    </div>`).join('');

  const toc = artboards.map((a,i) =>
    `<button class="toc-item" data-index="${i}" title="${esc(a.file || '')}">
      <span>${i+1}</span><span>${esc(a.title || a.file || `Artboard ${i+1}`)}</span>
    </button>`).join('');

  const error = data.error ? `<div class="error">${esc(data.error)}</div>` : '';

  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src data: https:;">
<style>
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#171717;color:#eee;font:13px system-ui,-apple-system,sans-serif}
html,body,*{scrollbar-width:none!important;-ms-overflow-style:none!important}
html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
html,body{overscroll-behavior:none!important}
#toolbar{position:fixed;z-index:20;top:10px;left:10px;right:10px;height:42px;display:flex;align-items:center;gap:6px;padding:5px 8px;background:rgba(35,35,35,.94);border:1px solid #444;border-radius:9px;box-shadow:0 5px 18px #0008}
button{font:inherit;color:#eee;background:#303030;border:1px solid #505050;border-radius:6px;padding:5px 9px;cursor:pointer}
button:hover{background:#3b3b3b}
#zoom{min-width:52px;text-align:center;color:#bbb}
.sep{width:1px;height:24px;background:#555;margin:0 3px}
#main{position:absolute;inset:0;overflow:hidden;cursor:grab}
#main.dragging{cursor:grabbing}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.artboard{position:absolute;background:#fff;box-shadow:0 8px 30px #0009;border-radius:4px;overflow:visible}
.frame{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;background:white;border-radius:4px}
.frame iframe{border:0;width:100%;height:100%;display:block;background:white}
.board-title{position:absolute;left:0;bottom:calc(100% + 7px);max-width:100%;height:26px;display:flex;align-items:center;gap:6px;white-space:nowrap;pointer-events:auto}
.board-name{color:#ddd;background:#292929dd;padding:4px 7px;border-radius:5px;overflow:hidden;text-overflow:ellipsis}
.board-num{background:#555;color:#fff;border-radius:5px;padding:4px 6px}
.open-btn{padding:3px 7px}
.annotation{position:absolute;background:#292929;color:#ddd;border:1px solid #555;border-radius:7px;padding:9px 11px;line-height:1.4;white-space:pre-wrap;pointer-events:none;box-shadow:0 3px 10px #0005}
#sidebar{position:fixed;z-index:25;top:62px;right:10px;bottom:10px;width:300px;background:rgba(30,30,30,.96);border:1px solid #444;border-radius:9px;display:none;overflow:hidden;box-shadow:0 8px 28px #000a}
#sidebar.open{display:flex;flex-direction:column}
#sidehead{padding:10px;border-bottom:1px solid #444;font-weight:600;display:flex;justify-content:space-between}
#toc{overflow:auto;padding:6px}
.toc-item{display:flex;gap:9px;width:100%;text-align:left;margin-bottom:4px;padding:7px}
.toc-item span:first-child{min-width:23px;color:#aaa}
.error{position:fixed;z-index:50;left:50%;top:65px;transform:translateX(-50%);background:#6d1717;padding:10px 14px;border-radius:7px}
#status{margin-left:auto;color:#aaa;font-size:12px}
</style>
</head>
<body>
<div id="toolbar">
  <button id="minus" title="Zoom out">−</button>
  <span id="zoom">100%</span>
  <button id="plus" title="Zoom in">+</button>
  <button id="fit" title="Fit all artboards">Fit</button>
  <button id="reset" title="Reset view">Reset</button>
  <div class="sep"></div>
  <button id="list" title="Artboards">☰ Screens</button>
  <button id="reload" title="Reload">↻</button>
  <span id="status">${artboards.length} artboards</span>
</div>
<div id="sidebar">
  <div id="sidehead"><span>Artboards</span><button id="close">×</button></div>
  <div id="toc">${toc}</div>
</div>
<div id="main"><div id="world">${notes}${boards}</div></div>
${error}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const main=document.getElementById('main');
const world=document.getElementById('world');
const zoomEl=document.getElementById('zoom');
let scale=1, tx=60, ty=90, dragging=false, sx=0, sy=0, ox=0, oy=0;

function apply(){world.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')';zoomEl.textContent=Math.round(scale*100)+'%'}
function centerPoint(x,y){return {x:(x-tx)/scale,y:(y-ty)/scale}}
function zoomAt(factor,cx=innerWidth/2,cy=innerHeight/2){
  const p=centerPoint(cx,cy); scale=Math.max(.1,Math.min(4,scale*factor));
  tx=cx-p.x*scale; ty=cy-p.y*scale; apply();
}
function fit(){
  const bs=[...document.querySelectorAll('.artboard')];
  if(!bs.length)return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  bs.forEach(b=>{const x=+b.dataset.x,y=+b.dataset.y,w=+b.dataset.w,h=+b.dataset.h;
    minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x+w);maxY=Math.max(maxY,y+h)});
  const pad=80, vw=innerWidth-pad*2, vh=innerHeight-pad*2-30;
  scale=Math.max(.1,Math.min(1.5,Math.min(vw/(maxX-minX),vh/(maxY-minY))));
  tx=(innerWidth-(maxX-minX)*scale)/2-minX*scale;
  ty=(innerHeight-(maxY-minY)*scale)/2-minY*scale+10; apply();
}
function go(i){
  const b=document.querySelector('.artboard[data-index="'+i+'"]'); if(!b)return;
  const x=+b.dataset.x,y=+b.dataset.y,w=+b.dataset.w,h=+b.dataset.h;
  scale=Math.min(1.3,Math.max(.3,Math.min((innerWidth-180)/w,(innerHeight-180)/h)));
  tx=(innerWidth-w*scale)/2-x*scale;
  ty=(innerHeight-h*scale)/2-y*scale+20; apply();
  document.getElementById('sidebar').classList.remove('open');
}
document.getElementById('plus').onclick=()=>zoomAt(1.15);
document.getElementById('minus').onclick=()=>zoomAt(1/1.15);
document.getElementById('fit').onclick=fit;
document.getElementById('reset').onclick=()=>{scale=1;tx=60;ty=90;apply()};
document.getElementById('list').onclick=()=>document.getElementById('sidebar').classList.add('open');
document.getElementById('close').onclick=()=>document.getElementById('sidebar').classList.remove('open');
document.getElementById('reload').onclick=()=>vscode.postMessage({type:'reload'});
document.querySelectorAll('.toc-item').forEach(b=>b.onclick=()=>go(+b.dataset.index));
document.querySelectorAll('.open-btn').forEach(b=>b.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'openFile',file:b.dataset.file})});

main.addEventListener('mousedown',e=>{
  if(e.button!==0)return; dragging=true; main.classList.add('dragging');sx=e.clientX;sy=e.clientY;ox=tx;oy=ty;
});
window.addEventListener('mouseup',()=>{dragging=false;main.classList.remove('dragging')});
window.addEventListener('mousemove',e=>{if(!dragging)return;tx=ox+e.clientX-sx;ty=oy+e.clientY-sy;apply()});
main.addEventListener('wheel',e=>{e.preventDefault();zoomAt(e.deltaY<0?1.1:1/1.1,e.clientX,e.clientY)},{passive:false});
window.addEventListener('keydown',e=>{
  if(e.key==='0')fit();
  else if(e.key==='+'||e.key==='=')zoomAt(1.15);
  else if(e.key==='-')zoomAt(1/1.15);
  else if(e.key==='Escape')document.getElementById('sidebar').classList.remove('open');
});
apply();
setTimeout(fit,50);
</script>
</body>
</html>`;
}

function deactivate() {
  if (fileWatcher) fileWatcher.dispose();
}

module.exports = { activate, deactivate };
