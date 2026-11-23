import { TYPES, addElement, assertValid, clone, disconnect, empty, members, mergeNodes, parseValue, prune, referenceNode, removeElements, snap, validate } from './model.js';
import { example, EXAMPLES } from './examples.js';
import { autoLayout, route } from './layout.js';
import { esc, exportSvg, scene } from './drawing.js';
import { exportNetlist, parseDescription, parseNetlist, retype } from './input.js';
import { acThevenin, branchMethod, graphEquations, impulseResponse, periodic, portParameters, pulseResponse, solve, thevenin, transfer, transient, twoPort } from './analysis.js';
import { applyReduction, recommendations, reduceAll } from './reduce.js';
import { localVision, readImage, rebuildRecognition, recognizePixels } from './recognize.js';
import { analysisPanel, properties, reductionPanel } from './panels.js';
import { button, icon, menuItem, partIcon, selectOptions, tool } from './ui.js';

const STORAGE = 'circuitlab.workspace.1';
const $ = (id) => document.getElementById(id);
const app = $('app');
let restored;
try {
  restored = JSON.parse(localStorage.getItem(STORAGE) || 'null');
  if (restored) assertValid(restored.doc);
} catch { restored = null; }
let doc = restored?.doc ?? example();
let evidence = restored?.evidence ?? null;
let selected = new Set();
let net = null;
let pending = null;
let drawing;
let toolMode = 'select';
let selectionBox = null;
let ghost = null;
let pointer = null;
let partClick = null;
let zoom = 1;
let shift = { x: 0, y: 0 };
let grid = true;
let showSource = false;
const narrowView = matchMedia('(max-width: 755px)');
let showInspector = !narrowView.matches;
let showLibrary = showInspector;
let showAllExamples = false;
let currentTab = 'properties';
let currentStep = Math.max(0, doc.history.length - 1);
let menu;
let localFile = null;
let lastImage = null;
let readJob = 0;
let toastTimer;
let analysis = { result: null, error: '' };
let analysisOptions = defaultOptions();
let rules = [];
let clip = null;
let space = false;
let autosave = true;
const undoStack = [];
const redoStack = [];
const partKeys = ['R', 'C', 'L', 'V', 'I', 'GND'];

function defaultOptions() {
  const reference = referenceNode(doc);
  const target = doc.nodes.find(n => n.id === 'out') || doc.nodes.filter(n => n.id !== reference).at(-1);
  const ac = doc.elements.some(e => ['V3', 'Z'].includes(e.type) || (['V', 'I'].includes(e.type) && e.ac != null && e.value === 0));
  return {
    mode: ac ? 'ac' : 'dc', duration: doc.elements.some(e => e.type === 'C' && e.value < 1e-6) ? '0.001' : '0.05',
    frequency: '1000', start: '10', stop: '100k', node: target?.id, negative: reference,
    source: doc.elements.find(e => ['V', 'I'].includes(e.type))?.id, response: 'full', second: doc.nodes.find(n => n.id !== reference && n.id !== target?.id)?.id, secondNeg: reference,
    waveform: 'square', amplitude: '1', terms: '12', width: '0.0001',
  };
}

app.innerHTML = `
  <header class="app-header">
    <div class="brand"><img width="36" height="36" src="/assets/mark.svg" alt=""><span>Circuit<span>Lab</span></span></div>
    <span class="header-divider"></span><span class="studio-label">电路工作站</span>
    <div class="header-actions">
      ${button('import-menu', '导入', 'upload', 'plain', 'aria-haspopup="menu"')}${button('save', '保存', 'save', 'plain')}
      ${button('export-menu', '导出', 'download', 'plain', 'aria-haspopup="menu"')}
      <span class="header-divider"></span>${button('run', '运行分析', 'bolt', 'primary run-button')}
    </div>
  </header>
  <main class="workbench" id="workbench">
    <aside class="left" id="library" aria-label="工作区工具">
      <div id="library-content"></div>
      <div class="library-footer">${button('shortcut', '键盘快捷键', 'keyboard', 'plain')}${tool('vision-settings', '本地视觉设置', 'settings')}</div>
    </aside>
    <section class="workspace" aria-label="电路工作区">
      <div class="workspace-head">
        <div class="workspace-navigation">${tool('toggle-library', '切换元件栏', 'sidebar', 'library-toggle')}
          <div class="workspace-title"><span class="workspace-kicker">电路图</span><h1><button id="doc-title" data-action="rename" title="重命名电路"></button></h1></div>
        </div>
        <div class="workspace-actions">${button('layout', '整理电路', 'align', 'outline')}${tool('toggle-inspector', '切换右侧检视器', 'panel', 'inspector-toggle')}</div>
      </div>
      <div class="stage" id="stage" tabindex="0" aria-label="电路画布，可拖入图片">
        <svg xmlns="http://www.w3.org/2000/svg" id="screen" aria-label="可编辑电路图"></svg>
        <div class="canvas-tools" id="canvas-tools" role="toolbar" aria-label="画布工具"></div>
        <div id="empty-state"></div>
        <div class="source-holder" id="source-holder" hidden></div>
        <div class="drop-overlay" id="drop-overlay" hidden><div>${icon('image', 29)}<strong>拖入电路图</strong><span>松开后进行本地识别</span></div></div>
        <div class="canvas-bottom">
          <div class="canvas-hint" id="canvas-hint"></div>
          <div class="zoom" role="toolbar" aria-label="缩放画布">
            ${tool('zoom-out', '缩小', 'minus')}<button type="button" id="zoom-label" data-action="zoom-reset" title="重置缩放">100%</button>
            ${tool('zoom-in', '放大', 'plus')}<span></span>${tool('fit', '适应画布', 'fit')}
          </div>
        </div>
      </div>
    </section>
    <aside class="inspector" id="inspector" aria-label="电路检视器">
      <div class="tabs" id="tabs" role="tablist" aria-label="检视器面板"></div>
      <div id="panel-content" class="panel-content" role="tabpanel" tabindex="0"></div>
    </aside>
  </main>
  <footer class="status-bar">
    <div id="status-main"></div><div id="status-count"></div>
  </footer>
  <div id="popovers"></div><div id="toast" role="status" aria-live="polite"></div>
  <dialog id="dialog" aria-labelledby="dialog-title"></dialog>
  <input id="file-input" type="file" hidden>
`;

function renderLibrary() {
  $('library-content').innerHTML = `
    <section class="library-section"><div class="library-heading"><h2>工作区</h2>${tool('new', '新建电路', 'plus')}</div>
      <button class="project-row" data-action="active-project">${icon('file', 17)}<span>${esc(doc.title)}</span><span class="active-dot"></span></button>
      <div class="library-inputs">${button('image', '识别图片', 'image', 'plain')}${button('text', '文字生成', 'text', 'plain')}</div>
    </section>
    <section class="library-section palette"><div class="library-heading"><h2>元件工具箱</h2></div>
      <div class="palette-grid">${partKeys.map(type => `<button class="part-button" data-action="add" draggable="true" data-type="${type}" title="添加${TYPES[type].label}">
        ${partIcon(type, 23)}<span>${TYPES[type].label}</span></button>`).join('')}</div>
      ${button('parts', '更多元件', 'plus', 'plain more-parts')}
    </section>
    <section class="library-section examples"><div class="library-heading"><h2>电路示例</h2></div>
      ${EXAMPLES.slice(0, showAllExamples ? EXAMPLES.length : 3).map(e => `<button class="example-row" data-action="example" data-id="${e.id}">
       <span class="example-icon">${icon(e.icon, 16)}</span><span><b>${e.name}</b><small>${e.type}</small></span></button>`).join('')}
      ${button('more-examples', showAllExamples ? '收起示例' : '查看全部示例', 'book', 'plain more-examples')}
    </section>`;
}

function saveLocal() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({ doc, evidence }));
    autosave = true;
  } catch {
    autosave = false;
  }
}

function renderStatus() {
  const { errors, warnings } = validate(doc);
  const issue = evidence && (Object.keys(evidence.issues).length || evidence.review);
  const caution = errors.length || warnings.length || issue || drawing.quality.overlaps || drawing.quality.obstructions;
  $('status-main').innerHTML = `<span class="status-dot${caution ? ' caution' : ''}"></span><span>${errors.length ? '拓扑需修正' : issue ? '识别待核对' : warnings.length ? '拓扑待检查' : drawing.quality.overlaps || drawing.quality.obstructions ? '布局待调整' : '工作区就绪'}</span>
    <span class="status-separator"></span><span class="muted">本地工作区</span>`;
  $('status-count').innerHTML = `<span>${doc.elements.filter(e => e.type !== 'GND').length} 个元件</span><span class="status-separator"></span><span>${doc.nodes.length} 个节点</span>
    <span class="status-separator"></span><span class="save-indicator">${icon(autosave ? 'check' : 'warning', 13)} ${autosave ? '自动保存' : '请手动保存'}</span>`;
}

function renderTools() {
  $('canvas-tools').innerHTML = [
    tool('select', '选择 · S', 'cursor', toolMode === 'select' ? 'active' : '', `aria-pressed="${toolMode === 'select'}"`),
    tool('wire', '连线 · W', 'wire', toolMode === 'wire' ? 'active' : '', `aria-pressed="${toolMode === 'wire'}"`),
    tool('hand', '平移 · Space', 'hand', toolMode === 'hand' ? 'active' : '', `aria-pressed="${toolMode === 'hand'}"`),
    '<span class="toolbar-rule"></span>',
    tool('undo', '撤销 · Ctrl+Z', 'undo', '', undoStack.length ? '' : 'disabled'),
    tool('redo', '重做 · Ctrl+Y', 'redo', '', redoStack.length ? '' : 'disabled'),
    '<span class="toolbar-rule"></span>', tool('grid', '显示网格', 'grid', grid ? 'grid-on' : '', `aria-pressed="${grid}"`),
  ].join('');
  $('canvas-hint').innerHTML = pending ? `<span class="connection-hint">${icon('wire', 16)} 选择另一个端口或导线完成连接</span>` :
    evidence ? button('source', showSource ? '隐藏原图' : '对照原图', 'image', 'canvas-import') :
    button('image', '拖入或粘贴图片识别', 'image', 'canvas-import');
}

function renderPanel(preserve = true) {
  const scroll = preserve ? $('panel-content').scrollTop : 0;
  $('tabs').innerHTML = [['properties', '属性', 'settings'], ['analysis', '分析', 'chart'], ['reduction', '化简', 'layers']].map(([id, label, glyph]) =>
    `<button type="button" role="tab" data-action="tab" data-id="${id}" aria-selected="${currentTab === id}" class="${currentTab === id ? 'active' : ''}">${icon(glyph, 16)}${label}</button>`).join('');
  $('panel-content').innerHTML = currentTab === 'properties' ? properties(doc, selected, pending, evidence, net)
    : currentTab === 'analysis' ? analysisPanel(doc, analysisOptions, analysis)
    : reductionPanel(doc, selected, currentStep, (rules = validate(doc).errors.length ? [] : recommendations(doc, [...selected])));
  $('panel-content').scrollTop = scroll;
}

function viewBox() {
  const stage = $('stage');
  const aspect = Math.max(.45, stage.clientWidth / Math.max(10, stage.clientHeight));
  const { x, y, right, bottom } = drawing.bounds;
  const minW = doc.elements.length ? 465 : 800;
  const totalW = Math.max(minW, right - x + 85);
  const totalH = Math.max(doc.elements.length ? 365 : 540, bottom - y + 105);
  const w = Math.max(totalW, totalH * aspect) / zoom;
  const h = w / aspect;
  return [(x + right) / 2 - w / 2 + shift.x, (y + bottom) / 2 - h / 2 + shift.y, w, h];
}

function renderCanvas(recompute = false, updateView = true) {
  if (recompute || !drawing) drawing = route(doc);
  const screen = $('screen');
  if (updateView) screen.setAttribute('viewBox', viewBox().join(' '));
  const pointerWire = ghost && pending ? drawing.pins.find(p => p.id === pending.id && p.pin === pending.pin) : null;
  const pendingPath = pointerWire ? `<path class="pending-path" d="M${pointerWire.x} ${pointerWire.y} H${ghost.x} V${ghost.y}"/>` : '';
  const box = selectionBox ? `<rect class="selection-box" x="${Math.min(selectionBox.x, selectionBox.to.x)}" y="${Math.min(selectionBox.y, selectionBox.to.y)}"
    width="${Math.abs(selectionBox.x - selectionBox.to.x)}" height="${Math.abs(selectionBox.y - selectionBox.to.y)}"/>` : '';
  screen.innerHTML = scene(doc, drawing, { interactive: true, selection: selected, pending, uncertain: new Set(Object.keys(evidence?.issues || {})) }) + pendingPath + box;
  $('stage').classList.toggle('no-grid', !grid);
  $('stage').classList.toggle('panning', toolMode === 'hand' || space);
  $('stage').classList.toggle('wiring', toolMode === 'wire');
  $('zoom-label').textContent = Math.round(zoom * 100) + '%';
  $('empty-state').innerHTML = doc.elements.length || doc.annotations.length ? '' : `
    <div class="blank-state"><div class="blank-icon">${icon('nodes', 31)}</div>
    <h2>开始绘制电路</h2><p>添加元件，或导入一张电路图片。</p>
    ${button('image', '选择图片', 'upload', 'outline')}${button('text', '文字生成', 'text', 'outline')}</div>`;
}

function renderSource() {
  const holder = $('source-holder');
  holder.hidden = !showSource || !evidence?.image;
  if (holder.hidden) return;
  const report = evidence.report;
  const markers = report ? [
    ...report.symbols.map((s, i) => {
      const id = 'image' + (i + 1);
      const e = doc.elements.find(e => e.id === id);
      if (!e) return '';
      return `<button data-action="pick-part" data-id="${id}" class="source-marker${evidence.issues[id] ? ' bad' : ''}"
        style="left:${100 * s.x / report.width}%;top:${100 * s.y / report.height}%" title="${esc(e.name)}"><span>${esc(e.name)}</span></button>`;
    }),
    ...report.joins.map((c, i) => c.crossing ? `<button class="source-marker cross ${c.connected ? 'connected' : ''}" data-image-cross="${i}"
      style="left:${100 * c.x / report.width}%;top:${100 * c.y / report.height}%" title="切换交叉点">${c.connected ? '●' : '+'}</button>` : ''),
  ].join('') : '';
  holder.innerHTML = `<div class="source-head"><strong>识别原图</strong>${tool('source', '关闭原图', 'close')}</div>
    <div class="source-picture"><img src="${esc(evidence.image)}" alt="用于识别的原始电路图">${markers}</div>
    ${report ? '<div class="source-legend">点击标签校对元件 · 点击交叉点切换连接</div>' : ''}`;
}

function render() {
  $('doc-title').textContent = doc.title;
  $('workbench').classList.toggle('hide-right', !showInspector);
  $('workbench').classList.toggle('hide-left', !showLibrary);
  renderLibrary();
  renderTools();
  renderPanel();
  renderCanvas(true);
  renderSource();
  renderStatus();
}

function toast(message, type = '') {
  const node = $('toast');
  clearTimeout(toastTimer);
  node.innerHTML = `${icon(type === 'error' ? 'warning' : 'circleCheck', 18)}<span>${esc(message)}</span>`;
  node.className = 'visible ' + type;
  toastTimer = setTimeout(() => { node.className = ''; }, type === 'error' ? 5800 : 3300);
}

function state() { return { doc: clone(doc), evidence: clone(evidence) }; }

function keepChange(previous, { topology = false, recalc = true } = {}) {
  undoStack.push(previous);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  if (evidence && topology) evidence.topologyEdited = true;
  if (recalc && (analysis.result || analysis.error)) compute(false);
  saveLocal();
  render();
}

function commit(fn, options) {
  const previous = state();
  try {
    fn();
    keepChange(previous, options);
  } catch (err) {
    ({ doc, evidence } = previous);
    render();
    toast(err.message, 'error');
  }
}

function load(next, source = null) {
  const previous = state();
  doc = next;
  evidence = source;
  selected.clear();
  net = pending = null;
  currentTab = 'properties';
  currentStep = Math.max(0, doc.history.length - 1);
  showSource = !!source;
  analysis = { result: null, error: '' };
  analysisOptions = defaultOptions();
  zoom = 1;
  shift = { x: 0, y: 0 };
  keepChange(previous, { recalc: false });
}

function goHistory(from, to) {
  if (!from.length) return;
  to.push(state());
  ({ doc, evidence } = from.pop());
  selected.clear();
  pending = net = null;
  ghost = null;
  toolMode = 'select';
  currentStep = Math.max(0, doc.history.length - 1);
  if (analysis.result || analysis.error) compute(false);
  saveLocal();
  render();
}

function revealInspector() {
  showInspector = true;
  if (narrowView.matches) showLibrary = false;
}

function changeTab(tab) { revealInspector(); currentTab = tab; render(); $('panel-content').scrollTop = 0; }

function selectPart(id, multi = false, focus = false) {
  if (multi) selected.has(id) ? selected.delete(id) : selected.add(id);
  else selected = new Set([id]);
  net = null;
  currentTab = 'properties';
  revealInspector();
  render();
  if (focus) {
    const input = $('panel-content').querySelector('input[data-field="value"]') || $('panel-content').querySelector('input[data-field="name"]');
    input?.focus();
    input?.select();
  }
}

function clickPin(id, pin) {
  const target = doc.elements.find(e => e.id === id);
  if (!target) return;
  if (!pending) {
    pending = { id, pin, node: target.terminals[pin] };
    toolMode = 'wire';
    selected = new Set([id]);
    net = null;
    renderTools();
    renderPanel();
    renderCanvas();
    return;
  }
  const old = pending;
  pending = ghost = null;
  if (old.node === target.terminals[pin]) { render(); return; }
  commit(() => mergeNodes(doc, old.node, target.terminals[pin]), { topology: true });
}

function selectNet(id) {
  if (pending && pending.node !== id) {
    const n = pending.node;
    pending = ghost = null;
    commit(() => mergeNodes(doc, n, id), { topology: true });
  } else {
    selected.clear();
    net = id;
    changeTab('properties');
  }
}

function setReference(id) {
  for (const n of doc.nodes) n.reference = n.id === id;
  for (const g of doc.elements.filter(e => e.type === 'GND')) g.terminals.g = id;
  prune(doc);
}

function copy() {
  if (!selected.size) return;
  clip = {
    elements: doc.elements.filter(e => selected.has(e.id)).map(e => ({ ...clone(e), pose: clone(doc.geometry[e.id]) })),
    couplings: clone(doc.couplings.filter(c => selected.has(c.a) && selected.has(c.b))),
  };
  toast('已复制选中元件');
}

function paste() {
  if (!clip) return;
  commit(() => {
    const nodeMap = new Map();
    const idMap = new Map();
    for (const e of clip.elements) {
      const assigned = Object.fromEntries(Object.entries(e.terminals).map(([p, n]) => {
        if (!nodeMap.has(n)) {
          if (n === '0' || e.type === 'GND') nodeMap.set(n, doc.nodes.find(node => node.reference)?.id ?? '0');
          else {
            let index = 1;
            const reserved = new Set([...doc.nodes.map(node => node.id), ...nodeMap.values()]);
            while (reserved.has('n' + index)) index++;
            nodeMap.set(n, 'n' + index);
          }
        }
        return [p, nodeMap.get(n)];
      }));
      const { id, type, name, control, terminals, pose, ...attrs } = e;
      const next = addElement(doc, type, { ...attrs, terminals: assigned, pose: { ...pose, x: pose.x + 40, y: pose.y + 40, locked: true } });
      idMap.set(id, next.id);
    }
    for (const e of clip.elements.filter(e => e.control)) doc.elements.find(o => o.id === idMap.get(e.id)).control = idMap.get(e.control) ?? (doc.elements.some(o => o.id === e.control) ? e.control : undefined);
    doc.couplings.push(...clip.couplings.map(c => ({ a: idMap.get(c.a), b: idMap.get(c.b), k: c.k })));
    selected = new Set(idMap.values());
    net = null;
    currentTab = 'properties';
  }, { topology: true });
}

function add(type, point) {
  commit(() => {
    const bounds = drawing.bounds;
    const pose = point ?? (!doc.elements.length ? { x: 360, y: 240 } : type === 'GND'
      ? { x: (bounds.x + bounds.right) / 2, y: bounds.bottom + 80 }
      : { x: bounds.right + 98, y: (bounds.y + bounds.bottom) / 2 });
    const e = addElement(doc, type, { ...(type === 'GND' ? { terminals: { g: doc.nodes.find(n => n.reference)?.id ?? '0' } } : {}),
      pose: { x: snap(pose.x), y: snap(pose.y), rotation: ['V', 'I'].includes(type) ? 90 : 0, locked: Boolean(point) } });
    if (type === 'GND') setReference(e.terminals.g);
    selected = new Set([e.id]);
    net = null;
    currentTab = 'properties';
    revealInspector();
  }, { topology: true });
}

function compute(repaint = true) {
  if (repaint) { revealInspector(); currentTab = 'analysis'; }
  try {
    if (evidence && (evidence.review || Object.keys(evidence.issues).length)) throw Error('请在属性面板核对图片识别结果后再分析。');
    const sy = analysisOptions;
    const preferred = defaultOptions();
    const hasNode = id => doc.nodes.some(n => n.id === id);
    for (const prop of ['node', 'negative', 'second', 'secondNeg']) if (!hasNode(sy[prop])) sy[prop] = preferred[prop];
    if (!doc.elements.some(e => e.id === sy.source && ['V', 'I'].includes(e.type))) sy.source = preferred.source;
    let result;
    if (sy.mode === 'graph') { assertValid(doc); result = graphEquations(doc); }
    else if (sy.mode === 'branch' || sy.mode === 'loop') result = branchMethod(doc, sy.mode);
    else if (sy.mode === 'port') result = thevenin(doc, sy.node, sy.negative);
    else if (sy.mode === 'portAc') result = acThevenin(doc, sy.node, sy.negative, parseValue(sy.frequency, 'Hz'));
    else if (sy.mode === 'two') {
      const frequency = parseValue(sy.frequency, 'Hz');
      if (frequency < 0) throw Error('频率不能小于零。');
      result = portParameters(twoPort(doc, [[sy.node, sy.negative], [sy.second, sy.secondNeg]], frequency));
    } else if (sy.mode === 'time') {
      const timeOptions = { ...sy, duration: parseValue(sy.duration, 's') };
      if (sy.response === 'pulse') result = pulseResponse(doc, { ...timeOptions, width: parseValue(sy.width, 's') });
      else result = (sy.response === 'impulse' ? impulseResponse : transient)(doc, timeOptions);
    } else if (sy.mode === 'periodic') {
      const unit = TYPES[doc.elements.find(e => e.id === sy.source)?.type]?.unit;
      result = periodic(doc, { ...sy, frequency: parseValue(sy.frequency, 'Hz'), amplitude: parseValue(sy.amplitude, unit), terms: parseValue(sy.terms) });
    }
    else if (sy.mode === 'bode') result = transfer(doc, { ...sy, start: parseValue(sy.start, 'Hz'), stop: parseValue(sy.stop, 'Hz') });
    else result = solve(doc, sy.mode, sy.mode === 'ac' ? parseValue(sy.frequency, 'Hz') : undefined);
    analysis = { result, error: '' };
  } catch (err) { analysis = { result: null, error: err.message }; }
  if (repaint) render();
}

const fileName = ext => (doc.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'circuit') + ext;
function download(content, type, ext) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(ext);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function png() {
  const url = URL.createObjectURL(new Blob([exportSvg(doc, { embedModel: false })], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(3, 4096 / Math.max(image.width, image.height));
    canvas.width = Math.ceil(image.width * scale);
    canvas.height = Math.ceil(image.height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw Error('无法导出此尺寸的 PNG。');
    download(blob, 'image/png', '.png');
  } finally { URL.revokeObjectURL(url); }
}

function report() {
  if (!analysis.result) compute(false);
  if (!analysis.result) throw Error(analysis.error);
  const output = analysisPanel(doc, analysisOptions, analysis);
  const parsed = new DOMParser().parseFromString(output, 'text/html');
  const results = [...parsed.querySelectorAll('section')].map(s => s.outerHTML.replace(/<details>/g, '<details open>')).join('');
  const title = esc(doc.title);
  download(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title} · CircuitLab</title>
    <style>body{max-width:1000px;margin:3rem auto;padding:0 2rem;color:#292521;font:16px/1.7 system-ui}h1,h2,h3{line-height:1.3}table{border-collapse:collapse}td,th{padding:.35rem .65rem;border:1px solid #ddd;text-align:left}section{margin:2rem 0}.table-wrap{overflow:auto}.schematic svg{width:min(100%,650px);height:auto}.plot,.phasor{width:min(100%,460px)}.note svg{display:none}.result-sub{display:block}code,pre{white-space:pre-wrap}summary{cursor:pointer}</style>
    <h1>${title}</h1><p>CircuitLab · 电路分析报告</p><div class="schematic">${exportSvg(doc, { embedModel: false })}</div>${results}
    <h2>电路网表</h2><pre>${esc(exportNetlist(doc))}</pre><details><summary>完整计算数据</summary><pre>${esc(JSON.stringify(analysis.result, null, 2))}</pre></details></html>`, 'text/html', '.html');
}

function openModal(title, body) {
  const dialog = $('dialog');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${title}</h2>${tool('close-modal', '关闭', 'close')}</div>${body}`;
  if (!dialog.open) dialog.showModal();
}

function closeModal() { $('dialog').close(); }

function openMenu(items, anchor, at) {
  const pop = $('popovers');
  pop.innerHTML = `<div class="popover" role="menu">${items.join('')}</div>`;
  menu = pop.firstElementChild;
  const origin = anchor?.getBoundingClientRect();
  const x = at?.x ?? (origin.right - menu.offsetWidth);
  const y = at?.y ?? (origin.bottom + 7);
  menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, x)) + 'px';
  menu.style.top = Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, y)) + 'px';
  menu.querySelector('button:not([disabled])')?.focus();
}

function closeMenu() { $('popovers').innerHTML = ''; menu = null; }

function partMenu(anchor, at) {
  if (!selected.size) return;
  openMenu([
    menuItem('rotate', '旋转', 'rotate', 'R'), menuItem('mirror', '镜像', 'mirror'),
    menuItem('copy', '复制', 'copy', 'Ctrl+C'), menuItem('flip-current', '电流反向', 'wire'),
    menuItem('flip-voltage', '极性反向', 'plus'), menuItem('swap-ports', '对调 p/n 端', 'wire'), menuItem('reduce', '等效化简', 'layers'),
    '<hr>', menuItem('delete', '删除', 'trash', 'Del'),
  ], anchor, at);
}

function filePicker(kind) {
  const f = $('file-input');
  f.value = '';
  f.accept = kind === 'image' ? 'image/png,image/jpeg,image/webp,image/bmp,image/gif,image/svg+xml' : '.json,.cir,.net,.sp,.txt,application/json,text/plain';
  f.dataset.kind = kind;
  f.click();
}

async function importImage(file) {
  const job = ++readJob;
  if (file.type === 'image/svg+xml' && file.size <= 8_000_000) {
    const svg = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
    const ir = svg.querySelector('metadata#circuitlab-ir');
    if (job !== readJob) return;
    if (ir) {
      const model = assertValid(JSON.parse(ir.textContent));
      load(model);
      toast('已恢复 SVG 中的电路拓扑与参数。');
      return;
    }
  }
  toast('正在识别图片…');
  const loaded = await readImage(file);
  if (job !== readJob) return;
  const { image, pixels } = loaded;
  const title = file.name?.replace(/\.[^.]+$/, '') || '图片识别电路';
  lastImage = { image, title };
  await new Promise(requestAnimationFrame);
  if (job !== readJob) return;
  try {
    const { model, ...raw } = recognizePixels(pixels, title);
    const issues = {};
    raw.symbols.forEach((s, i) => {
      if (s.type === 'GND') return;
      const reasons = [];
      if (!['OPEN', 'SHORT'].includes(s.type) && s.label?.value === undefined && s.label?.ac === undefined) reasons.push('待填写或核对数值');
      if (s.score < .87) reasons.push('符号待核对');
      if (s.sourceUncertain) reasons.push('源方向待核对');
      if (reasons.length) issues['image' + (i + 1)] = model.elements[i].name + ' · ' + reasons.join('，');
    });
    const detail = [
      raw.joins.some(c => c.crossing) ? '核对交叉点是否连接' : '核对端口和节点',
      raw.unsupported.length ? '存在待人工补画的受控源' : '',
      raw.uncertain.length ? '存在未纳入电路的低置信标记' : '',
      raw.loose ? '有未归入元件支路的线段' : '',
    ].filter(Boolean).join('，') + '。';
    load(model, { image, report: raw, issues, review: detail });
    toast(`识别到 ${model.elements.filter(e => e.type !== 'GND').length} 个元件，请结合原图校对。`);
  } catch (error) {
    showSource = true;
    openModal('图片需要进一步识别', `<p>${esc(error.message)}</p><img class="failed-image" src="${esc(image)}" alt="待识别的原图">
      <div class="dialog-actions">${button('vision-settings', '本地视觉识别', 'settings', 'outline')}${button('trace-image', '手工绘制', 'cursor', 'primary')}</div>`);
    $('toast').className = '';
  }
}

function toggleImageCross(index) {
  if (!evidence?.report) return;
  if (evidence.topologyEdited) { toast('节点已被手工修改。请在画布中使用端口连接或断开。', 'error'); return; }
  commit(() => {
    const report = evidence.report;
    report.joins[index].connected = !report.joins[index].connected;
    const updated = rebuildRecognition(report);
    const oldLabels = new Map(doc.nodes.filter(n => n.id !== n.label).map(n => [n.id, n.label]));
    const nodeOrigins = new Map(updated.nodes.map(n => [n.id, new Set()]));
    for (const item of updated.elements) {
      const previous = doc.elements.find(e => e.id === item.id);
      for (const [pin, id] of Object.entries(item.terminals)) nodeOrigins.get(id).add(previous?.terminals[pin]);
    }
    const used = new Set();
    doc.nodes = updated.nodes.map(n => {
      const prior = [...nodeOrigins.get(n.id)].find(id => !used.has(id) && oldLabels.has(id));
      if (prior) used.add(prior);
      return { ...n, label: oldLabels.get(prior) ?? n.label };
    });
    for (const item of doc.elements) item.terminals = updated.elements.find(e => e.id === item.id)?.terminals || item.terminals;
    evidence.review = '交叉点已更改，请核对端口及节点。';
  });
}

function canvasPoint(event) {
  const svg = $('screen');
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
}

function splitJunction(point) {
  const parts = drawing.wires.filter(w => w.node === point.node);
  const set = [];
  for (const pin of drawing.pins.filter(p => p.node === point.node)) {
    const queue = [pin];
    const visited = new Set();
    let vertical = false;
    let horizontal = false;
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      const id = p.x + ',' + p.y;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const s of parts) {
        const inside = (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b);
        const on = s.h ? p.y === s.a.y && inside(p.x, s.a.x, s.b.x) : p.x === s.a.x && inside(p.y, s.a.y, s.b.y);
        if (!on) continue;
        const crosses = s.h ? s.a.y === point.y && inside(point.x, s.a.x, s.b.x) : s.a.x === point.x && inside(point.y, s.a.y, s.b.y);
        if (crosses) s.h ? horizontal = true : vertical = true;
        for (const e of [s.a, s.b]) if (e.x !== point.x || e.y !== point.y) {
          if (crosses && (s.h ? (p.x - point.x) * (e.x - point.x) < 0 : (p.y - point.y) * (e.y - point.y) < 0)) continue;
          queue.push(e);
        }
      }
    }
    if (vertical && !horizontal && doc.elements.find(e => e.id === pin.id)?.type !== 'GND') set.push(pin);
  }
  if (!set.length || set.length === members(doc, point.node).length) throw Error('无法仅按方向区分此连接。请选择节点上的具体端口断开。');
  disconnect(doc, set);
}

function selectStageMenu(target, at, anchor) {
  const cross = target.closest('[data-cross]');
  const junction = target.closest('[data-junction]');
  const part = target.closest('[data-element]');
  const pin = target.closest('[data-pin]');
  const wire = target.closest('[data-wire]');
  if (cross) {
    openMenu([menuItem('join-cross', '连接交叉导线', 'wire', '', `data-index="${cross.dataset.cross}"`)], anchor, at);
  } else if (junction) {
    openMenu([menuItem('split-cross', '拆分交叉连接', 'split', '', `data-index="${junction.dataset.junction}"`),
      menuItem('pick-net', '查看节点端口', 'nodes', '', `data-id="${esc(drawing.junctions[junction.dataset.junction].node)}"`)], anchor, at);
  } else if (pin) {
    openMenu([menuItem('pin-click', '连接端口', 'wire', '', `data-id="${esc(pin.dataset.id)}" data-pin-name="${esc(pin.dataset.pin)}"`),
      menuItem('net-disconnect', '断开端口', 'split', '', `data-id="${esc(pin.dataset.id)}" data-pin-name="${esc(pin.dataset.pin)}"`)], anchor, at);
  } else if (part) {
    if (!selected.has(part.dataset.element)) selectPart(part.dataset.element);
    partMenu(anchor, at);
  } else if (wire) {
    openMenu([menuItem('pick-net', '查看节点端口', 'nodes', '', `data-id="${esc(wire.dataset.wire)}"`)], anchor, at);
  } else {
    const p = canvasPoint(at ? { clientX: at.x, clientY: at.y } : anchor.getBoundingClientRect());
    openMenu([menuItem('parts', '添加元件', 'plus'), menuItem('annotation', '添加注释', 'text', '', `data-x="${snap(p.x)}" data-y="${snap(p.y)}"`),
      menuItem('paste', '粘贴元件', 'copy', 'Ctrl+V'), menuItem('layout', '整理电路', 'align'), menuItem('relayout', '重新自动布局', 'align')], anchor, at);
  }
}

function configure(action, target) {
  const e = doc.elements.find(item => selected.has(item.id));
  const d = target.dataset;
  switch (action) {
    case 'import-menu': openMenu([menuItem('image', '识别图片', 'image'), menuItem('open', '打开本地工程或网表', 'file'), menuItem('text', '由文字生成', 'text'), menuItem('netlist', '粘贴网表', 'nodes')], target); break;
    case 'export-menu': openMenu([menuItem('svg', '电路图 · SVG', 'image'), menuItem('png', '电路图 · PNG', 'image'), menuItem('report', '分析报告 · HTML', 'chart'), menuItem('save', 'Circuit IR 工程 · JSON', 'save'), menuItem('export-netlist', 'CircuitLab 网表', 'file')], target); break;
    case 'open': filePicker('project'); break;
    case 'image': filePicker('image'); break;
    case 'new': load(empty()); break;
    case 'active-project': selected.clear(); net = null; zoom = 1; shift = { x: 0, y: 0 }; changeTab('properties'); break;
    case 'example': load(example(d.id)); break;
    case 'more-examples': showAllExamples = !showAllExamples; renderLibrary(); break;
    case 'toggle-library': showLibrary = !showLibrary; if (narrowView.matches && showLibrary) showInspector = false; render(); break;
    case 'toggle-inspector': if (showInspector) showInspector = false; else revealInspector(); render(); break;
    case 'tab': changeTab(d.id); break;
    case 'run': compute(); break;
    case 'save': download(JSON.stringify({ doc: assertValid(doc), evidence }, null, 2), 'application/json', '.circuit.json'); toast('已保存工程'); break;
    case 'svg': download(exportSvg(doc), 'image/svg+xml', '.svg'); break;
    case 'png': void png().catch(err => toast(err.message, 'error')); break;
    case 'export-netlist': download(exportNetlist(doc), 'text/plain', '.cir'); break;
    case 'report': report(); break;
    case 'select':
    case 'wire':
    case 'hand': toolMode = action; if (action !== 'wire') pending = ghost = null; renderTools(); renderCanvas(); break;
    case 'grid': grid = !grid; renderTools(); renderCanvas(); break;
    case 'undo': goHistory(undoStack, redoStack); break;
    case 'redo': goHistory(redoStack, undoStack); break;
    case 'fit':
    case 'zoom-reset': zoom = 1; shift = { x: 0, y: 0 }; renderCanvas(); break;
    case 'zoom-out':
    case 'zoom-in': zoom = Math.max(.22, Math.min(6, zoom * (action === 'zoom-in' ? 1.2 : 1 / 1.2))); renderCanvas(); break;
    case 'layout':
    case 'relayout': {
      const result = autoLayout(doc, action === 'layout');
      commit(() => { doc = result.model; zoom = 1; shift = { x: 0, y: 0 }; }, { recalc: false });
      toast(`排版完成，拓扑一致 · ${result.crossings} 处导线交叉`);
      break;
    }
    case 'part-menu': partMenu(target); break;
    case 'add': add(d.type); closeModal(); break;
    case 'parts': openModal('元件工具箱', `<div class="full-palette">${Object.entries(TYPES).map(([type, spec]) => `<button class="part-button" data-action="add" data-type="${type}">${partIcon(type, 26)}<span>${spec.label}</span></button>`).join('')}</div>`); break;
    case 'pick-part': selectPart(d.id); break;
    case 'pick-net': selectNet(d.id); break;
    case 'merge-net': if (net) { pending = { node: net }; toolMode = 'wire'; render(); } break;
    case 'pick-pin': if (e) clickPin(e.id, d.pinName); break;
    case 'pin-click': clickPin(d.id, d.pinName); break;
    case 'disconnect-pin':
    case 'net-disconnect': {
      const id = d.id ?? e?.id;
      if (doc.elements.find(item => item.id === id)?.type === 'GND') throw Error('请通过节点属性修改参考地。');
      if (id) commit(() => disconnect(doc, [{ id, pin: d.pinName }]), { topology: true });
      break;
    }
    case 'ground-net': if (net) commit(() => setReference(net), { topology: true }); break;
    case 'join-cross': {
      const cross = drawing.hops[d.index];
      commit(() => mergeNodes(doc, cross.a, cross.b), { topology: true });
      break;
    }
    case 'split-cross': commit(() => splitJunction(drawing.junctions[d.index]), { topology: true }); break;
    case 'rotate':
    case 'mirror':
    case 'lock':
      if (selected.size) commit(() => {
        for (const id of selected) {
          const pose = doc.geometry[id];
          if (action === 'rotate') { pose.rotation = (pose.rotation + 90) % 360; pose.locked = true; }
          if (action === 'mirror') { pose.mirror = !pose.mirror; pose.locked = true; }
          if (action === 'lock') pose.locked = !pose.locked;
        }
      }, { recalc: false });
      break;
    case 'flip-current':
    case 'flip-voltage':
      if (selected.size) commit(() => {
        for (const item of doc.elements.filter(item => selected.has(item.id) && item.terminals.p !== undefined)) {
          item[action === 'flip-current' ? 'currentSign' : 'voltageSign'] *= -1;
          item.showReferences = true;
        }
      });
      break;
    case 'swap-ports':
      if (selected.size) commit(() => {
        for (const item of doc.elements.filter(item => selected.has(item.id) && item.terminals.p !== undefined)) {
          [item.terminals.p, item.terminals.n] = [item.terminals.n, item.terminals.p];
        }
      }, { topology: true });
      break;
    case 'delete':
      if (selected.size) commit(() => {
        if (evidence) for (const id of selected) delete evidence.issues[id];
        removeElements(doc, [...selected]);
        selected.clear();
        pending = ghost = null;
      }, { topology: true });
      break;
    case 'copy': copy(); break;
    case 'paste': paste(); break;
    case 'reduce': changeTab('reduction'); break;
    case 'next-reduce':
    case 'apply-rule': {
      const option = rules[d.index ?? 0];
      if (!option) break;
      commit(() => {
        guardEvidence();
        doc = applyReduction(doc, option).model;
        selected.clear();
        currentStep = doc.history.length - 1;
      }, { topology: true });
      break;
    }
    case 'auto-reduce': commit(() => {
      guardEvidence();
      const next = reduceAll(doc, [...selected]);
      if (next === doc) throw Error('当前没有可自动应用的变换。');
      doc = next;
      selected.clear();
      currentStep = doc.history.length - 1;
    }, { topology: true }); break;
    case 'step-prev':
    case 'step-next': currentStep += action === 'step-prev' ? -1 : 1; renderPanel(); break;
    case 'source': showSource = !showSource; renderSource(); renderTools(); break;
    case 'trace-image': {
      if (!lastImage) break;
      load(empty(lastImage.title), { image: lastImage.image, issues: {}, review: '' });
      closeModal();
      break;
    }
    case 'confirm-part':
      if (e && evidence) commit(() => {
        delete evidence.issues[e.id];
        if (evidence.review && !Object.keys(evidence.issues).length) selected.clear();
      });
      break;
    case 'confirm-image': if (evidence) commit(() => { evidence.review = ''; }); break;
    case 'rename': openModal('重命名电路', `<form data-form="rename"><label class="field"><span>电路名称</span>
      <input name="title" value="${esc(doc.title)}" required maxlength="80" autofocus></label><div class="dialog-actions"><button class="button primary">保存名称</button></div></form>`); break;
    case 'text':
    case 'netlist':
      openModal(action === 'text' ? '由文字生成电路' : '导入网表', `<form data-form="${action}">
        <p>${action === 'text' ? '写出元件的数值和连接方式，或逐支路指定两个节点。' : '输入 CircuitLab 网表。节点 0 表示参考地。'}</p>
        <label class="sr-only" for="described-circuit">电路描述</label><textarea id="described-circuit" name="description" rows="7" required autofocus placeholder="${action === 'text' ? '5 V 电压源、1 kΩ 电阻与 100 nF 电容串联，构成低通电路。' : 'V1 in 0 DC 5 AC 1&#10;R1 in out 1k&#10;C1 out 0 100n'}"></textarea>
        <p class="form-error" role="alert"></p><div class="dialog-actions"><button class="button primary">${icon('nodes', 17)} 生成电路</button></div></form>`);
      break;
    case 'annotation': openModal('添加注释', `<form data-form="annotation" data-x="${d.x}" data-y="${d.y}"><label class="field"><span>注释</span><input name="text" maxlength="100" required autofocus></label>
      <div class="dialog-actions"><button class="button primary">添加</button></div></form>`); break;
    case 'couple': {
      const inductors = doc.elements.filter(o => o.type === 'L' && o.id !== e.id);
      if (!inductors.length) throw Error('请先添加第二个电感。');
      const current = doc.couplings.find(k => k.a === e.id || k.b === e.id);
      openModal('电感互感', `<form data-form="couple" data-id="${esc(e.id)}"><p>同名端采用两个电感的 p 端。负系数表示反向耦合。</p>
        <label class="field"><span>另一电感</span><select name="other">${selectOptions(inductors.map(o => [o.id, o.name]), current ? current.a === e.id ? current.b : current.a : null)}</select></label>
        <label class="field"><span>耦合系数 k</span><input name="k" value="${current?.k ?? .9}" required></label>
        <p class="form-error" role="alert"></p><div class="dialog-actions"><button class="button primary">保存互感</button></div></form>`);
      break;
    }
    case 'vision-settings':
      openModal('本地视觉识别', `<form data-form="vision"><p>使用本机的 OpenAI 兼容视觉服务。导入的图片会发送到此本机地址。</p>
        <label class="field"><span>服务地址</span><input name="endpoint" type="url" value="http://127.0.0.1:11434/v1" required></label>
        <label class="field"><span>模型名称</span><input name="model" placeholder="视觉模型名" required></label>
        <label class="field"><span>API Key（可选）</span><input name="key" type="password" autocomplete="off"></label>
        <label class="field"><span>图片</span><input name="picture" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
        ${lastImage || evidence?.image ? '<p>可使用最近导入的原图。</p>' : ''}<p class="form-error" role="alert"></p>
        <div class="dialog-actions"><button class="button primary">开始本地识别</button></div></form>`);
      break;
    case 'shortcut': openModal('键盘快捷键', `<div class="shortcut-list">${[
      ['选择', 'S'], ['连线', 'W'], ['平移画布', 'Space'], ['旋转选中元件', 'R'], ['删除', 'Delete'], ['撤销 / 重做', 'Ctrl+Z / Ctrl+Y'],
      ['复制 / 粘贴', 'Ctrl+C / Ctrl+V'], ['全部选中', 'Ctrl+A'], ['适应画布', '0'], ['另存工程', 'Ctrl+S'], ['取消当前操作', 'Esc'],
    ].map(([text, key]) => `<div><span>${text}</span><kbd>${key}</kbd></div>`).join('')}</div>`); break;
    case 'close-modal': closeModal(); break;
  }
}

function guardEvidence() {
  if (evidence && (evidence.review || Object.keys(evidence.issues).length)) throw Error('请先校对识别出的元件和节点。');
}

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  const imageCross = event.target.closest('[data-image-cross]');
  if (imageCross) { toggleImageCross(Number(imageCross.dataset.imageCross)); return; }
  if (!target || target.disabled) {
    if (!event.target.closest('.popover,[data-cross],[data-junction]')) closeMenu();
    return;
  }
  const { action } = target.dataset;
  closeMenu();
  try { configure(action, target); } catch (err) { toast(err.message, 'error'); }
});

app.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  const values = new FormData(form);
  const { form: action, id, x, y } = form.dataset;
  try {
    if (action === 'text' || action === 'netlist') {
      const description = values.get('description');
      load(action === 'text' ? parseDescription(description) : parseNetlist(description));
    } else if (action === 'rename') {
      const title = values.get('title').trim();
      if (!title) throw Error('请输入电路名称。');
      commit(() => { doc.title = title; }, { recalc: false });
    } else if (action === 'annotation') {
      const content = values.get('text').trim();
      if (!content) throw Error('请输入注释内容。');
      commit(() => doc.annotations.push({ x: Number(x), y: Number(y), text: content }), { recalc: false });
    } else if (action === 'couple') {
      const other = values.get('other');
      const k = parseValue(values.get('k'));
      if (Math.abs(k) >= 1) throw Error('互感模型要求 |k| < 1。');
      commit(() => {
        doc.couplings = doc.couplings.filter(c => !(c.a === id && c.b === other || c.a === other && c.b === id));
        if (k) doc.couplings.push({ a: id, b: other, k });
      }, { topology: true });
    } else if (action === 'vision') {
      const picture = values.get('picture');
      const from = picture.size ? await readImage(picture) : { image: lastImage?.image ?? evidence?.image };
      if (!from.image) throw Error('请先选择电路图片。');
      const submit = form.querySelector('button:not([type="button"])');
      submit.disabled = true;
      submit.textContent = '正在识别…';
      try {
        const result = await localVision({ endpoint: values.get('endpoint'), model: values.get('model'), key: values.get('key'), image: from.image, title: lastImage?.title || '视觉识别电路' });
        if (!form.isConnected || !$('dialog').open) return;
        load(result.model, { image: from.image, issues: {}, review: result.uncertain.join('；') || '请对照原图核对连接、参数和极性。' });
      } finally { submit.disabled = false; submit.textContent = '开始本地识别'; }
    }
    closeModal();
  } catch (err) {
    const error = form.querySelector('.form-error');
    if (error) error.textContent = err.message;
    else toast(err.message, 'error');
  }
});

async function openProject(file) {
  if (file.size > 15_000_000) throw Error('工程文件超过 15 MB。');
  const text = await file.text();
  if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
    const project = JSON.parse(text);
    const source = project.evidence?.image?.startsWith('data:image/png;base64,') && project.evidence.issues && typeof project.evidence.review === 'string'
      ? project.evidence : null;
    const model = assertValid(project.doc ?? project);
    model.history = model.history.filter(s => s?.before && s?.after && !validate({ ...s.before, history: [] }).errors.length && !validate({ ...s.after, history: [] }).errors.length)
      .map(s => ({ ...s, before: { ...s.before, history: [] }, after: { ...s.after, history: [] } }));
    load(model, source);
    toast('已打开工程');
  } else load(parseNetlist(text, file.name.replace(/\.[^.]+$/, '')));
}

$('file-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (event.target.dataset.kind === 'image') await importImage(file);
    else await openProject(file);
  } catch (err) { toast(err.message, 'error'); }
});

$('panel-content').addEventListener('change', event => {
  const { field, pinName } = event.target.dataset;
  if (!field) return;
  const value = event.target.value;
  if (field.startsWith('a-') || field === 'analysis-mode') {
    if (field === 'analysis-mode') { analysisOptions.mode = value; if (value === 'two') analysisOptions.frequency = '0'; }
    else analysisOptions[field.slice(2)] = value;
    compute();
    return;
  }
  const e = doc.elements.find(item => selected.has(item.id));
  commit(() => {
    if (field === 'reference') {
      if (value) setReference(value);
      else if (!doc.elements.some(item => item.type === 'GND')) for (const n of doc.nodes) n.reference = false;
      else throw Error('移除接地符号后可取消参考地。');
    } else if (field === 'net-label' && net) doc.nodes.find(n => n.id === net).label = value.trim() || net;
    else if (e) {
      const spec = TYPES[e.type];
      if (field === 'value') {
        const number = parseValue(value, spec.unit);
        if (['R', 'C', 'L', 'T'].includes(e.type) && number <= 0) throw Error('此元件的数值必须大于零。');
        e.value = number;
        e.expression = value.trim();
      } else if (field === 'initial') e.initial = parseValue(value, spec.initial);
      else if (field === 'phase') e.phase = parseValue(value);
      else if (field === 'reactance') e.reactance = parseValue(value, 'Ω');
      else if (field === 'ac') {
        e.ac = value.trim() ? parseValue(value, spec.unit) : null;
        if (e.ac < 0) throw Error('交流有效值必须非负。');
      } else if (field === 'name') {
        const name = value.trim();
        if (!name || doc.elements.some(o => o.id !== e.id && o.name === name)) throw Error('请输入唯一的元件名称。');
        e.name = name;
      } else if (field === 'control') e.control = value;
      else if (field === 'type') { retype(doc, e.id, value); prune(doc); }
      else if (field === 'pin-node') { e.terminals[pinName] = value; prune(doc); }
    }
  }, { topology: ['pin-node', 'type', 'reference'].includes(field) });
});

const stage = $('stage');
stage.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.button !== 1 || event.target.closest('button,.source-holder')) return;
  if (event.target.closest('[data-pin],[data-cross],[data-junction]')) return;
  const element = event.target.closest('[data-element]');
  const wire = event.target.closest('[data-wire]');
  const p = canvasPoint(event);
  if (toolMode === 'hand' || space || event.button === 1) {
    pointer = { type: 'pan', at: { x: event.clientX, y: event.clientY }, shift: { ...shift }, scale: viewBox()[2] / stage.clientWidth };
  } else if (element && toolMode !== 'wire') {
    const id = element.dataset.element;
    const had = selected.has(id);
    if (event.shiftKey || event.ctrlKey || !had) selectPart(id, event.shiftKey || event.ctrlKey);
    if (!selected.has(id)) return;
    pointer = { type: 'part', at: p, id, multi: had && selected.size > 1,
      plan: Object.fromEntries([...selected].map(key => [key, { ...doc.geometry[key] }])), before: state() };
  } else if (!wire && toolMode !== 'wire') {
    pointer = { type: 'box', at: p, previous: new Set(event.shiftKey ? selected : []) };
  }
  if (pointer) stage.setPointerCapture(event.pointerId);
});

stage.addEventListener('pointermove', event => {
  const p = canvasPoint(event);
  if (pointer?.type === 'pan') {
    shift = { x: pointer.shift.x - (event.clientX - pointer.at.x) * pointer.scale, y: pointer.shift.y - (event.clientY - pointer.at.y) * pointer.scale };
    $('screen').setAttribute('viewBox', viewBox().join(' '));
  } else if (pointer?.type === 'part') {
    const dx = snap(p.x - pointer.at.x);
    const dy = snap(p.y - pointer.at.y);
    if (dx || dy || pointer.moved) {
      for (const [id, start] of Object.entries(pointer.plan)) Object.assign(doc.geometry[id], { x: start.x + dx, y: start.y + dy, locked: true });
      pointer.moved = true;
      renderCanvas(true, false);
    }
  } else if (pointer?.type === 'box') {
    selectionBox = { x: pointer.at.x, y: pointer.at.y, to: p };
    renderCanvas(false, false);
  } else if (pending) {
    ghost = p;
    renderCanvas(false, false);
  }
});

stage.addEventListener('pointerup', () => {
  if (pointer?.type === 'part' && pointer.moved) {
    const oldFrame = $('screen').getAttribute('viewBox').split(' ').map(Number);
    const newFrame = viewBox();
    shift.x += oldFrame[0] + oldFrame[2] / 2 - newFrame[0] - newFrame[2] / 2;
    shift.y += oldFrame[1] + oldFrame[3] / 2 - newFrame[1] - newFrame[3] / 2;
    keepChange(pointer.before, { recalc: false });
  } else if (pointer?.type === 'box') {
    selected = pointer.previous;
    if (selectionBox) {
      const { x, y, to } = selectionBox;
      for (const [id, p] of Object.entries(doc.geometry)) {
        if (p.x >= Math.min(x, to.x) && p.x <= Math.max(x, to.x) && p.y >= Math.min(y, to.y) && p.y <= Math.max(y, to.y)) selected.add(id);
      }
    }
    net = null;
    if (selected.size) { currentTab = 'properties'; revealInspector(); }
    selectionBox = null;
    render();
  } else if (pointer?.type === 'part' && pointer.multi) {
    selected = new Set([pointer.id]);
    render();
  }
  if (pointer?.type === 'part' && !pointer.moved) {
    if (partClick?.id === pointer.id && performance.now() - partClick.time < 450) {
      selectPart(pointer.id, false, true);
      partClick = null;
    } else partClick = { id: pointer.id, time: performance.now() };
  } else partClick = null;
  pointer = null;
});

stage.addEventListener('pointercancel', () => {
  if (pointer?.type === 'part' && pointer.moved) ({ doc, evidence } = pointer.before);
  pointer = selectionBox = null;
  render();
});

stage.addEventListener('click', event => {
  const pin = event.target.closest('[data-pin]');
  const cross = event.target.closest('[data-cross],[data-junction]');
  const wire = event.target.closest('[data-wire]');
  if (pin) clickPin(pin.dataset.id, pin.dataset.pin);
  else if (cross) selectStageMenu(cross, { x: event.clientX, y: event.clientY });
  else if (wire) selectNet(wire.dataset.wire);
});

stage.addEventListener('contextmenu', event => {
  if (event.target.closest('.source-holder')) {
    const el = event.target.closest('[data-image-cross]');
    if (el) { event.preventDefault(); toggleImageCross(Number(el.dataset.imageCross)); }
    return;
  }
  event.preventDefault();
  selectStageMenu(event.target, { x: event.clientX, y: event.clientY });
});

stage.addEventListener('wheel', event => {
  if (event.target.closest('.source-holder')) return;
  event.preventDefault();
  const before = canvasPoint(event);
  zoom = Math.max(.22, Math.min(6, zoom * (event.deltaY < 0 ? 1.10 : 1 / 1.10)));
  $('screen').setAttribute('viewBox', viewBox().join(' '));
  const after = canvasPoint(event);
  shift.x += before.x - after.x;
  shift.y += before.y - after.y;
  $('screen').setAttribute('viewBox', viewBox().join(' '));
  $('zoom-label').textContent = Math.round(zoom * 100) + '%';
}, { passive: false });

document.addEventListener('dragstart', event => {
  const part = event.target.closest('[draggable][data-type]');
  if (part) event.dataTransfer.setData('application/x-circuitlab-part', part.dataset.type);
});
app.addEventListener('dragover', event => {
  if (event.dataTransfer.types.some(t => ['Files', 'application/x-circuitlab-part'].includes(t))) {
    event.preventDefault();
    if (event.dataTransfer.types.includes('Files')) $('drop-overlay').hidden = false;
  }
});
app.addEventListener('dragleave', event => { if (event.relatedTarget && !app.contains(event.relatedTarget)) $('drop-overlay').hidden = true; });
app.addEventListener('drop', async event => {
  event.preventDefault();
  $('drop-overlay').hidden = true;
  const type = event.dataTransfer.getData('application/x-circuitlab-part');
  if (Object.hasOwn(TYPES, type)) { add(type, canvasPoint(event)); return; }
  const file = [...event.dataTransfer.files].find(item => item.type.startsWith('image/') || /\.(json|cir|net|sp|txt)$/i.test(item.name));
  if (!file) { toast('请选择电路图片、工程或网表。', 'error'); return; }
  try {
    if (file.type.startsWith('image/')) await importImage(file);
    else await openProject(file);
  } catch (err) { toast(err.message, 'error'); }
});

document.addEventListener('paste', async event => {
  if (event.target.closest('input,textarea,[contenteditable]')) return;
  const image = [...event.clipboardData.files].find(item => item.type.startsWith('image/'));
  if (image) { event.preventDefault(); try { await importImage(image); } catch (err) { toast(err.message, 'error'); } }
  else if (clip) { event.preventDefault(); paste(); }
});

document.addEventListener('keydown', event => {
  const { target, key } = event;
  if (menu && ['ArrowDown', 'ArrowUp', 'Escape'].includes(key)) {
    event.preventDefault();
    if (key === 'Escape') closeMenu();
    else {
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      items[(items.indexOf(document.activeElement) + items.length + (key === 'ArrowDown' ? 1 : -1)) % items.length]?.focus();
    }
    return;
  }
  if (target.matches?.('input[data-field]') && key === 'Enter') { event.preventDefault(); target.blur(); return; }
  if (target.closest('input,select,textarea,[contenteditable]') || $('dialog').open) return;
  if (key === 'Enter' || key === ' ') {
    const part = target.closest('[data-element]');
    const pin = target.closest('[data-pin]');
    const cross = target.closest('[data-cross],[data-junction]');
    if (part || pin || cross) {
      event.preventDefault();
      if (pin) clickPin(pin.dataset.id, pin.dataset.pin);
      else if (cross) selectStageMenu(cross, null, cross);
      else selectPart(part.dataset.element, event.shiftKey, true);
      return;
    }
    if (key === ' ' && !target.closest('button')) { event.preventDefault(); space = true; stage.classList.add('panning'); }
  }
  const mod = event.ctrlKey || event.metaKey;
  const lower = key.toLowerCase();
  let action;
  if (mod) {
    if (lower === 'a') {
      event.preventDefault(); selected = new Set(doc.elements.map(e => e.id)); changeTab('properties'); return;
    }
    action = { z: event.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', c: 'copy' }[lower];
  } else action = { s: 'select', w: 'wire', r: 'rotate', delete: 'delete', '0': 'fit' }[lower];
  if (key === 'Escape') { closeMenu(); pending = ghost = null; toolMode = 'select'; render(); }
  if (action) {
    event.preventDefault();
    try { configure(action, { dataset: {} }); } catch (err) { toast(err.message, 'error'); }
  }
});

document.addEventListener('keyup', event => { if (event.code === 'Space') { space = false; stage.classList.toggle('panning', toolMode === 'hand'); } });
narrowView.addEventListener('change', () => {
  showInspector = showLibrary = !narrowView.matches;
  render();
});
new ResizeObserver(() => renderCanvas()).observe(stage);
render();
