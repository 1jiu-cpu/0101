import { addElement, addNode, assertValid, clone, compareTopology, formatValue, members, mergeNodes, prune, removeElements, snapshot } from './model.js';
import { pinLocations, preserveLayout } from './layout.js';
import { circuitFingerprint, findBridges, findDeltas, findWyes } from './topology.js';
import { verifyEquivalence } from './verify.js';

const ends = e => [e.terminals.p, e.terminals.n];
const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const parallelReal = (a, b) => (a * b) / (a + b);
const movable = (doc, e) => !doc.elements.some(x => x.control === e.id) && !doc.couplings.some(c => c.a === e.id || c.b === e.id);
const isGenericNode = (doc, node) => doc.nodes.some(n => n.id === node && !n.reference && n.id === n.label && /^n\d+$/.test(n.label));
const external = (doc, node, ids) => doc.nodes.find(n => n.id === node)?.reference || members(doc, node).some(p => !ids.includes(p.id));

const cAdd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const cMul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cAbs = a => Math.hypot(a.re, a.im);
const cDiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  if (d < 1e-24) return null;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const zOf = e => ({ re: e.value, im: e.reactance || 0 });
const fmtNum = n => (Number.isFinite(n) ? Number(n.toPrecision(4)).toString() : '—');
const fmtZ = z => `${fmtNum(z.re)} ${z.im < 0 ? '−' : '+'} j${fmtNum(Math.abs(z.im))} Ω`;
const unitOf = type => ({ R: 'Ω', Z: 'Ω', C: 'F', L: 'H', V: 'V', I: 'A' }[type] || '');
const typeLabel = type => ({ R: '电阻', Z: '复阻抗', C: '电容', L: '电感', V: '电压源', I: '电流源' }[type] || type);

function fmtElementVal(e) {
  if (e.type === 'Z') return fmtZ(zOf(e));
  return formatValue(e.value, unitOf(e.type));
}

function canEliminateNode(doc, nodeId, { preserveNodes = [], preserveNamed = false } = {}) {
  const node = doc.nodes.find(n => n.id === nodeId);
  if (!node || node.reference) return false;
  if (preserveNodes.includes(nodeId)) return false;
  if (preserveNamed && !isGenericNode(doc, nodeId)) return false;
  return true;
}

function candidate(rule, title, elements, ports, condition, formula, relationship, build, extra = {}) {
  return {
    rule,
    title,
    ids: elements.map(e => e.id),
    names: elements.map(e => e.name),
    ports: [...ports],
    condition,
    basis: condition,
    formula,
    relationship,
    calculations: extra.calculations || [],
    eliminatedNodes: extra.eliminatedNodes || [],
    contextIds: extra.contextIds || null,
    tier: extra.tier ?? 1,
    eliminatesGeneric: extra.eliminatesGeneric ?? true,
    build,
  };
}

function equivalentValue(a, b, rule) {
  if (a.type === 'Z') {
    const za = zOf(a);
    const zb = zOf(b);
    if (rule === 'series') return cAdd(za, zb);
    const sum = cAdd(za, zb);
    if (cAbs(sum) <= 1e-12 * Math.max(cAbs(za), cAbs(zb), 1e-12)) return null;
    return cDiv(cMul(za, zb), sum);
  }
  if (a.type === 'C') return rule === 'series' ? parallelReal(a.value, b.value) : a.value + b.value;
  return rule === 'series' ? a.value + b.value : parallelReal(a.value, b.value);
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

function computeRegion(doc, ids) {
  const boxes = ids
    .map(id => {
      const e = doc.elements.find(x => x.id === id);
      const g = doc.geometry[id];
      if (!e || !g) return null;
      const pins = pinLocations(doc, e);
      const xs = [g.x - 44, g.x + 44, ...pins.map(p => p.x)];
      const ys = [g.y - 40, g.y + 40, ...pins.map(p => p.y)];
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    })
    .filter(Boolean);
  if (!boxes.length) return null;
  return {
    x1: Math.min(...boxes.map(b => b.x1)),
    y1: Math.min(...boxes.map(b => b.y1)),
    x2: Math.max(...boxes.map(b => b.x2)),
    y2: Math.max(...boxes.map(b => b.y2)),
  };
}

/**
 * Compute Δ -> Y values for R, Z, L, or zero-initial C.
 */
function computeDeltaToStar(group, ports) {
  const type = group[0].type;
  const nodeName = id => id;
  if (type === 'Z') {
    const zs = group.map(zOf);
    const total = zs.reduce(cAdd, { re: 0, im: 0 });
    const scale = Math.max(...zs.map(cAbs), 1e-12);
    if (cAbs(total) <= scale * 1e-12) return null;
    const arms = ports.map((node, k) => {
      const incident = group.filter(e => ends(e).includes(node));
      if (incident.length !== 2) return null;
      const num = cMul(zOf(incident[0]), zOf(incident[1]));
      const val = cDiv(num, total);
      if (!val) return null;
      return {
        port: node,
        attrs: { value: val.re, reactance: val.im },
        symbol: `Z_${nodeName(node)}`,
        expression: `(${incident[0].name}·${incident[1].name}) / (${group.map(e => e.name).join(' + ')})`,
        formatted: fmtZ(val),
        value: val,
      };
    });
    if (arms.some(a => !a)) return null;
    return {
      arms,
      formula: `Z_Σ = ${group.map(e => e.name).join(' + ')} = ${fmtZ(total)}；` + arms.map(a => `${a.symbol} = ${a.expression} = ${a.formatted}`).join('，'),
    };
  }
  if (type === 'C') {
    // For C: C_i = (C_ab*C_bc + C_bc*C_ca + C_ca*C_ab) / C_opposite
    const [e0, e1, e2] = group;
    const sumProd = e0.value * e1.value + e1.value * e2.value + e2.value * e0.value;
    const arms = ports.map(node => {
      const opp = group.find(e => !ends(e).includes(node));
      const inc = group.filter(e => ends(e).includes(node));
      if (!opp || inc.length !== 2) return null;
      const val = sumProd / opp.value;
      return {
        port: node,
        attrs: { value: val },
        symbol: `C_${nodeName(node)}`,
        expression: `${inc[0].name} + ${inc[1].name} + ${inc[0].name}·${inc[1].name}/${opp.name}`,
        formatted: formatValue(val, 'F'),
        value: val,
      };
    });
    if (arms.some(a => !a)) return null;
    return {
      arms,
      formula: arms.map(a => `${a.symbol} = ${a.expression} = ${a.formatted}`).join('；'),
    };
  }
  // R or L
  const total = group.reduce((s, e) => s + e.value, 0);
  const unit = unitOf(type);
  const arms = ports.map(node => {
    const inc = group.filter(e => ends(e).includes(node));
    if (inc.length !== 2) return null;
    const val = (inc[0].value * inc[1].value) / total;
    return {
      port: node,
      attrs: { value: val },
      symbol: `${type}_${nodeName(node)}`,
      expression: `(${inc[0].name}·${inc[1].name}) / (${group.map(e => e.name).join(' + ')})`,
      formatted: formatValue(val, unit),
      value: val,
    };
  });
  if (arms.some(a => !a)) return null;
  return {
    arms,
    formula: `${type}_Σ = ${group.map(e => e.name).join(' + ')} = ${formatValue(total, unit)}；` + arms.map(a => `${a.symbol} = ${a.expression} = ${a.formatted}`).join('，'),
  };
}

/**
 * Compute Y -> Δ values for R, Z, L, or zero-initial C.
 */
function computeStarToDelta(star, ports) {
  const type = star[0].type;
  if (type === 'Z') {
    const zs = star.map(zOf);
    const num = cAdd(cAdd(cMul(zs[0], zs[1]), cMul(zs[1], zs[2])), cMul(zs[2], zs[0]));
    const edges = [0, 1, 2].map(i => {
      const j = (i + 1) % 3;
      const k = (i + 2) % 3;
      if (cAbs(zs[k]) <= 1e-12) return null;
      const val = cDiv(num, zs[k]);
      if (!val) return null;
      return {
        pair: [ports[i], ports[j]],
        attrs: { value: val.re, reactance: val.im },
        symbol: `Z_${ports[i]}${ports[j]}`,
        expression: `${star[i].name} + ${star[j].name} + ${star[i].name}·${star[j].name}/${star[k].name}`,
        formatted: fmtZ(val),
        value: val,
      };
    });
    if (edges.some(e => !e)) return null;
    return {
      edges,
      formula: edges.map(e => `${e.symbol} = ${e.expression} = ${e.formatted}`).join('；'),
    };
  }
  if (type === 'C') {
    // For C: C_ij = (C_i * C_j) / (C_a + C_b + C_c)
    const total = star.reduce((s, e) => s + e.value, 0);
    const edges = [0, 1, 2].map(i => {
      const j = (i + 1) % 3;
      const val = (star[i].value * star[j].value) / total;
      return {
        pair: [ports[i], ports[j]],
        attrs: { value: val },
        symbol: `C_${ports[i]}${ports[j]}`,
        expression: `(${star[i].name}·${star[j].name}) / (${star.map(e => e.name).join(' + ')})`,
        formatted: formatValue(val, 'F'),
        value: val,
      };
    });
    return {
      edges,
      formula: edges.map(e => `${e.symbol} = ${e.expression} = ${e.formatted}`).join('；'),
    };
  }
  // R or L
  const unit = unitOf(type);
  const edges = [0, 1, 2].map(i => {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    const a = star[i].value;
    const b = star[j].value;
    const val = a + b + (a * b) / star[k].value;
    return {
      pair: [ports[i], ports[j]],
      attrs: { value: val },
      symbol: `${type}_${ports[i]}${ports[j]}`,
      expression: `${star[i].name} + ${star[j].name} + ${star[i].name}·${star[j].name}/${star[k].name}`,
      formatted: formatValue(val, unit),
      value: val,
    };
  });
  return {
    edges,
    formula: edges.map(e => `${e.symbol} = ${e.expression} = ${e.formatted}`).join('；'),
  };
}

/**
 * Enumerate all mathematically valid single-step local equivalence transformations.
 * Deterministic ordering: strictly reducing rules first, then structural transforms (Δ↔Y, source transform).
 */
export function recommendations(doc, selected = [], options = {}) {
  if (!doc.elements.length) return [];
  const hasAnySource = doc.elements.some(e => ['V', 'I', 'V3', 'E', 'G', 'F', 'H'].includes(e.type));
  // In sourceless passive multi-port networks (e.g. standalone Δ or Y), named nodes are external ports
  const preserveNamed = options.preserveNamed ?? !hasAnySource;
  const preserveNodes = options.preserveNodes || [];
  const includeStructural = options.includeStructural ?? true;
  const list = doc.elements.filter(e => e.terminals.p !== undefined && movable(doc, e));
  const result = [];
  const append = item => {
    if (!selected.length || (selected.length === 1 ? item.ids.includes(selected[0]) : selected.every(id => item.ids.includes(id)))) {
      result.push(item);
    }
  };

  function replacement(m, e, type, ports, attributes) {
    const pose = m.geometry[e.id] || { x: 300, y: 240, rotation: 0, mirror: false };
    return addElement(m, type, { ...attributes, terminals: { p: ports[0], n: ports[1] }, pose: { ...pose, locked: false } });
  }

  // 1. Open, short, self-loop, and dangling branch rules
  for (const a of list) {
    const u = ends(a);
    if (a.type === 'OPEN' && u.every(n => external(doc, n, [a.id]))) {
      append(candidate('open', '去除开路支路', [a], u, '开路支路电流恒为零，且两端节点仍由其余支路保留。',
        `i(${a.name}) = 0`, '移除开路支路后外部节点电学关系不变。', () => [], { tier: 0 }));
    }
    if (['R', 'Z', 'C', 'L'].includes(a.type) && !a.initial && u[0] === u[1] && external(doc, u[0], [a.id])) {
      append(candidate('open', '去除自环无源支路', [a], [u[0]], `${a.name} 两端短接于同一节点 ${u[0]}，对外部网络无贡献。`,
        `u(${a.name}) = 0，i(${a.name}) = 0`, '移除自环后外部所有节点电压与支路电流不变。', () => [], { tier: 0 }));
    }
    if (hasAnySource && ['R', 'Z', 'C', 'L'].includes(a.type) && !a.initial && u[0] !== u[1]) {
      const deadEnd = u.find(n => members(doc, n).length === 1 && isGenericNode(doc, n) && !preserveNodes.includes(n));
      const liveEnd = deadEnd ? u.find(n => n !== deadEnd) : null;
      if (deadEnd && liveEnd && external(doc, liveEnd, [a.id])) {
        append(candidate('dangling', '去除悬空无电流支路', [a], [liveEnd],
          `节点 ${deadEnd} 仅连接 ${a.name} 一条支路，无法形成闭合回路，支路电流恒为零。`,
          `i(${a.name}) = 0`, `消去悬空节点 ${deadEnd}，其余网络不变。`, () => [], {
            tier: 0,
            eliminatedNodes: [deadEnd],
          }));
      }
    }
    if (a.type === 'SHORT' && u.every(n => external(doc, n, [a.id])) && u[0] !== u[1] &&
      !doc.elements.some(e => ['V', 'T', 'V3', 'OP', 'E', 'H'].includes(e.type) && u.every(n => Object.values(e.terminals).includes(n)))) {
      append(candidate('short', '合并理想短路节点', [a], u, '理想短路不受控且不构成冲突电压约束，两端等电位。',
        `u(${a.name}) = v(${u[0]}) − v(${u[1]}) = 0`, `合并节点 ${u[0]} 与 ${u[1]}。`,
        m => { mergeNodes(m, ...u); return []; }, { tier: 0 }));
    }
  }

  // 2. Balanced Wheatstone bridge zero-current cross arm removal
  for (const bridge of findBridges(doc)) {
    if (!bridge.balanced) continue;
    const crossElem = doc.elements.find(e => e.id === bridge.arms.cross);
    if (!crossElem || !movable(doc, crossElem)) continue;
    const tl = doc.elements.find(e => e.id === bridge.arms.topLeft);
    const bl = doc.elements.find(e => e.id === bridge.arms.bottomLeft);
    const tr = doc.elements.find(e => e.id === bridge.arms.topRight);
    const br = doc.elements.find(e => e.id === bridge.arms.bottomRight);
    // Only valid when left/right bridge nodes have NO other external branches attached (strict 4-arm + cross bridge!)
    const bridgeSet = new Set(bridge.elements);
    const leftClean = members(doc, bridge.nodes.left).every(m => bridgeSet.has(m.id));
    const rightClean = members(doc, bridge.nodes.right).every(m => bridgeSet.has(m.id));
    if (!leftClean || !rightClean) continue;
    const sym = tl.type === 'Z' ? 'Z' : tl.type;
    append(candidate(
      'bridgeBalance',
      '平衡电桥去除零电流桥臂',
      [crossElem],
      [bridge.nodes.top, bridge.nodes.bottom],
      `电桥满足平衡条件 ${tl.name}·${br.name} = ${bl.name}·${tr.name}，且桥节点 ${bridge.nodes.left}、${bridge.nodes.right} 无外接支路，故桥臂 ${crossElem.name} 两端等电位、电流为零。`,
      `${sym}(${tl.name})·${sym}(${br.name}) = ${sym}(${bl.name})·${sym}(${tr.name}) ⇒ v(${bridge.nodes.left}) = v(${bridge.nodes.right})，i(${crossElem.name}) = 0`,
      `断开桥臂 ${crossElem.name}，保持端口 (${bridge.nodes.top}, ${bridge.nodes.bottom}) 等效电阻及全电路电学量不变。`,
      () => [],
      {
        tier: 1,
        contextIds: [tl.id, bl.id, tr.id, br.id],
        calculations: [{
          name: crossElem.name,
          symbol: `i(${crossElem.name})`,
          expression: `v(${bridge.nodes.left}) − v(${bridge.nodes.right}) = 0`,
          value: 0,
          formatted: '0 A（等效开路）',
          ports: [bridge.nodes.left, bridge.nodes.right],
        }],
      },
    ));
  }

  // 3. Pairwise rules: parallel, series, sourceParallel, sourceSeries, sourceTransform
  for (const [i, a] of list.entries()) {
    const u = ends(a);
    for (const b of list.slice(i + 1)) {
      const v = ends(b);
      if (u[0] === u[1] || v[0] === v[1]) continue;
      const identical = same(u, v);
      const common = u.find(n => v.includes(n));
      const series = !identical && common !== undefined && members(doc, common).length === 2 && canEliminateNode(doc, common, { preserveNodes, preserveNamed });
      const ports = identical ? u : [u.find(n => n !== common), v.find(n => n !== common)];

      // Passive series & parallel (R, Z, C, L with zero initial condition)
      if (a.type === b.type && ['R', 'Z', 'C', 'L'].includes(a.type) && !a.initial && !b.initial && (identical || series)) {
        const rule = identical ? 'parallel' : 'series';
        const eq = equivalentValue(a, b, rule);
        if (eq === null) continue;
        const kind = rule === 'series' ? '串联' : '并联';
        const isSum = rule === 'series' ? a.type !== 'C' : a.type === 'C';
        const unit = unitOf(a.type);
        const sym = `${a.type}_eq`;
        const symbolicExpr = isSum ? `${a.name} + ${b.name}` : `(${a.name} · ${b.name}) / (${a.name} + ${b.name})`;
        const formatted = a.type === 'Z' ? fmtZ(eq) : formatValue(eq, unit);
        const substituted = isSum
          ? `${fmtElementVal(a)} + ${fmtElementVal(b)}`
          : `(${fmtElementVal(a)} ∥ ${fmtElementVal(b)})`;
        const attrs = a.type === 'Z' ? { value: eq.re, reactance: eq.im } : { value: eq };
        const cond = identical
          ? `${a.name} 与 ${b.name} 两端分别连接于同一对节点 (${ports[0]}, ${ports[1]})，构成并联。`
          : `${a.name} 与 ${b.name} 共享度为 2 的内部节点 ${common}，流过相同电流，构成串联。`;
        append(candidate(
          rule,
          `${typeLabel(a.type)}${kind}合并`,
          [a, b],
          ports,
          cond,
          `${sym} = ${symbolicExpr} = ${substituted} = ${formatted}`,
          `保留外部端口 (${ports[0]}, ${ports[1]}) 的伏安特性${series ? `，消去内部节点 ${common}` : ''}。`,
          m => [replacement(m, a, a.type, ports, attrs)],
          {
            tier: 1,
            eliminatedNodes: series ? [common] : [],
            eliminatesGeneric: !series || isGenericNode(doc, common),
            calculations: [{
              name: `${a.type}eq`,
              symbol: sym,
              expression: `${symbolicExpr} = ${substituted}`,
              value: eq,
              formatted,
              ports,
            }],
          },
        ));
      }

      // Independent source series (V+V) and parallel (I||I)
      if ((a.type === 'I' && b.type === 'I' && identical) || (a.type === 'V' && b.type === 'V' && series)) {
        const aSign = a.terminals.p === ports[0] ? 1 : -1;
        const bSign = (identical ? b.terminals.p === ports[0] : b.terminals.n === ports[1]) ? 1 : -1;
        const sumData = summedSource(a, b, aSign, bSign);
        const unit = unitOf(a.type);
        const sym = a.type === 'V' ? 'V_eq' : 'I_eq';
        const expr = `${aSign === 1 ? '' : '−'}${a.name} ${bSign === 1 ? '+' : '−'} ${b.name}`;
        append(candidate(
          identical ? 'sourceParallel' : 'sourceSeries',
          identical ? '并联电流源合并' : '串联电压源合并',
          [a, b],
          ports,
          identical ? '两独立电流源跨接于相同节点对，按 KCL 叠加。' : `两独立电压源串联，中间节点 ${common} 无分支，按 KVL 叠加。`,
          `${sym} = ${expr} = ${formatValue(sumData.value, unit)}`,
          '保留直流与正弦相量端口激励特性。',
          m => [replacement(m, a, a.type, ports, sumData)],
          {
            tier: 1,
            eliminatedNodes: series ? [common] : [],
            eliminatesGeneric: !series || isGenericNode(doc, common),
            calculations: [{
              name: sym,
              symbol: sym,
              expression: expr,
              value: sumData.value,
              formatted: formatValue(sumData.value, unit),
              ports,
            }],
          },
        ));
      }

      // Source transformation (V + R <-> I || R)
      if (includeStructural) {
        const supply = [a, b].find(e => ['V', 'I'].includes(e.type));
        const resistor = [a, b].find(e => e.type === 'R');
        if (supply && resistor && ((supply.type === 'V' && series) || (supply.type === 'I' && identical))) {
          const toCurrent = supply.type === 'V';
          const bridge = toCurrent
            ? [ends(supply).find(n => n !== common), ends(resistor).find(n => n !== common)]
            : ends(supply);
          const sign = toCurrent ? (supply.terminals.p === bridge[0] ? -1 : 1) : -1;
          const multiplier = toCurrent ? 1 / resistor.value : resistor.value;
          const eqSourceVal = Math.abs(multiplier) * supply.value * sign;
          const eqFmt = formatValue(Math.abs(eqSourceVal), toCurrent ? 'A' : 'V');
          const rFmt = formatValue(resistor.value, 'Ω');
          append(candidate(
            'sourceTransform',
            toCurrent ? '戴维南转诺顿（电压源→电流源）' : '诺顿转戴维南（电流源→电压源）',
            [a, b],
            bridge,
            toCurrent ? `独立电压源 ${supply.name} 与电阻 ${resistor.name} 串联，中间节点 ${common} 无分支。` : `独立电流源 ${supply.name} 与电阻 ${resistor.name} 并联于 (${bridge[0]}, ${bridge[1]})。`,
            toCurrent ? `I_N = ${supply.name} / ${resistor.name} = ${eqFmt}，R_N = ${resistor.name} = ${rFmt}` : `V_th = ${supply.name} · ${resistor.name} = ${eqFmt}，R_th = ${resistor.name} = ${rFmt}`,
            `保持端口 (${bridge[0]}, ${bridge[1]}) 的开路电压与等效内阻不变。`,
            m => {
              const data = { value: eqSourceVal };
              if (supply.ac !== null || supply.value < 0) data.ac = multiplier * (supply.ac ?? Math.abs(supply.value));
              data.phase = supply.phase + (sign < 0 && data.ac !== undefined ? 180 : 0);
              return toCurrent
                ? [replacement(m, supply, 'I', bridge, data), replacement(m, resistor, 'R', bridge, { value: resistor.value })]
                : (() => {
                  const intermediate = addNode(m);
                  return [
                    replacement(m, supply, 'V', [bridge[0], intermediate], data),
                    replacement(m, resistor, 'R', [intermediate, bridge[1]], { value: resistor.value }),
                  ];
                })();
            },
            {
              tier: 2,
              eliminatedNodes: toCurrent ? [common] : [],
              eliminatesGeneric: !toCurrent || isGenericNode(doc, common),
              calculations: [
                { name: toCurrent ? 'I_N' : 'V_th', symbol: toCurrent ? 'I_N' : 'V_th', expression: toCurrent ? `${supply.name} / ${resistor.name}` : `${supply.name} · ${resistor.name}`, value: eqSourceVal, formatted: eqFmt, ports: bridge },
                { name: toCurrent ? 'R_N' : 'R_th', symbol: toCurrent ? 'R_N' : 'R_th', expression: resistor.name, value: resistor.value, formatted: rFmt, ports: bridge },
              ],
            },
          ));
        }
      }
    }
  }

  // 4. Bidirectional Y <-> Δ transformations (for R, Z, zero-initial C, zero-initial L)
  if (includeStructural) {
    // 4a. Star -> Delta (Y -> Δ)
    for (const wye of findWyes(doc, { allowSources: false, strictCenterDegree: true, sameTypeOnly: true })) {
      const star = wye.elements.map(id => doc.elements.find(e => e.id === id));
      if (!star.every(e => e && movable(doc, e) && !e.initial)) continue;
      if (!canEliminateNode(doc, wye.center, { preserveNodes, preserveNamed })) continue;
      const calc = computeStarToDelta(star, wye.ports);
      if (!calc) continue;
      const type = star[0].type;
      append(candidate(
        'starDelta',
        `星形转三角形 (Y→Δ · ${typeLabel(type)})`,
        star,
        wye.ports,
        `三个${typeLabel(type)}（${star.map(e => e.name).join('、')}）以节点 ${wye.center} 为星点，连接到三个独立外部端口 (${wye.ports.join(', ')})。`,
        calc.formula,
        `消去中心星点 ${wye.center}，保持三端口 (${wye.ports.join(', ')}) 的导纳矩阵完全一致。`,
        m => calc.edges.map((edge, idx) => replacement(m, star[idx], type, edge.pair, edge.attrs)),
        {
          tier: 2,
          eliminatedNodes: [wye.center],
          eliminatesGeneric: wye.centerIsGeneric,
          calculations: calc.edges.map(edge => ({
            name: edge.symbol,
            symbol: edge.symbol,
            expression: edge.expression,
            value: edge.value,
            formatted: edge.formatted,
            ports: edge.pair,
          })),
        },
      ));
    }

    // 4b. Delta -> Star (Δ -> Y) — always available via topology recognition (not restricted to selected.length >= 2!)
    for (const delta of findDeltas(doc, { allowSources: false, sameTypeOnly: true })) {
      const group = delta.elements.map(id => doc.elements.find(e => e.id === id));
      if (!group.every(e => e && movable(doc, e) && !e.initial)) continue;
      const calc = computeDeltaToStar(group, delta.nodes);
      if (!calc) continue;
      const type = group[0].type;
      append(candidate(
        'deltaStar',
        `三角形转星形 (Δ→Y · ${typeLabel(type)})`,
        group,
        delta.nodes,
        `三个${typeLabel(type)}（${group.map(e => e.name).join('、')}）跨接于三对不同节点 (${delta.nodes.join(', ')})，构成封闭三角形网络。`,
        calc.formula,
        `引入内部星点，将 Δ 支路转为 Y 支路，保持三端口 (${delta.nodes.join(', ')}) 的导纳矩阵完全一致。`,
        m => {
          const center = addNode(m);
          return calc.arms.map((arm, idx) => replacement(m, group[idx], type, [arm.port, center], arm.attrs));
        },
        {
          tier: 2,
          eliminatedNodes: [],
          eliminatesGeneric: true,
          calculations: calc.arms.map(arm => ({
            name: arm.symbol,
            symbol: arm.symbol,
            expression: arm.expression,
            value: arm.value,
            formatted: arm.formatted,
            ports: [arm.port, 'center'],
          })),
        },
      ));
    }
  }

  // Deterministic ergonomic ordering:
  // Tier 0 (open/short/dangling) -> Tier 1 (bridgeBalance/parallel/series/source combine) -> Tier 2 (deltaStar/starDelta/sourceTransform)
  const ruleRank = {
    open: 0, dangling: 1, short: 2, bridgeBalance: 3, parallel: 4, series: 5,
    sourceParallel: 6, sourceSeries: 7, deltaStar: 8, starDelta: 9, sourceTransform: 10,
  };
  result.sort((a, b) =>
    (a.tier - b.tier)
    || ((b.eliminatesGeneric ? 1 : 0) - (a.eliminatesGeneric ? 1 : 0))
    || ((ruleRank[a.rule] ?? 99) - (ruleRank[b.rule] ?? 99))
    || a.names.join(',').localeCompare(b.names.join(',')));

  return result;
}

/**
 * Lightweight topology-only application (no layout or routing) used exclusively inside lookahead search.
 */
function applyTopologyOnly(doc, item) {
  const next = clone(doc);
  const created = item.build(next);
  const addedIds = created.map(e => e.id);
  removeElements(next, item.ids);
  prune(next);
  return { next, addedIds };
}

/**
 * Execute EXACTLY ONE local equivalence transformation step with:
 * - Independent solver verification (full circuit + local port matrix)
 * - Visual continuity layout preservation
 * - Highlight metadata & full intermediate circuit snapshots
 */
export function applyReduction(doc, item, options = {}) {
  assertValid(doc);
  const before = snapshot(doc);
  const next = clone(doc);
  const beforeNodes = new Set(doc.nodes.map(n => n.id));
  const created = item.build(next);
  const addedIds = created.map(e => e.id);
  const addedNames = created.map(e => e.name);
  removeElements(next, item.ids);
  assertValid(prune(next));

  const afterNodes = new Set(next.nodes.map(n => n.id));
  const eliminatedNodes = [...beforeNodes].filter(id => !afterNodes.has(id));
  const createdNodes = [...afterNodes].filter(id => !beforeNodes.has(id));

  // Build merged node map for 'short' rule so full-circuit verifier aligns merged nodes cleanly
  let mergedNodeMap = null;
  if (item.rule === 'short' && item.ports.length === 2) {
    const [a, b] = item.ports;
    const kept = afterNodes.has(a) ? a : b;
    const removed = kept === a ? b : a;
    mergedNodeMap = new Map([[removed, kept]]);
  }

  // Independent electrical equivalence verification
  const verification = verifyEquivalence(doc, next, {
    rule: item.rule,
    removedIds: item.ids,
    addedIds,
    ports: item.ports,
    contextIds: item.contextIds,
    mergedNodeMap,
    tolerance: options.tolerance ?? 1e-8,
  });
  if (!verification.passed) {
    throw Error(`独立求解器等价性验证未通过：${verification.label}`);
  }

  // Preserve visual continuity for all untouched elements
  const laid = preserveLayout(doc, next, {
    removedIds: item.ids,
    addedIds,
    rule: item.rule,
    ports: item.ports,
  });
  const model = laid.model;

  // Bind created element names into calculations if applicable
  const calculations = (item.calculations || []).map((c, idx) => ({
    ...c,
    elementId: addedIds[idx] ?? null,
    elementName: addedNames[idx] ?? c.name,
  }));

  const highlight = {
    beforeElements: [...item.ids],
    afterElements: [...addedIds],
    ports: [...item.ports],
    beforeRegion: computeRegion(doc, item.ids),
    afterRegion: computeRegion(model, addedIds),
  };

  const { title, rule, condition, basis, formula, relationship, names, ports } = item;
  const step = {
    index: doc.history.length + 1,
    title,
    rule,
    condition,
    basis: basis || condition,
    formula,
    calculations,
    relationship,
    names,
    removedIds: [...item.ids],
    removedNames: [...names],
    addedIds,
    addedNames,
    ports: [...ports],
    eliminatedNodes,
    createdNodes,
    highlight,
    continuity: laid.continuity,
    verification,
    before,
    after: snapshot(model),
  };
  model.history.push(step);
  return { model, step };
}

function activeElementCount(doc) {
  return doc.elements.filter(e => e.type !== 'GND').length;
}

function stateVisited(candidateDoc, visitedMap, preserveNodes) {
  const fp = circuitFingerprint(candidateDoc, { preserveNodes });
  if (!visitedMap.has(fp)) return { visited: false, fp };
  // Guard against theoretical hash collision with exact graph isomorphism check
  for (const prior of visitedMap.get(fp)) {
    if (compareTopology(candidateDoc, prior, { names: false, values: true })) {
      return { visited: true, fp };
    }
  }
  return { visited: false, fp };
}

function recordVisited(doc, visitedMap, preserveNodes) {
  const fp = circuitFingerprint(doc, { preserveNodes });
  if (!visitedMap.has(fp)) visitedMap.set(fp, []);
  visitedMap.get(fp).push(snapshot(doc));
  return fp;
}

/**
 * Bounded lookahead search to check whether a non-reducing structural move (Δ→Y, Y→Δ, sourceTransform)
 * genuinely unlocks strictly further element reduction without cycling.
 */
function evaluateUnlockingMove(doc, move, visitedMap, options, depthLimit = 3) {
  let first;
  try {
    first = applyTopologyOnly(doc, move);
  } catch {
    return null;
  }
  if (stateVisited(first.next, visitedMap, options.preserveNodes).visited) return null;

  const startCount = activeElementCount(doc);
  const localVisited = new Set([circuitFingerprint(doc, options), circuitFingerprint(first.next, options)]);

  // Greedily follow strictly reducing Tier 0/1 moves and allow limited branching on Tier 2
  function dfs(state, depth, stepsToReduce) {
    const curCount = activeElementCount(state);
    let bestCount = curCount;
    let bestSteps = stepsToReduce;
    if (depth >= depthLimit) return { minCount: bestCount, stepsToReduce: bestSteps };

    const opts = recommendations(state, [], { ...options, includeStructural: depth < depthLimit - 1 });
    const reducing = opts.filter(r => r.tier <= 1);

    if (reducing.length) {
      // Follow deterministic Tier 0/1 reduction chain greedily
      let cur = state;
      let localSteps = 0;
      while (localSteps < 12) {
        const nextOpt = recommendations(cur, [], { ...options, includeStructural: false })[0];
        if (!nextOpt) break;
        const applied = applyTopologyOnly(cur, nextOpt);
        const fp = circuitFingerprint(applied.next, options);
        if (localVisited.has(fp) || stateVisited(applied.next, visitedMap, options.preserveNodes).visited) break;
        localVisited.add(fp);
        cur = applied.next;
        localSteps++;
        const cnt = activeElementCount(cur);
        if (cnt < bestCount) {
          bestCount = cnt;
          bestSteps = bestSteps === Infinity ? depth + localSteps : Math.min(bestSteps, depth + localSteps);
        }
      }
      if (bestCount < startCount) return { minCount: bestCount, stepsToReduce: bestSteps };
      return dfs(cur, depth + 1, bestSteps);
    }

    // Try at most 4 structural branches at deeper level
    for (const structOpt of opts.filter(r => r.tier === 2).slice(0, 4)) {
      let applied;
      try { applied = applyTopologyOnly(state, structOpt); } catch { continue; }
      const fp = circuitFingerprint(applied.next, options);
      if (localVisited.has(fp) || stateVisited(applied.next, visitedMap, options.preserveNodes).visited) continue;
      localVisited.add(fp);
      const sub = dfs(applied.next, depth + 1, bestSteps);
      if (sub.minCount < bestCount || (sub.minCount === bestCount && sub.stepsToReduce < bestSteps)) {
        bestCount = sub.minCount;
        bestSteps = sub.stepsToReduce;
      }
    }
    return { minCount: bestCount, stepsToReduce: bestSteps };
  }

  const outcome = dfs(first.next, 1, Infinity);
  if (outcome.minCount >= startCount) return null;
  return {
    move,
    minCount: outcome.minCount,
    reductionGain: startCount - outcome.minCount,
    stepsToReduce: outcome.stepsToReduce,
  };
}

/**
 * Choose the single best next local equivalence transformation with cycle detection and lookahead.
 */
export function selectNextReduction(doc, { selected = [], visitedMap = new Map(), lastRule = null, ...options } = {}) {
  const opts = recommendations(doc, selected, { ...options, includeStructural: true });
  let cyclesAvoided = 0;

  // 1. Check strictly reducing rules (Tier 0 & Tier 1) first
  for (const opt of opts.filter(r => r.tier <= 1)) {
    let probe;
    try { probe = applyTopologyOnly(doc, opt); } catch { continue; }
    if (stateVisited(probe.next, visitedMap, options.preserveNodes || []).visited) {
      cyclesAvoided++;
      continue;
    }
    return { option: opt, cyclesAvoided, reason: 'direct_reduction' };
  }

  // 2. If no strictly reducing rule exists, evaluate structural unlocking moves (Δ→Y, Y→Δ, sourceTransform) via lookahead
  const structural = opts.filter(r => r.tier === 2);
  if (!structural.length) {
    return { option: null, cyclesAvoided, reason: 'no_applicable_rules' };
  }

  const evaluated = [];
  for (const move of structural) {
    // Prevent immediate inverse oscillation on the same port set
    if (lastRule && same(lastRule.ports, move.ports) && (
      (lastRule.rule === 'deltaStar' && move.rule === 'starDelta')
      || (lastRule.rule === 'starDelta' && move.rule === 'deltaStar')
      || (lastRule.rule === 'sourceTransform' && move.rule === 'sourceTransform')
    )) {
      cyclesAvoided++;
      continue;
    }
    let probe;
    try { probe = applyTopologyOnly(doc, move); } catch { continue; }
    if (stateVisited(probe.next, visitedMap, options.preserveNodes || []).visited) {
      cyclesAvoided++;
      continue;
    }
    const score = evaluateUnlockingMove(doc, move, visitedMap, options, options.lookaheadDepth ?? 3);
    if (score) evaluated.push(score);
  }

  if (!evaluated.length) {
    return { option: null, cyclesAvoided, reason: 'irreducible_no_progress' };
  }

  const ruleBias = { deltaStar: 0, starDelta: 1, sourceTransform: 2 };
  evaluated.sort((a, b) =>
    (a.minCount - b.minCount)
    || (a.stepsToReduce - b.stepsToReduce)
    || ((ruleBias[a.move.rule] ?? 9) - (ruleBias[b.move.rule] ?? 9))
    || a.move.names.join(',').localeCompare(b.move.names.join(',')));

  return { option: evaluated[0].move, cyclesAvoided, reason: 'lookahead_unlock', lookahead: evaluated[0] };
}

/**
 * Deterministic step-by-step automatic circuit reduction with path planning, cycle detection,
 * independent verification at every step, and visual continuity preservation.
 * NEVER jumps directly to the final equivalent circuit — every local transformation is recorded as a full step.
 */
export function reduceStepByStep(doc, options = {}) {
  const hasAnySource = doc.elements.some(e => ['V', 'I', 'V3', 'E', 'G', 'F', 'H'].includes(e.type));
  const {
    selected = [],
    maxSteps = 30,
    preserveNamed = !hasAnySource,
    allowBridgeBalance = true,
    lookaheadDepth = 3,
  } = options;
  // Auto-preserve open degree-1 named external ports in addition to caller-specified preserveNodes
  const openExternalPorts = doc.nodes
    .filter(n => !n.reference && !isGenericNode(doc, n.id) && members(doc, n.id).length === 1)
    .map(n => n.id);
  const preserveNodes = [...new Set([...(options.preserveNodes || []), ...openExternalPorts])];

  let model = doc;
  const visitedMap = new Map();
  recordVisited(model, visitedMap, preserveNodes);
  // Also seed visited states from any existing history on doc to prevent cycling across repeated runs
  for (const past of doc.history || []) {
    if (past?.before) recordVisited({ ...past.before, history: [] }, visitedMap, preserveNodes);
    if (past?.after) recordVisited({ ...past.after, history: [] }, visitedMap, preserveNodes);
  }

  const steps = [];
  let cyclesAvoided = 0;
  let stopReason = 'completed';
  let lastRule = null;

  for (let i = 0; i < maxSteps; i++) {
    const pick = selectNextReduction(model, {
      selected: i === 0 ? selected : [],
      visitedMap,
      lastRule,
      preserveNodes,
      preserveNamed,
      lookaheadDepth,
    });
    cyclesAvoided += pick.cyclesAvoided;
    let chosen = pick.option;
    if (chosen && !allowBridgeBalance && chosen.rule === 'bridgeBalance') {
      // Re-pick skipping bridgeBalance when caller explicitly wants Δ-Y derivation on a balanced bridge
      const alt = recommendations(model, i === 0 ? selected : [], { preserveNodes, preserveNamed })
        .filter(r => r.rule !== 'bridgeBalance');
      chosen = null;
      for (const cand of alt) {
        if (cand.tier <= 1) { chosen = cand; break; }
        const scored = evaluateUnlockingMove(model, cand, visitedMap, { preserveNodes, preserveNamed }, lookaheadDepth);
        if (scored) { chosen = scored.move; break; }
      }
    }
    if (!chosen) {
      stopReason = pick.reason || 'completed';
      break;
    }
    const { model: nextModel, step } = applyReduction(model, chosen, options);
    recordVisited(nextModel, visitedMap, preserveNodes);
    model = nextModel;
    steps.push(step);
    lastRule = { rule: step.rule, ports: step.ports };
    if (i === maxSteps - 1) stopReason = 'max_steps_reached';
  }

  return {
    model,
    steps,
    totalSteps: steps.length,
    cyclesAvoided,
    stopReason,
  };
}

/**
 * Backwards-compatible wrapper that runs step-by-step reduction and returns the updated Circuit IR
 * with EVERY intermediate step recorded in `model.history`.
 */
export function reduceAll(doc, selected = [], options = {}) {
  return reduceStepByStep(doc, { ...options, selected }).model;
}
