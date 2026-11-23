import { addElement, addNode, assertValid, clone, empty, formatValue, members, mergeNodes, prune, removeElements, snapshot } from './model.js';
import { linearSolve, thevenin } from './analysis.js';
import { autoLayout } from './layout.js';

const ends = e => [e.terminals.p, e.terminals.n];
const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const parallel = (a, b) => a * b / (a + b);
const movable = (doc, e) => !doc.elements.some(x => x.control === e.id) && !doc.couplings.some(c => c.a === e.id || c.b === e.id);
const generic = (doc, node) => doc.nodes.some(n => n.id === node && !n.reference && n.id === n.label && /^n\d+$/.test(n.label));
const external = (doc, node, ids) => doc.nodes.find(n => n.id === node)?.reference || members(doc, node).some(p => !ids.includes(p.id));

function candidate(rule, title, elements, ports, condition, formula, relationship, build) {
  return { rule, title, ids: elements.map(e => e.id), names: elements.map(e => e.name), ports, condition, formula, relationship, build };
}

function equivalentValue(a, b, rule) {
  if (a.type === 'C') return rule === 'series' ? parallel(a.value, b.value) : a.value + b.value;
  return rule === 'series' ? a.value + b.value : parallel(a.value, b.value);
}

function networkConductance(elements, ports) {
  const nodes = [...new Set(elements.flatMap(ends))];
  const inner = nodes.filter(n => !ports.includes(n));
  return ports.map((_, i) => {
    const voltages = new Map(ports.map((n, j) => [n, Number(i === j)]));
    const coefficients = (node, other) => elements.reduce((sum, e) => {
      const pair = ends(e);
      if (!pair.includes(node) || pair[0] === pair[1]) return sum;
      if (node === other) return sum + 1 / e.value;
      return pair.includes(other) ? sum - 1 / e.value : sum;
    }, 0);
    const solution = linearSolve(inner.map(a => inner.map(b => coefficients(a, b))), inner.map(n => -coefficients(n, ports[i])));
    inner.forEach((n, j) => voltages.set(n, solution[j]));
    return ports.map(n => nodes.reduce((sum, m) => sum + coefficients(n, m) * voltages.get(m), 0));
  });
}

function localEquivalent(elements, ports) {
  const local = empty();
  for (const e of elements) addElement(local, e.type, { ...e, terminals: { ...e.terminals } });
  const ref = local.nodes.find(n => n.id === ports[1]);
  for (const n of local.nodes) n.reference = n === ref;
  return thevenin(local, ...ports);
}

function checkStep(before, after, option, created) {
  const old = before.elements.filter(e => option.ids.includes(e.id));
  const current = after.elements.filter(e => created.includes(e.id));
  if (['open', 'short'].includes(option.rule)) return { label: option.rule === 'open' ? '开路支路 i = 0' : '理想短路 u = 0', residual: 0 };
  if (old.every(e => e.type === 'R') && current.every(e => e.type === 'R')) {
    const y = networkConductance(old, option.ports);
    const z = networkConductance(current, option.ports);
    const residual = Math.max(...y.flatMap((row, i) => row.map((v, j) => Math.abs(v - z[i][j]))));
    const scale = Math.max(...y.flat().map(Math.abs), Number.MIN_VALUE);
    if (residual > scale * 1e-9) throw Error('端口导纳验证失败。');
    return { label: '端口导纳矩阵一致', residual };
  }
  if (option.rule === 'sourceTransform') {
    const x = localEquivalent(old, option.ports);
    const y = localEquivalent(current, option.ports);
    const residual = Math.max(Math.abs(x.voltage - y.voltage) / Math.max(1, Math.abs(x.voltage)), Math.abs(x.resistance - y.resistance) / Math.abs(x.resistance));
    if (residual > 1e-9) throw Error('开路电压或测试电阻验证失败。');
    return { label: '开路电压与测试电阻一致', residual };
  }
  if (['sourceParallel', 'sourceSeries'].includes(option.rule)) {
    const sourceSum = (elements, mode) => {
      let re = 0;
      let im = 0;
      let dc = 0;
      for (const e of elements) {
        const sign = mode(e);
        const angle = e.phase * Math.PI / 180;
        dc += sign * e.value;
        re += sign * (e.ac ?? e.value) * Math.cos(angle);
        im += sign * (e.ac ?? e.value) * Math.sin(angle);
      }
      return [dc, re, im];
    };
    const { ports } = option;
    const x = option.rule === 'sourceParallel' ? sourceSum(old, e => e.terminals.p === ports[0] ? 1 : -1)
      : sourceSum(old, e => e.terminals.p === ports[0] || e.terminals.n === ports[1] ? 1 : -1);
    const y = sourceSum(current, () => 1);
    const residual = Math.max(...x.map((v, i) => Math.abs(v - y[i]) / Math.max(1, Math.abs(v))));
    if (residual > 1e-9) throw Error('电源代数和验证失败。');
    return { label: '验证了直流值和相量电源约束', residual };
  }
  const type = old[0].type;
  const impedance = (e, omega) => e.type === 'L' ? omega * e.value : -1 / (omega * e.value);
  const residual = Math.max(...[10, 1000, 100000].map(omega => {
    const [a, b] = old.map(e => impedance(e, omega));
    const expect = option.rule === 'series' ? a + b : parallel(a, b);
    return Math.abs(expect - impedance(current[0], omega)) / Math.max(1, Math.abs(expect));
  }));
  if (!['L', 'C'].includes(type) || residual > 1e-9) throw Error('阻抗检查失败。');
  return { label: '三处角频率下的端口复阻抗一致', residual };
}

function summedSource(a, b, aSign, bSign) {
  const x = (a.ac ?? a.value) * aSign;
  const y = (b.ac ?? b.value) * bSign;
  const f = a.phase * Math.PI / 180;
  const g = b.phase * Math.PI / 180;
  const re = x * Math.cos(f) + y * Math.cos(g);
  const im = x * Math.sin(f) + y * Math.sin(g);
  return { value: aSign * a.value + bSign * b.value, ac: Math.hypot(re, im), phase: Math.atan2(im, re) * 180 / Math.PI };
}

export function recommendations(doc, selected = []) {
  if (!doc.elements.length) return [];
  const list = doc.elements.filter(e => e.terminals.p !== undefined && movable(doc, e));
  const result = [];
  const append = item => {
    if (!selected.length || (selected.length === 1 ? item.ids.includes(selected[0]) : selected.every(id => item.ids.includes(id)))) result.push(item);
  };
  function replacement(m, e, type, ports, attributes) {
    const pose = m.geometry[e.id];
    return addElement(m, type, { ...attributes, terminals: { p: ports[0], n: ports[1] }, pose: { ...pose, locked: false } });
  }
  for (const [i, a] of list.entries()) {
    const u = ends(a);
    if (a.type === 'OPEN' && u.every(n => external(doc, n, [a.id]))) append(candidate('open', '去除开路支路', [a], u, '两侧节点均仍由其他支路保留。', 'i = 0', '保留外部节点。', () => []));
    if (a.type === 'SHORT' && u.every(n => external(doc, n, [a.id])) && u[0] !== u[1] &&
        !doc.elements.some(e => ['V', 'T', 'V3', 'OP', 'E', 'H'].includes(e.type) && u.every(n => Object.values(e.terminals).includes(n)))) {
      append(candidate('short', '合并理想短路节点', [a], u, '该理想短路不受控也不充当电流探针。', 'u = 0', '节点合并后不再显示原导线电流。', m => { mergeNodes(m, ...u); return []; }));
    }
    for (const b of list.slice(i + 1)) {
      const v = ends(b);
      if (u[0] === u[1] || v[0] === v[1]) continue;
      const identical = same(u, v);
      const common = u.find(n => v.includes(n));
      const series = !identical && common !== undefined && members(doc, common).length === 2 && generic(doc, common);
      const ports = identical ? u : [u.find(n => n !== common), v.find(n => n !== common)];
      if (a.type === b.type && ['R', 'C', 'L'].includes(a.type) && !a.initial && !b.initial && (identical || series)) {
        const rule = identical ? 'parallel' : 'series';
        const value = equivalentValue(a, b, rule);
        const kind = rule === 'series' ? '串联' : '并联';
        const sum = rule === 'series' ? a.type !== 'C' : a.type === 'C';
        const formula = sum ? `${a.name} + ${b.name}` : `1 / (1/${a.name} + 1/${b.name})`;
        append(candidate(rule, `${a.type} 元件${kind}合并`, [a, b], ports, identical ? '两端分别连接到同一对节点。' : '共享节点只有两个端口，且不是命名测量点或参考地。',
          `${a.type}eq = ${formula} = ${formatValue(value, { R: 'Ω', C: 'F', L: 'H' }[a.type])}`, '保留外部两端口伏安关系。',
          m => [replacement(m, a, a.type, ports, { value })]));
      }
      if (a.type === 'I' && b.type === 'I' && identical || a.type === 'V' && b.type === 'V' && series) {
        const aSign = a.terminals.p === ports[0] ? 1 : -1;
        const bSign = (identical ? b.terminals.p === ports[0] : b.terminals.n === ports[1]) ? 1 : -1;
        append(candidate(identical ? 'sourceParallel' : 'sourceSeries', identical ? '并联电流源合并' : '串联电压源合并', [a, b], ports,
          identical ? '两独立电流源接于相同节点。' : '中间节点不连接其他元件。',
          `${aSign === 1 ? '' : '−'}${a.name} ${bSign === 1 ? '+' : '−'} ${b.name}`, '保留直流与相量端口行为。',
          m => [replacement(m, a, a.type, ports, summedSource(a, b, aSign, bSign))]));
      }
      const supply = [a, b].find(e => ['V', 'I'].includes(e.type));
      const resistor = [a, b].find(e => e.type === 'R');
      if (supply && resistor && (supply.type === 'V' && series || supply.type === 'I' && identical)) {
        const toCurrent = supply.type === 'V';
        const bridge = toCurrent ? [ends(supply).find(n => n !== common), ends(resistor).find(n => n !== common)] : ends(supply);
        const sign = toCurrent ? supply.terminals.p === bridge[0] ? -1 : 1 : -1;
        const multiplier = toCurrent ? 1 / resistor.value : resistor.value;
        append(candidate('sourceTransform', toCurrent ? '电压源转诺顿形式' : '电流源转戴维南形式', [a, b], bridge,
          toCurrent ? '独立电压源与电阻串联，中间节点无分支。' : '独立电流源与电阻并联。', toCurrent ? 'Iₙ = Vₛ / R，Rₙ = R' : 'Vₜₕ = IₛR，Rₜₕ = R',
          '保留开路电压及端口驱动点电阻。', m => {
            const data = { value: Math.abs(multiplier) * supply.value * sign };
            if (supply.ac !== null || supply.value < 0) data.ac = multiplier * (supply.ac ?? Math.abs(supply.value));
            data.phase = supply.phase + (sign < 0 && data.ac !== undefined ? 180 : 0);
            return toCurrent ? [
              replacement(m, supply, 'I', bridge, data), replacement(m, resistor, 'R', bridge, { value: resistor.value }),
            ] : (() => {
              const intermediate = addNode(m);
              return [replacement(m, supply, 'V', [bridge[0], intermediate], data), replacement(m, resistor, 'R', [intermediate, bridge[1]], { value: resistor.value })];
            })();
          }));
      }
    }
  }
  const resistors = list.filter(e => e.type === 'R');
  for (const n of doc.nodes) {
    const star = resistors.filter(e => ends(e).includes(n.id));
    const ports = star.map(e => ends(e).find(x => x !== n.id));
    if (star.length !== 3 || !generic(doc, n.id) || members(doc, n.id).length !== 3 || new Set(ports).size !== 3) continue;
    append(candidate('starDelta', '星形转三角形', star, ports, '三个电阻共享内部节点，外部三个端口独立。', 'Rᵢⱼ = Rᵢ + Rⱼ + RᵢRⱼ/Rₖ',
      '保留三个端口的导纳矩阵。', m => [0, 1, 2].map(i => {
        const j = (i + 1) % 3;
        const k = (i + 2) % 3;
        const a = star[i].value;
        const b = star[j].value;
        return replacement(m, star[i], 'R', [ports[i], ports[j]], { value: a + b + a * b / star[k].value });
      })));
  }
  if (selected.length >= 2) {
    for (const [i, a] of resistors.entries()) for (const [j, b] of resistors.slice(i + 1).entries()) {
      const shared = ends(a).find(n => ends(b).includes(n));
      if (!shared) continue;
      const p = ends(a).find(n => n !== shared);
      const q = ends(b).find(n => n !== shared);
      if (!p || !q || p === q) continue;
      const c = resistors.slice(i + j + 2).find(e => same(ends(e), [p, q]));
      if (!c) continue;
      const group = [a, b, c];
      append(candidate('deltaStar', '三角形转星形', group, [shared, p, q], '三个电阻分跨三对不同端口。', 'Rᵢ = RᵢⱼRᵢₖ / (Rᵢⱼ + Rⱼₖ + Rₖᵢ)', '保留三个端口的导纳矩阵。', m => {
        const center = addNode(m);
        const total = group.reduce((sum, e) => sum + e.value, 0);
        return [shared, p, q].map((node, k) => replacement(m, group[k], 'R', [node, center], {
          value: group.filter(e => ends(e).includes(node)).reduce((product, e) => product * e.value, 1) / total,
        }));
      }));
    }
  }
  return result;
}

export function applyReduction(doc, item) {
  assertValid(doc);
  const next = clone(doc);
  const added = item.build(next).map(e => e.id);
  removeElements(next, item.ids);
  assertValid(prune(next));
  const verification = checkStep(doc, next, item, added);
  const model = autoLayout(next).model;
  const { title, rule, condition, formula, relationship, names, ports } = item;
  const step = { title, rule, condition, formula, relationship, names, ports, verification, before: snapshot(doc), after: snapshot(model) };
  model.history.push(step);
  return { model, step };
}

export function reduceAll(doc, selected = []) {
  let model = doc;
  for (let i = 0; i < 30; i++) {
    const option = recommendations(model, i === 0 ? selected : []).find(r => !['sourceTransform', 'deltaStar'].includes(r.rule));
    if (!option) break;
    model = applyReduction(model, option).model;
  }
  return model;
}
