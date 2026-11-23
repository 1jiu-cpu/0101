export const TYPES = {
  R: { label: '电阻', prefix: 'R', unit: 'Ω', value: 1000, pins: ['p', 'n'] },
  Z: { label: '复阻抗', prefix: 'Z', unit: 'Ω', value: 10, pins: ['p', 'n'] },
  C: { label: '电容', prefix: 'C', unit: 'F', value: 1e-6, pins: ['p', 'n'], initial: 'V' },
  L: { label: '电感', prefix: 'L', unit: 'H', value: 1e-3, pins: ['p', 'n'], initial: 'A' },
  V: { label: '电压源', prefix: 'V', unit: 'V', value: 5, pins: ['p', 'n'] },
  I: { label: '电流源', prefix: 'I', unit: 'A', value: .001, pins: ['p', 'n'] },
  GND: { label: '参考地', prefix: 'GND', unit: '', value: 0, pins: ['g'] },
  E: { label: '压控电压源', prefix: 'E', unit: '', value: 2, pins: ['p', 'n', 'cp', 'cn'] },
  G: { label: '压控电流源', prefix: 'G', unit: 'S', value: .001, pins: ['p', 'n', 'cp', 'cn'] },
  F: { label: '流控电流源', prefix: 'F', unit: '', value: 2, pins: ['p', 'n'] },
  H: { label: '流控电压源', prefix: 'H', unit: 'Ω', value: 1000, pins: ['p', 'n'] },
  OP: { label: '理想运放', prefix: 'U', unit: '', value: 0, pins: ['out', 'ref', 'plus', 'minus'] },
  T: { label: '理想变压器', prefix: 'T', unit: '', value: 2, pins: ['p1', 'n1', 'p2', 'n2'] },
  V3: { label: '三相电压源', prefix: 'V3_', unit: 'V', value: 220, pins: ['A', 'B', 'C', 'N'] },
  OPEN: { label: '断路', prefix: 'O', unit: '', value: 0, pins: ['p', 'n'] },
  SHORT: { label: '短路', prefix: 'S', unit: '', value: 0, pins: ['p', 'n'] },
};

const prefixFactor = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, meg: 1e6, G: 1e9, T: 1e12 };
const unitPattern = /^(?:Ω|ohms?|欧姆?|法拉?|亨利?|伏特?|安培?|[FHVAS]|Hz|s)$/i;
const unitAliases = { ohm: 'Ω', ohms: 'Ω', 欧: 'Ω', 欧姆: 'Ω', 伏: 'V', 伏特: 'V', 安: 'A', 安培: 'A', 法: 'F', 法拉: 'F', 亨: 'H', 亨利: 'H' };

export function parseValue(input, expected = '') {
  const raw = String(input ?? '').trim().replace(/\s+/g, '').replace(/Ω/g, 'Ω').replace(/−/g, '-');
  if (!raw) throw Error('请输入数值。');
  const radical = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)?)\*?(?:√(\d+(?:\.\d+)?)|sqrt\((\d+(?:\.\d+)?)\))(.*)$/i);
  if (radical) {
    const [, factor, standard, name, unit] = radical;
    const coefficient = factor === '-' ? -1 : Number(factor || 1);
    return parseValue(String(coefficient * Math.sqrt(Number(standard ?? name))) + unit, expected);
  }
  const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(.*)$/i);
  if (!match) throw Error('请输入数字或工程单位，例如 2.2kΩ。');
  let [, number, suffix] = match;
  suffix = suffix.replace(/^(皮|纳|微|毫|千|兆|吉)/, key => ({ 皮: 'p', 纳: 'n', 微: 'u', 毫: 'm', 千: 'k', 兆: 'M', 吉: 'G' })[key]);
  let scale = 1;
  if (!unitPattern.test(suffix) || !expected || suffix.toLowerCase() !== expected.toLowerCase()) {
    const prefix = suffix.match(/^(meg|[pnuµμmkKMGT])/);
    if (prefix) {
      scale = prefixFactor[prefix[0]];
      suffix = suffix.slice(prefix[0].length);
    }
  }
  if (suffix && (!expected || !unitPattern.test(suffix) || (unitAliases[suffix.toLowerCase()] || suffix).toLowerCase() !== expected.toLowerCase())) {
    throw Error(`单位应为 ${expected || '无量纲'}。`);
  }
  const value = Number(number) * scale;
  if (!Number.isFinite(value)) throw Error('数值超出可计算范围。');
  return value;
}

export function formatValue(value, unit = '', digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return unit ? `0 ${unit}` : '0';
  if (!unit) return String(Number(value.toPrecision(digits)));
  const prefixes = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T'];
  const power = Math.max(-4, Math.min(4, Math.floor(Math.log10(Math.abs(value) * (1 + 1e-12)) / 3)));
  return `${Number((value / 10 ** (power * 3)).toPrecision(digits))} ${prefixes[power + 4]}${unit}`;
}

export const clone = value => structuredClone(value);
export const empty = (title = '未命名电路') => ({
  version: 1, title, nodes: [], elements: [], couplings: [], annotations: [], geometry: {}, history: [],
});
export const snap = v => Math.round(v / 20) * 20;
const unique = (used, base, suffix = '') => {
  let i = 1;
  while (used.includes(base + i + suffix)) i++;
  return base + i + suffix;
};

export function addNode(doc, id = unique(doc.nodes.map(n => n.id), 'n'), label = '') {
  if (!doc.nodes.some(n => n.id === id)) doc.nodes.push({ id, label: label || id, reference: id === '0' });
  return id;
}

export function addElement(doc, type, options = {}) {
  const spec = TYPES[type];
  if (!spec) throw Error('未知的元件类型。');
  const existing = doc.elements.map(e => e.id);
  const id = options.id || unique(existing, 'e');
  if (existing.includes(id)) throw Error(`元件 ID 重复：${id}`);
  const name = options.name || unique(doc.elements.map(e => e.name), spec.prefix);
  const terminals = {};
  for (const pin of spec.pins) terminals[pin] = addNode(doc, options.terminals?.[pin] ?? (type === 'GND' ? '0' : undefined));
  const { pose = {}, terminals: assigned, id: suppliedId, name: suppliedName, ...attributes } = options;
  const element = {
    id, name, type, terminals, value: spec.value, expression: '', initial: 0,
    phase: 0, ac: null, currentSign: 1, voltageSign: 1, ...(type === 'Z' ? { reactance: 0 } : {}), ...attributes,
  };
  doc.elements.push(element);
  doc.geometry[id] = { x: 300, y: 240, rotation: 0, mirror: false, locked: false, ...pose };
  return element;
}

export function members(doc, node) {
  return doc.elements.flatMap(e => Object.entries(e.terminals).filter(([, id]) => id === node).map(([pin]) => ({ id: e.id, pin })));
}

export function prune(doc) {
  const used = new Set(doc.elements.flatMap(e => Object.values(e.terminals)));
  doc.nodes = doc.nodes.filter(n => used.has(n.id));
  return doc;
}

export function mergeNodes(doc, a, b) {
  if (a === b) return a;
  const first = doc.nodes.find(n => n.id === a);
  const second = doc.nodes.find(n => n.id === b);
  if (!first || !second) throw Error('节点不存在。');
  const [keep, remove] = second.reference ? [b, a] : [a, b];
  for (const e of doc.elements) for (const pin of Object.keys(e.terminals)) {
    if (e.terminals[pin] === remove) e.terminals[pin] = keep;
  }
  prune(doc);
  return keep;
}

export function disconnect(doc, pins) {
  const node = addNode(doc);
  for (const { id, pin } of pins) {
    const component = doc.elements.find(e => e.id === id);
    if (component && Object.hasOwn(component.terminals, pin)) component.terminals[pin] = node;
  }
  prune(doc);
  return node;
}

export function removeElements(doc, ids) {
  doc.elements = doc.elements.filter(e => !ids.includes(e.id));
  doc.couplings = doc.couplings.filter(c => !ids.includes(c.a) && !ids.includes(c.b));
  for (const id of ids) delete doc.geometry[id];
  return prune(doc);
}

export function validate(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || doc.version !== 1 || typeof doc.title !== 'string' ||
      !['nodes', 'elements', 'annotations', 'couplings', 'history'].every(key => Array.isArray(doc[key])) ||
      !doc.geometry || typeof doc.geometry !== 'object') return { errors: ['无法读取此 Circuit IR 版本。'], warnings };
  const nodes = new Map();
  const identifiers = new Set();
  const safeId = id => typeof id === 'string' && /^[\w.\u4E00-\u9FFF$:\-]{1,100}$/u.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
  for (const n of doc.nodes) {
    if (!n || !safeId(n.id) || nodes.has(n.id) || typeof n.label !== 'string' || typeof n.reference !== 'boolean') errors.push('节点 ID 或属性无效。');
    else nodes.set(n.id, n);
  }
  const names = new Set();
  for (const e of doc.elements) {
    const spec = e && Object.hasOwn(TYPES, e.type) && TYPES[e.type];
    if (!spec || !safeId(e.id) || identifiers.has(e.id) || !e.name || typeof e.name !== 'string') {
      errors.push('元件 ID、名称或类型无效。');
      continue;
    }
    identifiers.add(e.id);
    if (names.has(e.name)) errors.push(`元件名称重复：${e.name}`);
    names.add(e.name);
    if (!e.terminals || Object.keys(e.terminals).length !== spec.pins.length || spec.pins.some(pin => !Object.hasOwn(e.terminals, pin) || !nodes.has(e.terminals[pin]))) errors.push(`${e.name} 的端口引用无效。`);
    if (!Number.isFinite(e.value) || !Number.isFinite(e.initial) || !Number.isFinite(e.phase) ||
        (e.ac !== null && !Number.isFinite(e.ac)) || ![1, -1].includes(e.currentSign) || ![1, -1].includes(e.voltageSign)) errors.push(`${e.name} 的参数无效。`);
    if (['R', 'L', 'C', 'T'].includes(e.type) && e.value <= 0) errors.push(`${e.name} 的参数必须大于零。`);
    if (e.type === 'Z' && !Number.isFinite(e.reactance)) errors.push(`${e.name} 的电抗无效。`);
    if (e.type === 'GND' && !nodes.get(e.terminals?.g)?.reference) errors.push(`${e.name} 必须接在参考节点上。`);
    if (['V', 'I', 'V3'].includes(e.type) && e.ac !== null && e.ac < 0) errors.push(`${e.name} 的交流幅值必须非负。`);
    const pose = doc.geometry[e.id];
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || ![0, 90, 180, 270].includes(pose.rotation)) errors.push(`${e.name} 的几何位置无效。`);
    const terminals = Object.values(e.terminals || {});
    if (spec.pins.length === 2 && terminals[0] === terminals[1]) warnings.push(`${e.name} 两端连接到同一节点。`);
  }
  const coupledPairs = new Set();
  for (const c of doc.couplings) {
    if (!c || c.a === c.b || !Number.isFinite(c.k) || Math.abs(c.k) >= 1 ||
        !['a', 'b'].every(key => doc.elements.some(e => e?.id === c[key] && e.type === 'L'))) {
      errors.push('互感必须关联两个不同电感，且 |k| < 1。');
      continue;
    }
    const key = [c.a, c.b].sort().join('/');
    if (coupledPairs.has(key)) errors.push('同一对电感只能定义一条互感。');
    coupledPairs.add(key);
  }
  for (const e of doc.elements) if (e && ['F', 'H'].includes(e.type) && !identifiers.has(e.control)) warnings.push(`${e.name} 需要指定电流控制支路。`);
  if (doc.nodes.filter(n => n?.reference).length > 1) errors.push('只能有一个参考节点。');
  if (doc.elements.length && !doc.nodes.some(n => n?.reference)) warnings.push('尚未指定参考地，求解时采用一个现有节点作为参考。');
  for (const annotation of doc.annotations) {
    if (!annotation || typeof annotation.text !== 'string' || !Number.isFinite(annotation.x) || !Number.isFinite(annotation.y)) errors.push('注释无效。');
  }
  return { errors, warnings };
}

export function assertValid(doc) {
  const { errors } = validate(doc);
  if (errors.length) throw Error(errors.join(' '));
  return doc;
}

export function referenceNode(doc) {
  return doc.nodes.find(n => n.reference)?.id || doc.nodes[0]?.id;
}

export function compareTopology(a, b, { names = false, values = true } = {}) {
  function graph(doc) {
    const labels = new Map();
    const edges = new Map();
    const vertex = (id, label) => { labels.set(id, JSON.stringify(label)); edges.set(id, []); };
    const edge = (i, j, label) => { edges.get(i).push([j, label]); edges.get(j).push([i, label]); };
    for (const n of doc.nodes) vertex('n:' + n.id, ['net', n.reference, names ? n.label : '']);
    for (const e of doc.elements) vertex('e:' + e.id, [e.type, names ? e.name : '', values ? [e.value, e.reactance, e.initial, e.phase, e.ac, e.currentSign, e.voltageSign] : []]);
    for (const e of doc.elements) {
      for (const [pin, node] of Object.entries(e.terminals)) edge('e:' + e.id, 'n:' + node, pin);
      if (['F', 'H'].includes(e.type) && labels.has('e:' + e.control)) {
        const vertexId = 'ctl:' + e.id;
        vertex(vertexId, ['currentControl']);
        edge('e:' + e.id, vertexId, 'output');
        edge(vertexId, 'e:' + e.control, 'input');
      }
    }
    for (const [i, c] of doc.couplings.entries()) {
      vertex('k:' + i, ['coupling', values ? c.k : null]);
      for (const id of [c.a, c.b]) edge('k:' + i, 'e:' + id, 'L');
    }
    return { labels, edges };
  }
  const left = graph(a);
  const right = graph(b);
  if (left.labels.size !== right.labels.size) return false;
  const groups = new Map();
  for (let i = 0; i <= left.labels.size; i++) {
    groups.clear();
    function refine({ labels, edges }) {
      return new Map([...labels].map(([key, label]) => {
        const signature = JSON.stringify([label, edges.get(key).map(([neighbor, edge]) => [edge, labels.get(neighbor)]).sort()]);
        if (!groups.has(signature)) groups.set(signature, groups.size);
        return [key, groups.get(signature)];
      }));
    }
    const oldCount = new Set([...left.labels.values(), ...right.labels.values()]).size;
    const l = refine(left);
    const r = refine(right);
    const lColors = [...l.values()].sort().join(',');
    if (lColors !== [...r.values()].sort().join(',')) return false;
    left.labels = l;
    right.labels = r;
    if (groups.size === oldCount) break;
  }
  const candidates = [...left.labels].map(([key, label]) => [key, [...right.labels].filter(([, other]) => label === other).map(([id]) => id)]);
  candidates.sort((x, y) => x[1].length - y[1].length);
  const mapping = new Map();
  const taken = new Set();
  const signature = (graph, from, to) => graph.edges.get(from).filter(([n]) => n === to).map(([, label]) => label).sort().join(',');
  function match(i) {
    if (i === candidates.length) return true;
    const [from, options] = candidates[i];
    for (const to of options) {
      if (taken.has(to) || signature(left, from, from) !== signature(right, to, to) ||
          [...mapping].some(([x, y]) => signature(left, from, x) !== signature(right, to, y))) continue;
      mapping.set(from, to);
      taken.add(to);
      if (match(i + 1)) return true;
      mapping.delete(from);
      taken.delete(to);
    }
    return false;
  }
  return match(0);
}

export function snapshot(doc) {
  const { history, ...rest } = doc;
  return clone(rest);
}
