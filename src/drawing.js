import { formatValue, snapshot, TYPES } from './model.js';
import { route } from './layout.js';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const lead = '<path d="M-50 0H-24M24 0H50"/>';
const signs = (rotation = 0) => `<path d="M-16 0h10m-5-5v10"/><path d="M7 0h9" transform="rotate(${-rotation} 11.5 0)"/>`;
const currentSource = '<path d="M-13 0H13m-5-5 5 5-5 5"/>';
const paths = {
  R: '<path d="M-50 0h21l5-9 8 18 8-18 8 18 8-18 8 18 8-18 5 9h21"/>',
  Z: '<path d="M-50 0h24m52 0h24"/><rect x="-26" y="-11" width="52" height="22" rx="1"/>',
  C: '<path d="M-50 0h43m14 0h43M-7-19v38M7-19v38"/>',
  L: '<path d="M-50 0h22a7 10 0 0 1 14 0A7 10 0 0 1 0 0a7 10 0 0 1 14 0 7 10 0 0 1 14 0h22"/>',
  V: lead + '<circle cx="0" cy="0" r="24"/>',
  I: lead + '<circle cx="0" cy="0" r="24"/>' + currentSource,
  GND: '<path d="M0-28V-1M-13 0h26M-8 6h16M-3 12h6"/>',
  E: lead + '<path d="M-24 0 0-23 24 0 0 23Z M-22 32V21M22 32V21"/>',
  G: lead + '<path d="M-24 0 0-23 24 0 0 23Z M-22 32V21M22 32V21"/>' + currentSource,
  F: lead + '<path d="M-24 0 0-23 24 0 0 23Z"/>' + currentSource,
  H: lead + '<path d="M-24 0 0-23 24 0 0 23Z"/>',
  SHORT: '<path d="M-50 0h100"/>',
  OPEN: '<path d="M-50 0h32m36 0h32"/><circle cx="-14" cy="0" r="4"/><circle cx="14" cy="0" r="4"/><path d="M-10-2 10-15"/>',
  OP: '<path d="M-50-15h24m-24 30h24M-26-30v60L33 0zm59 30h17M0 34V17M-20-15h10m-5-5v10M-20 15h10"/>',
  T: '<path d="M-50-27h29c13 0 13 13 0 13 13 0 13 14 0 14 13 0 13 14 0 14 13 0 13 13 0 13h-29 M50-27H21c-13 0-13 13 0 13-13 0-13 14 0 14-13 0-13 14 0 14-13 0-13 13 0 13h29 M-4-29v58M4-29v58"/><circle cx="-27" cy="-19" r="2.5" fill="currentColor"/><circle cx="27" cy="-19" r="2.5" fill="currentColor"/>',
  V3: '<rect x="-32" y="-36" width="64" height="72" rx="8"/><path d="M-50 0h18M32-26h18M32 0h18M32 26h18M-20-18q5-8 10 0t10 0M-20 0q5-8 10 0t10 0M-20 18q5-8 10 0t10 0M9-14l4-8 4 8m-7-2h6M9-4h5q5 2 0 4 5 2 0 4H9Zm8 19q-9-5-9 3t9 3"/>',
};

export function symbol(type) { return (paths[type] || '') + (['V', 'E', 'H'].includes(type) ? signs() : ''); }

function line(a, b, attrs = '') { return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${attrs}/>`; }
const fmt = number => Number(number.toFixed(2));

function wireMarkup(r, interactive) {
  const breaks = new Map();
  for (const cross of r.hops) {
    const s = r.wires[cross.over];
    const t = r.wires[cross.under];
    const pos = s.h ? cross.x : cross.y;
    const other = t.h ? cross.x : cross.y;
    const lo = s.h ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y);
    const hi = s.h ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y);
    const edge = [t.a, t.b].some(p => (t.h ? p.x : p.y) === other);
    if (!edge && pos - lo >= 8 && hi - pos >= 8) {
      const list = breaks.get(cross.over) || [];
      if (!list.some(x => Math.abs(x - pos) < 17)) { list.push(pos); breaks.set(cross.over, list); }
    }
  }
  const wires = r.wires.map((s, idx) => {
    const points = breaks.get(idx);
    if (!points?.length) return line(s.a, s.b, `data-net="${esc(s.node)}"`);
    const lo = s.h ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y);
    const hi = s.h ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y);
    const coords = x => s.h ? `${x} ${s.a.y}` : `${s.a.x} ${x}`;
    const path = points.sort((a, b) => a - b).reduce((path, p) => path + ` L${coords(p - 7)} Q${s.h ? `${p} ${s.a.y - 14}` : `${s.a.x + 14} ${p}`} ${coords(p + 7)}`, `M${coords(lo)}`);
    return `<path data-net="${esc(s.node)}" d="${path} L${coords(hi)}"/>`;
  });
  const wireTargets = interactive ? r.wires.map(s => line(s.a, s.b, `class="wire-target" data-wire="${esc(s.node)}"`)).join('') : '';
  const crossTargets = interactive ? r.hops.map((h, i) => `<circle cx="${h.x}" cy="${h.y}" r="12" class="cross-target" data-cross="${i}" tabindex="0" role="button" aria-label="导线交叉点"><title>交叉不连接 · 打开操作菜单</title></circle>`).join('') : '';
  return `<g class="wires" stroke="currentColor" fill="none" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${wires.join('')}</g>${wireTargets}
    <g fill="currentColor">${r.junctions.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="3.8"/>${interactive ? `<circle cx="${p.x}" cy="${p.y}" r="10" class="cross-target" data-junction="${i}" tabindex="0" role="button" aria-label="连接点"><title>连接点 · 打开操作菜单</title></circle>` : ''}`).join('')}</g>${crossTargets}`;
}

function references(e) {
  if (!e.showReferences && e.currentSign === 1 && e.voltageSign === 1) return '';
  const s = e.currentSign;
  return `<g stroke-width="1.5" class="reference-marks"><path d="M${-22*s} 27H${22*s}m${-6*s}-4 ${6*s} 4 ${-6*s} 4
     M${-39*e.voltageSign - 4}-12h8m-4-4v8M${39*e.voltageSign - 4}-12h8"/></g>`;
}

export function scene(doc, drawing = route(doc), options = {}) {
  const { interactive = false, selection = new Set(), pending, uncertain = new Set(), labels = true } = options;
  const shapes = doc.elements.map(e => {
    const { x, y, rotation, mirror } = doc.geometry[e.id];
    const klass = selection.has(e.id) ? ' selected' : uncertain.has(e.id) ? ' uncertain' : '';
    return `<g class="element${klass}" ${interactive ? `data-element="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(e.name)} ${TYPES[e.type].label}"` : ''}
      transform="translate(${x} ${y}) rotate(${rotation}) scale(${mirror ? -1 : 1} 1)">
      ${interactive ? `<rect class="element-hit" x="-43" y="${e.type === 'GND' ? -26 : -33}" width="86" height="${e.type === 'GND' ? 48 : 66}" rx="9"/>` : ''}
      <g stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths[e.type]}${['V', 'E', 'H'].includes(e.type) ? signs(rotation) : ''}${references(e)}</g>
    </g>`;
  }).join('');
  const names = doc.elements.map(e => {
    const p = drawing.positions[e.id];
    if (!p) return '';
    const electricalUnit = TYPES[e.type].unit;
    const ac = ['V', 'I'].includes(e.type) && !e.value && e.ac !== null;
    const suffix = ['OP', 'OPEN', 'SHORT'].includes(e.type) ? '' : e.type === 'Z' ?
      `${formatValue(e.value, '')} ${e.reactance < 0 ? '−' : '+'} j${formatValue(Math.abs(e.reactance), '')} Ω`
      : ac ? `${formatValue(e.ac, electricalUnit)} ∠ ${Number(e.phase.toPrecision(4))}°`
      : formatValue(e.value, electricalUnit);
    const nodeLabel = id => doc.nodes.find(n => n.id === id)?.label ?? id;
    const currentControl = ['F', 'H'].includes(e.type) ? doc.elements.find(c => c.id === e.control)?.name : '';
    const control = ['E', 'G'].includes(e.type) ? `v(${nodeLabel(e.terminals.cp)}, ${nodeLabel(e.terminals.cn)})` : currentControl ? `i(${currentControl})` : '';
    const details = control ? `${suffix} · ${control}` : suffix;
    return `<text class="part-label${selection.has(e.id) ? ' label-selected' : ''}" ${interactive ? `data-element="${esc(e.id)}"` : ''} x="${p.x}" y="${p.y}" text-anchor="${p.align}">
      <tspan font-weight="700">${esc(e.name)}</tspan>${details ? `<tspan class="part-value" x="${p.x}" dy="21" font-size="15">${esc(details)}</tspan>` : ''}</text>`;
  }).join('');
  const pins = drawing.pins.map(p => {
    const connected = drawing.wires.some(w => w.node === p.node);
    const active = pending?.id === p.id && pending.pin === p.pin;
    const show = active || !connected;
    const dot = show ? `<circle class="pin-dot${active ? ' pending' : ''}" cx="${p.x}" cy="${p.y}" r="${active ? 5 : 3.1}" fill="#fcfbf8" stroke="currentColor" stroke-width="1.6"/>` : '';
    return dot + (interactive ? `<circle class="pin-target" cx="${p.x}" cy="${p.y}" r="12" data-pin="${esc(p.pin)}" data-id="${esc(p.id)}" tabindex="0" role="button" aria-label="端口 ${esc(p.pin)}"><title>端口 ${esc(p.pin)} · ${esc(p.node)}</title></circle>` : '');
  }).join('');
  const coupling = doc.couplings.map(c => {
    const a = doc.geometry[c.a];
    const b = doc.geometry[c.b];
    const pos = e => {
      const theta = e.rotation * Math.PI / 180;
      const x = e.mirror ? 22 : -22;
      return { x: e.x + Math.cos(theta) * x + Math.sin(theta) * 14, y: e.y + Math.sin(theta) * x - Math.cos(theta) * 14 };
    };
    const p = pos(a);
    const q = pos(b);
    return `<g class="coupling" stroke="currentColor" stroke-width="1.2" fill="currentColor">${line(p, q, 'stroke-dasharray="4 5"')}<circle cx="${p.x}" cy="${p.y}" r="2.8"/><circle cx="${q.x}" cy="${q.y}" r="2.8"/>
      <text x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2 - 8}" font-size="13" stroke="none">k = ${fmt(c.k)}</text></g>`;
  }).join('');
  const nodeLabels = drawing.nodeLabels.map(p => `<text class="node-label" x="${p.x + 11}" y="${p.y - 14}" font-weight="600" font-size="15">${esc(p.label)}</text>`).join('');
  return `<g color="#302c28" fill="currentColor" font-family="Consolas, monospace" font-size="16">
    ${wireMarkup(drawing, interactive)}${shapes}${labels ? names + nodeLabels : ''}${coupling}${pins}
    ${doc.annotations.map(a => `<text class="annotation" x="${a.x}" y="${a.y}" font-size="14">${esc(a.text)}</text>`).join('')}
  </g>`;
}

export function exportSvg(doc, { embedModel = true } = {}) {
  const drawing = route(doc);
  const { x, y, right, bottom } = drawing.bounds;
  const width = right - x + 64;
  const height = bottom - y + 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="${x - 32} ${y - 32} ${width} ${height}" width="${width}" height="${height}">
    <title>${esc(doc.title)}</title>${embedModel ? `<metadata id="circuitlab-ir">${esc(JSON.stringify({ ...snapshot(doc), history: [] }))}</metadata>` : ''}
    <style>.part-value{fill:#6e665b}.node-label,.reference-marks,.coupling{color:#9b4c37;fill:#9b4c37}</style>
    <rect x="${x - 32}" y="${y - 32}" width="${width}" height="${height}" fill="#fff"/>${scene(doc, drawing)}
  </svg>`;
}
