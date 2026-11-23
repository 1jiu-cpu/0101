import { esc, symbol } from './drawing.js';
import { TYPES, formatValue } from './model.js';

const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>', file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12m-5-5 5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z M7 3v6h9V3M7 21v-8h10v8"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>', right: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>', circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  cursor: '<path d="m5 3 4 17 3.7-6.3L20 11 5 3Z"/>',
  wire: '<path d="M5 8v8h14"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="16" r="2"/>',
  hand: '<path d="M8 12V5a1.6 1.6 0 0 1 3.2 0v5-7a1.6 1.6 0 0 1 3.2 0v7-5a1.6 1.6 0 0 1 3.2 0v6-3a1.6 1.6 0 0 1 3.2 0v7a6 6 0 0 1-6 6h-2a5 5 0 0 1-4-2l-5-6a1.7 1.7 0 0 1 2.6-2l1.6 2Z"/>',
  undo: '<path d="M9 6 4 11l5 5m-5-5h11a4 4 0 0 1 0 8h-3"/>', redo: '<path d="m15 6 5 5-5 5m5-5H9a4 4 0 0 0 0 8h3"/>',
  align: '<path d="M4 4v16M20 4v16M4 7h6m4 0h6M4 17h6m4 0h6"/><rect x="9" y="4" width="6" height="6" rx="1"/><rect x="9" y="14" width="6" height="6" rx="1"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18m6-18v18"/>',
  minus: '<path d="M5 12h14"/>', fit: '<path d="M3 9V4a1 1 0 0 1 1-1h5m6 0h5a1 1 0 0 1 1 1v5m0 6v5a1 1 0 0 1-1 1h-5m-6 0H4a1 1 0 0 1-1-1v-5"/>',
  nodes: '<path d="M7 12h10m-5 0V6m0 6v6"/><circle cx="4" cy="12" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="20" r="2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m3 17 5-5 3 3 4-5 6 7"/>',
  text: '<path d="M4 7V4h16v3M12 4v16m-4 0h8"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01m4 0h.01m4 0h.01m4 0h.01M6 13h.01m4 0h.01m4 0h.01m4 0h.01M8 16h8"/>',
  settings: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--panel,#fff)"/><circle cx="15" cy="12" r="2" fill="var(--panel,#fff)"/><circle cx="10" cy="17" r="2" fill="var(--panel,#fff)"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  resistor: '<path d="M2 12h4l2-4 3 8 3-8 2 4h6"/>',
  capacitor: '<path d="M2 12h7m6 0h7M9 6v12m6-12v12"/>',
  inductor: '<path d="M2 13h3a2.4 3.4 0 0 1 4.8 0 2.4 3.4 0 0 1 4.8 0 2.4 3.4 0 0 1 4.8 0H22"/>',
  voltage: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3m0 14v3m-2-13h4m-2-2v4m-2 4h4"/>',
  current: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3m0 14v3M12 16V8l-2 2m2-2 2 2"/>',
  ground: '<path d="M12 3v10M5 13h14M8 17h8m-6 4h4"/>',
  opamp: '<path d="M7 5v14l11-7-11-7ZM2 8h5m-5 8h5m11-4h4"/>',
  ac: '<path d="M2 12h3c2-14 6 14 9 0s5 0 5 0h3"/>',
  dependent: '<path d="M2 12h3l7-7 7 7  -7 7-7-7m14 0h3M12 9v6m-3-3h6"/>',
  warning: '<path d="M10.2 4 2.7 17a1.5 1.5 0 0 0 1.3 2.3h16a1.5 1.5 0 0 0 1.3-2.3L13.8 4a2 2 0 0 0-3.6 0ZM12 9v4m0 3h.01"/>',
  rotate: '<path d="M4 11a8 8 0 1 1 2 6m-2-6V5m0 6h6"/>',
  mirror: '<path d="M12 3v18M8 6l-5 4v4l5 4V6Zm8 0 5 4v4l-5 4V6Z"/>',
  trash: '<path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3m-5 4v5m4-5v5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  split: '<path d="M4 12h5m2-2 6-6h3m-9 10 6 6h3"/><circle cx="9" cy="12" r="2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  menu: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chart: '<path d="M3 3v18h18M6 15l4-5 4 2 6-7"/>',
  pin: '<path d="M12 21s6-5 6-11a6 6 0 1 0-12 0c0 6 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/>',
};
export const icon = (key, size = 18) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${icons[key] || icons.file}</svg>`;
export const typeIcons = { R: 'resistor', Z: 'ac', C: 'capacitor', L: 'inductor', V: 'voltage', I: 'current', GND: 'ground', OP: 'opamp', V3: 'ac', E: 'dependent', G: 'dependent', H: 'dependent', F: 'dependent', T: 'inductor', OPEN: 'split', SHORT: 'wire' };
export const partIcon = (type, size = 22) => icon(typeIcons[type], size);

export const button = (action, text, iconName, classes = '', additional = '') => `<button type="button" class="button ${classes}" data-action="${action}" ${additional}>${iconName ? icon(iconName) : ''}${text ? `<span>${text}</span>` : ''}</button>`;
export const tool = (action, title, iconName, classes = '', additional = '') => `<button type="button" class="tool ${classes}" data-action="${action}" title="${title}" aria-label="${title}" ${additional}>${icon(iconName, 18)}</button>`;
export const menuItem = (action, title, iconName, suffix = '', additional = '') => `<button type="button" role="menuitem" class="menu-item" data-action="${action}" ${additional}>${iconName ? icon(iconName, 17) : ''}<span>${title}</span>${suffix ? `<kbd>${suffix}</kbd>` : ''}</button>`;

export function selectOptions(options, chosen) {
  return options.map(([value, title]) => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(title)}</option>`).join('');
}

export function miniDiagram(type, label = '') {
  return `<svg aria-hidden="true" width="22" height="22" viewBox="-60 -60 120 120" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><title>${esc(label)}</title>${symbol(type)}</svg>`;
}

export const compact = n => Number.isFinite(n) ? Number(n.toPrecision(5)).toString() : '—';
export const rectangular = c => `${compact(c.re)} ${c.im < 0 ? '−' : '+'} j${compact(Math.abs(c.im))}`;
export const polar = (c, unit) => `${formatValue(c.magnitude, unit)} ∠ ${compact(c.angle)}°`;
export const note = (content, kind = 'neutral') => `<div class="note ${kind}">${icon(kind === 'warning' ? 'warning' : 'circleCheck', 17)}<span>${content}</span></div>`;
export const table = (headers, data) => `<div class="table-wrap"><table><thead><tr>${headers.map(x => `<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${data.map(row => `<tr>${row.map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
export const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
export const input = (key, value, placeholder = '', extra = '') => `<input data-field="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${extra}>`;
export const select = (key, options, chosen) => `<select data-field="${key}">${selectOptions(options, chosen)}</select>`;
export const componentValue = e => ['GND', 'OP', 'OPEN', 'SHORT'].includes(e.type) ? '—' :
  e.type === 'Z' ? `${compact(e.value)} ${e.reactance < 0 ? '−' : '+'} j${compact(Math.abs(e.reactance))} Ω` : formatValue(e.value, TYPES[e.type].unit);

export function plot(samples, { xmin, xmax, label = '', unit = '', log = false, key = 'y', color = '#a4563f', labelX = 't · s' } = {}) {
  if (!samples.length) return '';
  const W = 286, H = 156, L = 43, R = 12, T = 15, B = 27;
  const transform = log ? Math.log10 : v => v;
  const left = transform(xmin ?? samples[0].x);
  const right = transform(xmax ?? samples.at(-1).x);
  const min = Math.min(...samples.map(p => p[key]));
  const max = Math.max(...samples.map(p => p[key]));
  const pad = (max - min) * .1 || Math.max(.1, Math.abs(max) * .1);
  const low = min - pad;
  const high = max + pad;
  const x = v => L + (W - L - R) * (transform(v) - left) / (right - left || 1);
  const y = v => H - B - (H - T - B) * (v - low) / (high - low);
  const coords = samples.map(p => [x(p.x), y(p[key])]);
  const points = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const guide = [0, 1, 2, 3, 4].map(i => {
    const yy = T + (H - T - B) * i / 4;
    const xx = L + (W - L - R) * i / 4;
    const raw = left + (right - left) * i / 4;
    return `<path d="M${L} ${yy}H${W - R} M${xx} ${T}V${H - B}" stroke="#e6e0d6" fill="none"/>
      <text x="${L - 5}" y="${yy + 3}" text-anchor="end">${esc(Number((high - (high - low) * i / 4).toPrecision(3)))}</text>
      <text x="${xx}" y="${H - 12}" text-anchor="middle">${esc(log ? formatValue(10 ** raw, 'Hz', 2).replace('Hz', '') : Number(raw.toPrecision(2)))}</text>`;
  }).join('');
  return `<svg class="plot" role="img" aria-label="${esc(label)}" viewBox="0 0 ${W} ${H}"><title>${esc(label)}</title><g font-family="Consolas, monospace" font-size="9" fill="#766d61">${guide}
    <text x="4" y="10">${esc(unit)}</text><text x="${W - R}" y="${H - 1}" text-anchor="end">${esc(labelX)}</text></g>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${coords.filter((_, i) => i % Math.max(1, Math.floor(coords.length / 16)) === 0).map(([a, b]) => {
      const i = coords.findIndex(p => p[0] === a);
      return `<circle cx="${a}" cy="${b}" r="6" fill="transparent"><title>${esc(formatValue(samples[i].x, log ? 'Hz' : 's'))} · ${esc(compact(samples[i][key]))} ${esc(unit)}</title></circle>`;
    }).join('')}</svg>`;
}
