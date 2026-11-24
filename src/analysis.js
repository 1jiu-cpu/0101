import { assertValid, clone, addElement, referenceNode, TYPES } from './model.js';

const zeros = n => Array(n).fill(0);
const matrix = n => Array.from({ length: n }, () => zeros(n));
const radians = degrees => degrees * Math.PI / 180;
const signedPair = (a, b) => [[a, 1], [b, -1]];
const read = (x, index) => index < 0 ? 0 : x[index];
const complex = (re = 0, im = 0) => ({ re, im, magnitude: Math.hypot(re, im), angle: Math.atan2(im, re) * 180 / Math.PI });

const singular = () => Error('方程奇异。请检查悬浮节点、未闭合端口、重复理想源约束或不相容的初始条件。');

function eliminate(A, b, recover) {
  const n = b.length;
  const rows = A.map((row, i) => {
    const scale = Math.max(...row.map(Math.abs));
    if (!scale) return [...row, b[i]];
    return [...row.map(x => x / scale), b[i] / scale];
  });
  const columns = Array.from({ length: n }, (_, i) => Math.max(...rows.map(row => Math.abs(row[i]))) || 1);
  for (const row of rows) for (let j = 0; j < n; j++) row[j] /= columns[j];
  const rhsScale = Math.max(1, ...rows.map(row => Math.abs(row[n])));
  const pivots = [];
  const free = [];
  for (let k = 0; k < n; k++) {
    const r = pivots.length;
    let pivot = r;
    for (let i = r + 1; i < n; i++) if (Math.abs(rows[i][k]) > Math.abs(rows[pivot][k])) pivot = i;
    if (Math.abs(rows[pivot][k]) < 1e-13) {
      if (!recover) throw singular();
      free.push(k);
      continue;
    }
    pivots.push(k);
    [rows[r], rows[pivot]] = [rows[pivot], rows[r]];
    for (let i = r + 1; i < n; i++) {
      const factor = rows[i][k] / rows[r][k];
      if (!factor) continue;
      rows[i][k] = 0;
      for (let j = k + 1; j <= n; j++) rows[i][j] -= factor * rows[r][j];
    }
  }
  if (rows.slice(pivots.length).some(row => Math.abs(row[n]) > rhsScale * 1e-11)) throw Error('理想电源约束互相矛盾。请核对闭环中的幅值和相角。');
  function substitute(freeVariable) {
    const solution = zeros(n);
    if (freeVariable !== undefined) solution[freeVariable] = 1;
    for (let i = pivots.length - 1; i >= 0; i--) {
      const k = pivots[i];
      let rhs = freeVariable === undefined ? rows[i][n] : 0;
      for (let j = k + 1; j < n; j++) rhs -= rows[i][j] * solution[j];
      solution[k] = rhs / rows[i][k];
    }
    return solution;
  }
  const result = substitute();
  if (result.some(x => !Number.isFinite(x))) throw Error('矩阵计算超出数值范围。');
  const unresolved = new Set();
  for (const f of free) {
    const direction = substitute(f);
    for (const [i, coefficient] of direction.entries()) if (Math.abs(coefficient) > 1e-10) unresolved.add(i);
  }
  return { result: result.map((value, i) => value / columns[i]), unresolved };
}

export const linearSolve = (A, b) => eliminate(A, b, false).result;

export function buildSystem(doc, sourceId = null, mute = false) {
  assertValid(doc);
  if (!doc.elements.some(e => e.type !== 'GND')) throw Error('请添加元件并完成连接。');
  if (doc.elements.length > 160) throw Error('当前分析工作区最多支持 160 个元件。');
  const reference = referenceNode(doc);
  const active = new Set(doc.elements.flatMap(e => Object.values(e.terminals)));
  const nodes = doc.nodes.filter(n => n.id !== reference && active.has(n.id));
  const names = nodes.map(n => `v(${n.label})`);
  const nodeIndices = new Map(nodes.map((n, i) => [n.id, i]));
  const index = id => nodeIndices.get(id) ?? -1;
  const branches = new Map();
  const ports = new Map();
  const byId = new Map(doc.elements.map(e => [e.id, e]));
  function allocate(e, labels) {
    branches.set(e.id, labels.map(label => {
      const i = names.length;
      names.push(`i(${e.name}${label})`);
      return i;
    }));
  }
  for (const e of doc.elements) {
    const t = e.terminals;
    const pairs = e.type === 'OP' ? [[t.out, t.ref]] : e.type === 'T' ? [[t.p1, t.n1], [t.p2, t.n2]]
      : e.type === 'V3' ? [[t.A, t.N], [t.B, t.N], [t.C, t.N]] : e.type === 'GND' ? [] : [[t.p, t.n]];
    ports.set(e.id, pairs.map(pair => pair.map(index)));
    if (['V', 'E', 'H', 'C', 'L', 'OP', 'SHORT', 'Z'].includes(e.type)) allocate(e, ['']);
    if (e.type === 'T') allocate(e, ['.1', '.2']);
    if (e.type === 'V3') allocate(e, ['.A', '.B', '.C']);
  }
  if (!names.length) throw Error('所有已用端口均接在参考节点。');
  const G = matrix(names.length);
  const E = matrix(names.length);
  const J = matrix(names.length);
  const dc = zeros(names.length);
  const acRe = zeros(names.length);
  const acIm = zeros(names.length);
  const initial = [];
  const stamp = (A, row, col, value) => { if (row >= 0 && col >= 0) A[row][col] += value; };
  const addVoltage = (A, row, pair, gain = 1) => signedPair(...pair).forEach(([col, sign]) => stamp(A, row, col, gain * sign));
  const stampCurrent = (pair, coefficients, gain = 1) => {
    for (const [row, sign] of signedPair(...pair)) for (const [col, value] of coefficients) stamp(G, row, col, value * sign * gain);
  };
  const voltage = (pair, gain = 1) => signedPair(...pair).map(([i, sign]) => [i, gain * sign]);
  function source(e, shift = 0) {
    if (sourceId !== null) return e.id === sourceId ? { dc: 1, re: 1, im: 0 } : { dc: 0, re: 0, im: 0 };
    if (mute) return { dc: 0, re: 0, im: 0 };
    const phase = radians(e.phase + shift);
    const amplitude = e.ac ?? e.value;
    return { dc: e.value, re: amplitude * Math.cos(phase), im: amplitude * Math.sin(phase) };
  }
  function inject(row, sign, s) {
    if (row < 0) return;
    dc[row] += sign * s.dc;
    acRe[row] += sign * s.re;
    acIm[row] += sign * s.im;
  }
  function controlledCurrent(e, visited = new Set()) {
    if (!e) throw Error('请在流控电源属性中指定电流控制支路。');
    if (visited.has(e.id)) throw Error('流控电源的控制关系形成代数环。');
    const aux = branches.get(e.id);
    if (aux?.length === 1) return [[aux[0], 1]];
    const [pair] = ports.get(e.id);
    const t = e.terminals;
    if (e.type === 'R') return voltage(pair, 1 / e.value);
    if (e.type === 'G') return voltage([index(t.cp), index(t.cn)], e.value);
    if (e.type === 'F') return controlledCurrent(byId.get(e.control), new Set([...visited, e.id])).map(([i, k]) => [i, k * e.value]);
    if (e.type === 'OPEN') return [];
    throw Error(`${e.name} 不能直接作流控支路。可在控制支路串入一个 0 V 电压源作为电流探针。`);
  }
  for (const e of doc.elements) {
    const p = ports.get(e.id);
    const [pair] = p;
    const rows = branches.get(e.id) || [];
    const [row, second] = rows;
    const t = e.terminals;
    rows.forEach((i, j) => stampCurrent(p[j], [[i, 1]]));
    switch (e.type) {
      case 'R': stampCurrent(pair, voltage(pair, 1 / e.value)); break;
      case 'Z':
        addVoltage(G, row, pair);
        stamp(G, row, row, -e.value);
        stamp(J, row, row, -e.reactance);
        break;
      case 'I': {
        const s = source(e);
        signedPair(...pair).forEach(([i, sign]) => inject(i, -sign, s));
        break;
      }
      case 'V':
      case 'SHORT':
        addVoltage(G, row, pair);
        if (e.type === 'V') inject(row, 1, source(e));
        break;
      case 'V3':
        rows.forEach((i, j) => {
          addVoltage(G, i, p[j]);
          const s = source(e, -120 * j);
          inject(i, 1, { ...s, dc: 0 });
        });
        break;
      case 'C':
        stamp(G, row, row, 1);
        addVoltage(E, row, pair, -e.value);
        initial.push({ row, entries: voltage(pair), value: e.initial, e });
        break;
      case 'L':
        addVoltage(G, row, pair);
        stamp(E, row, row, -e.value);
        initial.push({ row, entries: [[row, 1]], value: e.initial, e });
        break;
      case 'E':
        addVoltage(G, row, pair);
        addVoltage(G, row, [index(t.cp), index(t.cn)], -e.value);
        break;
      case 'G':
        stampCurrent(pair, voltage([index(t.cp), index(t.cn)], e.value));
        break;
      case 'F':
        stampCurrent(pair, controlledCurrent(e));
        break;
      case 'H':
        addVoltage(G, row, pair);
        for (const [i, k] of controlledCurrent(byId.get(e.control))) stamp(G, row, i, -e.value * k);
        break;
      case 'OP':
        addVoltage(G, row, [index(t.plus), index(t.minus)]);
        break;
      case 'T':
        addVoltage(G, row, pair);
        addVoltage(G, row, p[1], -e.value);
        stamp(G, second, row, e.value);
        stamp(G, second, second, 1);
        break;
    }
  }
  for (const { a, b, k } of doc.couplings) {
    const coupling = k * Math.sqrt(byId.get(a).value * byId.get(b).value);
    const i = branches.get(a)[0];
    const j = branches.get(b)[0];
    stamp(E, i, j, -coupling);
    stamp(E, j, i, -coupling);
  }
  return { doc, G, E, J, dc, acRe, acIm, names, nodes, index, reference, branches, ports, initial, controlledCurrent, source };
}

const difference = (x, [a, b]) => read(x, a) - read(x, b);
const dot = (row, vector) => row.reduce((sum, value, i) => sum + value * vector[i], 0);
const combine = (A, B, k) => A.map((row, i) => row.map((value, j) => value + k * B[i][j]));

function frequencySolution(system, frequency, recover = false) {
  const { G, E, J, acRe, acIm } = system;
  const omega = 2 * Math.PI * frequency;
  const imaginary = combine(J, E, omega);
  const block = [
    ...G.map((row, i) => [...row, ...imaginary[i].map(value => -value)]),
    ...G.map((row, i) => [...imaginary[i], ...row]),
  ];
  const { result, unresolved } = eliminate(block, [...acRe, ...acIm], recover);
  const unknown = new Set([...unresolved].map(i => i % G.length));
  const sourceCurrents = new Set(system.doc.elements.filter(e => ['V', 'SHORT'].includes(e.type)).flatMap(e => system.branches.get(e.id)));
  if ([...unknown].some(i => !sourceCurrents.has(i)) ||
      system.doc.elements.some(e => ['F', 'H'].includes(e.type) && system.branches.get(e.control)?.some(i => unknown.has(i)))) throw singular();
  return { re: result.slice(0, G.length), im: result.slice(G.length), imaginary, unknown };
}

function branchValue(system, e, port, vector, kind) {
  const pair = system.ports.get(e.id)[port];
  const voltage = difference(vector, pair);
  const aux = system.branches.get(e.id);
  if (aux) return { voltage, current: vector[aux[port]] };
  const t = e.terminals;
  switch (e.type) {
    case 'R': return { voltage, current: voltage / e.value };
    case 'I': return { voltage, current: system.source(e)[kind] };
    case 'G': return { voltage, current: e.value * difference(vector, [system.index(t.cp), system.index(t.cn)]) };
    case 'F': return { voltage, current: system.controlledCurrent(e).reduce((sum, [i, k]) => sum + read(vector, i) * k, 0) };
    default: return { voltage, current: 0 };
  }
}

export function solve(doc, mode = 'dc', frequency = 1000) {
  if (!['dc', 'ac'].includes(mode)) throw Error('未知分析方式。');
  if (mode === 'ac' && !(frequency > 0 && Number.isFinite(frequency))) throw Error('频率必须大于零。');
  if (mode === 'dc' && doc.elements.some(e => e.type === 'V3')) throw Error('请使用正弦稳态分析三相电源。');
  if (mode === 'dc') requireFrequencyModel(doc, '直流分析');
  const system = buildSystem(doc);
  const { G, E, J, dc } = system;
  const { re, im, imaginary, unknown } = mode === 'ac' ? frequencySolution(system, frequency, true)
    : { re: linearSolve(G, dc), im: zeros(G.length), imaginary: matrix(G.length), unknown: new Set() };
  const residuals = G.map((row, i) => complex(
    dot(row, re) - dot(imaginary[i], im) - (mode === 'dc' ? dc[i] : system.acRe[i]),
    dot(row, im) + dot(imaginary[i], re) - (mode === 'dc' ? 0 : system.acIm[i]),
  ).magnitude);
  const nodes = doc.nodes.map(n => ({ ...n, voltage: complex(read(re, system.index(n.id)), read(im, system.index(n.id))) }));
  let totalPower = complex();
  const branches = doc.elements.flatMap(e => system.ports.get(e.id).map((_, i, all) => {
    const real = branchValue(system, e, i, re, mode === 'dc' ? 'dc' : 're');
    const imaginary = mode === 'dc' ? { voltage: 0, current: 0 } : branchValue(system, e, i, im, 'im');
    const power = complex(real.voltage * real.current + imaginary.voltage * imaginary.current, imaginary.voltage * real.current - real.voltage * imaginary.current);
    totalPower = complex(totalPower.re + power.re, totalPower.im + power.im);
    const undetermined = unknown.has(system.branches.get(e.id)?.[i]);
    return {
      id: e.id, type: e.type, name: all.length > 1 ? `${e.name}.${e.type === 'V3' ? 'ABC'[i] : i + 1}` : e.name,
      voltage: complex(real.voltage * e.voltageSign, imaginary.voltage * e.voltageSign),
      current: undetermined ? null : complex(real.current * e.currentSign, imaginary.current * e.currentSign),
      power: undetermined ? null : power,
    };
  }));
  return { mode, frequency, nodes, branches, G, E, J, solution: re.map((value, i) => unknown.has(i) ? null : complex(value, im[i])),
    rhs: mode === 'ac' ? system.acRe.map((r, i) => complex(r, system.acIm[i])) : dc.map(r => complex(r)),
    names: system.names, reference: system.reference, kcl: Math.max(0, ...residuals.slice(0, system.nodes.length)),
    laws: Math.max(0, ...residuals.slice(system.nodes.length)), power: totalPower, redundant: unknown.size > 0 };
}

function requireFrequencyModel(doc, operation) {
  if (doc.elements.some(e => e.type === 'Z')) throw Error(`${operation}需要随频率定义的元件。当前复阻抗只适用于给定工况的正弦稳态。`);
}

export function transient(doc, { duration = .05, points = 241, node, negative, response = 'full' } = {}) {
  if (!(duration > 0 && Number.isFinite(duration)) || points < 3 || points > 2001 || !Number.isInteger(points)) throw Error('请输入有效的仿真时长与采样点数。');
  if (doc.elements.some(e => e.type === 'V3')) throw Error('三相电源请用正弦稳态分析。');
  requireFrequencyModel(doc, '时域分析');
  const sy = buildSystem(doc, null, response === 'zeroInput');
  const { G, E, dc, initial } = sy;
  if (!initial.length) throw Error('时域响应需要至少一个电容或电感。');
  const output = [sy.index(node), sy.index(negative ?? sy.reference)];
  const A0 = G.map(row => [...row]);
  const b0 = [...dc];
  for (const { row, entries, value } of initial) {
    A0[row].fill(0);
    for (const [i, factor] of entries) if (i >= 0) A0[row][i] += factor;
    b0[row] = response === 'zeroState' ? 0 : value;
  }
  let x = linearSolve(A0, b0);
  const step = duration / (points - 1);
  const lhs = combine(G, E, 2 / step);
  const prev = combine(G, E, -2 / step);
  const samples = [{ x: 0, y: difference(x, output) }];
  let residual = 0;
  for (let k = 1; k < points; k++) {
    const next = linearSolve(lhs, dc.map((value, i) => 2 * value - dot(prev[i], x)));
    residual = Math.max(residual, ...lhs.map((row, i) => Math.abs(dot(row, next) + dot(prev[i], x) - 2 * dc[i])));
    x = next;
    samples.push({ x: k * step, y: difference(x, output) });
  }
  return { samples, residual, step, response, initial: initial.map(({ e }) => ({ name: e.name, type: e.type, value: response === 'zeroState' ? 0 : e.initial })) };
}

function determinant(input) {
  const A = input.map(row => [...row]);
  let result = 1;
  for (let j = 0; j < A.length; j++) {
    let pivot = j;
    for (let i = j + 1; i < A.length; i++) if (Math.abs(A[i][j]) > Math.abs(A[pivot][j])) pivot = i;
    if (A[pivot][j] === 0) return 0;
    if (pivot !== j) { [A[pivot], A[j]] = [A[j], A[pivot]]; result *= -1; }
    result *= A[j][j];
    for (let i = j + 1; i < A.length; i++) {
      const factor = A[i][j] / A[j][j];
      for (let k = j + 1; k < A.length; k++) A[i][k] -= factor * A[j][k];
    }
  }
  return result;
}

function polynomial(G, E) {
  const changing = E.flatMap((row, i) => row.some(Boolean) ? [i] : []);
  const coefficients = zeros(changing.length + 1);
  for (let mask = 0; mask < 2 ** changing.length; mask++) {
    const selected = changing.filter((_, j) => mask & (1 << j));
    coefficients[selected.length] += determinant(G.map((row, i) => selected.includes(i) ? E[i] : row));
  }
  while (coefficients.length > 1 && coefficients.at(-1) === 0) coefficients.pop();
  return coefficients;
}

function roots(coeffs) {
  const [c, b, a] = coeffs;
  if (a === undefined) return b ? [complex(-c / b)] : [];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [complex(-b / (2 * a), Math.sqrt(-disc) / Math.abs(2 * a)), complex(-b / (2 * a), -Math.sqrt(-disc) / Math.abs(2 * a))];
  const q = -(b + (Math.sign(b) || 1) * Math.sqrt(disc)) / 2;
  return q === 0 ? [complex(0), complex(0)] : [complex(q / a), complex(c / q)];
}

export function transfer(doc, { source, node, negative, start = 10, stop = 1e6, points = 121 } = {}) {
  requireFrequencyModel(doc, '扫频');
  if (!doc.elements.some(e => e.id === source && ['V', 'I'].includes(e.type))) throw Error('请选择单个独立电压源或电流源作为输入。');
  if (!doc.nodes.some(n => n.id === node)) throw Error('请选择输出节点。');
  if (!(start > 0 && stop > start && Number.isFinite(stop)) || !Number.isInteger(points) || points < 2 || points > 501) throw Error('扫频终点必须大于起点，且两者都大于零。');
  const sy = buildSystem(doc, source);
  const output = [sy.index(node), sy.index(negative ?? sy.reference)];
  const samples = Array.from({ length: points }, (_, i) => {
    const x = start * (stop / start) ** (i / (points - 1));
    const { re, im } = frequencySolution(sy, x);
    const value = complex(difference(re, output), difference(im, output));
    return { x, y: Math.max(-300, 20 * Math.log10(value.magnitude)), phase: value.angle, ...value };
  });
  let rational = null;
  if (sy.initial.length <= 2 && sy.G.length <= 24) {
    const d = polynomial(sy.G, sy.E);
    const ns = output.map(col => col < 0 ? [0] : polynomial(
      sy.G.map((row, i) => row.map((v, j) => j === col ? sy.dc[i] : v)),
      sy.E.map(row => row.map((v, j) => j === col ? 0 : v)),
    ));
    const n = Array.from({ length: Math.max(...ns.map(p => p.length)) }, (_, i) => (ns[0][i] || 0) - (ns[1][i] || 0));
    while (n.length > 1 && n.at(-1) === 0) n.pop();
    const scale = d.at(-1);
    if (Number.isFinite(scale) && scale !== 0) rational = { numerator: n.map(c => c / scale), denominator: d.map(c => c / scale), poles: roots(d), zeros: roots(n) };
  }
  return { samples, rational, unit: doc.elements.find(e => e.id === source).type === 'I' ? 'Ω' : '' };
}

function portVoltage(system, x, pair) {
  return read(x, system.index(pair[0])) - read(x, system.index(pair[1]));
}

function portSystem(doc, ports, excited = null, amplitude = 1) {
  const model = clone(doc);
  for (const e of model.elements) if (['V', 'I', 'V3'].includes(e.type)) { e.value = 0; e.ac = 0; }
  if (excited !== null) {
    const [p, n] = ports[excited];
    addElement(model, 'I', { terminals: { p: n, n: p }, value: amplitude, ac: Math.abs(amplitude), phase: amplitude < 0 ? 180 : 0 });
  }
  return buildSystem(model);
}

export function twoPort(doc, ports, frequency = 0) {
  if (!frequency) requireFrequencyModel(doc, '直流二端口分析');
  if (ports.length !== 2 || ports.some(([p, n]) => p === n || ![p, n].every(id => doc.nodes.some(node => node.id === id)))) throw Error('请为两个端口各选择两个不同节点。');
  const columns = ports.map((_, i) => {
    const system = portSystem(doc, ports, i);
    const solution = frequency > 0 ? frequencySolution(system, frequency) : { re: linearSolve(system.G, system.dc), im: zeros(system.G.length) };
    return ports.map(pair => complex(portVoltage(system, solution.re, pair), portVoltage(system, solution.im, pair)));
  });
  return [0, 1].map(r => [columns[0][r], columns[1][r]]);
}

export function thevenin(doc, p, n) {
  requireFrequencyModel(doc, '直流端口分析');
  if (p === n || ![p, n].every(id => doc.nodes.some(node => node.id === id))) throw Error('请选择两个不同的端口节点。');
  const sy = buildSystem(doc);
  const voltage = portVoltage(sy, linearSolve(sy.G, sy.dc), [p, n]);
  const test = portSystem(doc, [[p, n]], 0);
  const resistance = portVoltage(test, linearSolve(test.G, test.dc), [p, n]);
  const contributions = doc.elements.filter(e => ['V', 'I'].includes(e.type)).map(e => {
    const isolated = buildSystem(doc, e.id);
    return { name: e.name, value: e.value * portVoltage(isolated, linearSolve(isolated.G, isolated.dc), [p, n]) };
  });
  return { voltage, resistance, norton: resistance ? voltage / resistance : null,
    maxPower: resistance > 0 ? voltage ** 2 / (4 * resistance) : null,
    contributions, residual: Math.abs(voltage - contributions.reduce((sum, v) => sum + v.value, 0)) };
}

export function acThevenin(doc, p, n, frequency) {
  if (p === n || ![p, n].every(id => doc.nodes.some(node => node.id === id))) throw Error('请选择两个不同的端口节点。');
  if (!(frequency > 0 && Number.isFinite(frequency))) throw Error('请填写正弦稳态频率。');
  const port = [p, n];
  function measurement(system) {
    const { re, im } = frequencySolution(system, frequency);
    return complex(portVoltage(system, re, port), portVoltage(system, im, port));
  }
  const voltage = measurement(buildSystem(doc));
  const impedance = measurement(portSystem(doc, [port], 0));
  return { voltage, impedance, norton: impedance.magnitude ? divideComplex(voltage, impedance) : null,
    load: impedance.re > 0 ? complex(impedance.re, -impedance.im) : null,
    maxPower: impedance.re > 0 ? voltage.magnitude ** 2 / (4 * impedance.re) : null };
}

export function graphEquations(doc) {
  const edges = doc.elements.filter(e => TYPES[e.type].pins.length === 2 && e.type !== 'OPEN');
  const nodes = doc.nodes.map(n => n.id);
  const incidence = nodes.map(n => edges.map(e => Number(e.terminals.p === n) - Number(e.terminals.n === n)));
  const tree = new Map(nodes.map(n => [n, []]));
  const loops = [];
  const treeEdges = [];
  const chords = [];
  const path = (from, to, seen = new Set()) => {
    if (from === to) return [];
    if (seen.has(from)) return null;
    seen.add(from);
    for (const [next, i, sign] of tree.get(from)) {
      const suffix = path(next, to, seen);
      if (suffix) return [[i, sign], ...suffix];
    }
    return null;
  };
  for (const [i, e] of edges.entries()) {
    const { p, n } = e.terminals;
    const route = path(n, p);
    if (route) {
      const row = zeros(edges.length);
      row[i] = 1;
      for (const [j, sign] of route) row[j] = sign;
      loops.push(row);
      chords.push(i);
    } else {
      tree.get(p).push([n, i, 1]);
      tree.get(n).push([p, i, -1]);
      treeEdges.push(i);
    }
  }
  const loopResiduals = (() => {
    try {
      const result = solve(doc);
      return loops.map(row => dot(row, edges.map(e => result.branches.find(b => b.id === e.id).voltage.re * e.voltageSign)));
    } catch { return null; }
  })();
  const branchNames = edges.map(e => e.name);
  const loopsText = loops.map(row => row.flatMap((v, i) => v ? [`${v > 0 ? '+' : '−'} v(${branchNames[i]})`] : []).join(' ').replace(/^\+ /, '') + ' = 0');
  const cutsets = treeEdges.map(i => edges.map((_, j) => i === j ? 1 : chords.includes(j) ? -loops[chords.indexOf(j)][i] : 0));
  return { nodes, branches: branchNames, incidence, loops, cutsets, loopsText, loopResiduals, chords };
}

export function branchMethod(doc, method = 'branch') {
  assertValid(doc);
  if (doc.elements.some(e => !['R', 'V', 'I', 'SHORT', 'OPEN', 'L', 'C', 'GND'].includes(e.type))) {
    throw Error('此教学方法支持独立源与双端无源元件。多端与受控网络请选择节点电压法。');
  }
  const reduced = { ...doc, elements: doc.elements.filter(e => !['OPEN', 'C'].includes(e.type)) };
  const { loops, cutsets } = graphEquations(reduced);
  const edges = reduced.elements.filter(e => e.type !== 'GND');
  if (!edges.length) throw Error('没有直流导通支路。');
  const resistance = edges.map(e => e.type === 'R' ? e.value : 0);
  const sourceVoltage = edges.map(e => e.type === 'V' ? e.value : 0);
  const currentSources = edges.flatMap((e, i) => e.type === 'I' ? [i] : []);
  const branchNames = edges.map(e => e.name);
  const sourceVarNames = currentSources.map(i => `v(${edges[i].name})`);
  const weighted = (i, j) => loops[i].reduce((sum, a, k) => sum + a * resistance[k] * loops[j][k], 0);
  const span = method === 'loop' ? loops.length : edges.length;
  let A;
  let rhs;
  let names;
  if (method === 'loop') {
    A = loops.map((row, i) => [...loops.map((_, j) => weighted(i, j)), ...currentSources.map(j => row[j])]);
    A.push(...currentSources.map(i => [...loops.map(row => row[i]), ...zeros(currentSources.length)]));
    rhs = [...loops.map(row => -dot(row, sourceVoltage)), ...currentSources.map(i => edges[i].value)];
    names = [...loops.map((_, i) => `i回路 ${i + 1}`), ...sourceVarNames];
  } else {
    A = cutsets.map(row => [...row, ...zeros(currentSources.length)]);
    A.push(...loops.map(row => [...row.map((a, i) => a * resistance[i]), ...currentSources.map(i => row[i])]));
    A.push(...currentSources.map(i => [...edges.map((_, k) => Number(i === k)), ...zeros(currentSources.length)]));
    rhs = [...zeros(cutsets.length), ...loops.map(row => -dot(row, sourceVoltage)), ...currentSources.map(i => edges[i].value)];
    names = [...branchNames.map(name => `i(${name})`), ...sourceVarNames];
  }
  let x;
  try { x = linearSolve(A, rhs); }
  catch { throw Error('无法从这些回路约束得到唯一解。请检查开路的电流源或重复的零阻抗支路。'); }
  const i = method === 'loop' ? edges.map((_, j) => loops.reduce((sum, row, k) => sum + row[j] * x[k], 0)) : x.slice(0, span);
  const v = i.map((value, j) => resistance[j] * value + sourceVoltage[j]);
  currentSources.forEach((j, k) => { v[j] = x[span + k]; });
  return { A, rhs, names, x, kcl: Math.max(0, ...cutsets.map(row => Math.abs(dot(row, i)))),
    kvl: Math.max(0, ...loops.map(row => Math.abs(dot(row, v)))),
    branches: edges.map((e, j) => ({ name: e.name, current: i[j] * e.currentSign, voltage: v[j] * e.voltageSign })) };
}

const multiplyComplex = (a, b) => complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const subtractComplex = (a, b) => complex(a.re - b.re, a.im - b.im);
function divideComplex(a, b) {
  const d = b.re ** 2 + b.im ** 2;
  return complex((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}

export function portParameters(z) {
  const [[a, b], [c, d]] = z;
  const determinant = subtractComplex(multiplyComplex(a, d), multiplyComplex(b, c));
  const reciprocal = n => divideComplex(complex(1), n);
  const neg = n => complex(-n.re, -n.im);
  return {
    z,
    y: determinant.magnitude > Math.max(a.magnitude * d.magnitude, b.magnitude * c.magnitude) * 1e-12
      ? [[d, neg(b)], [neg(c), a]].map(row => row.map(n => divideComplex(n, determinant))) : null,
    h: d.magnitude ? [[divideComplex(determinant, d), divideComplex(b, d)], [divideComplex(neg(c), d), reciprocal(d)]] : null,
    abcd: c.magnitude ? [[divideComplex(a, c), divideComplex(determinant, c)], [reciprocal(c), divideComplex(d, c)]] : null,
  };
}

export function periodic(doc, { source, node, negative, waveform = 'square', frequency = 100, amplitude = 1, terms = 12 } = {}) {
  requireFrequencyModel(doc, '傅里叶周期分析');
  if (!(frequency > 0 && Number.isFinite(frequency)) || !Number.isFinite(amplitude) || !Number.isInteger(terms) || terms < 1 || terms > 31) throw Error('请检查基波频率、峰值和奇次谐波的项数。');
  if (!['square', 'triangle'].includes(waveform)) throw Error('只支持方波与三角波。');
  if (!doc.elements.some(e => e.id === source && ['V', 'I'].includes(e.type))) throw Error('请选择独立激励源。');
  if (!doc.nodes.some(n => n.id === node)) throw Error('请选择输出端。');
  const sy = buildSystem(doc, source);
  const output = [sy.index(node), sy.index(negative ?? sy.reference)];
  const harmonics = Array.from({ length: terms }, (_, i) => {
    const order = 2 * i + 1;
    const input = waveform === 'square' ? 4 * amplitude * (-1) ** i / (Math.PI * order) : 8 * amplitude / (Math.PI * order) ** 2;
    const { re, im } = frequencySolution(sy, order * frequency);
    return { order, input, output: complex(input * difference(re, output), input * difference(im, output)) };
  });
  const samples = Array.from({ length: 401 }, (_, i) => {
    const t = i / 200;
    return { x: t / frequency,
      input: harmonics.reduce((sum, h) => sum + h.input * Math.cos(2 * Math.PI * h.order * t), 0),
      y: harmonics.reduce((sum, h) => sum + h.output.re * Math.cos(2 * Math.PI * h.order * t) - h.output.im * Math.sin(2 * Math.PI * h.order * t), 0) };
  });
  return { harmonics, samples, frequency, inputUnit: TYPES[doc.elements.find(e => e.id === source).type].unit };
}

export function impulseResponse(doc, { source, node, negative, duration = .05, points = 241 } = {}) {
  if (!(duration > 0 && Number.isFinite(duration)) || !Number.isInteger(points) || points < 3 || points > 2001) throw Error('请输入有效的仿真时长与采样点数。');
  const { rational, unit } = transfer(doc, { source, node, negative, start: 1, stop: 2, points: 2 });
  if (!rational || rational.numerator.length > rational.denominator.length) throw Error('冲激响应支持包含至多两个独立储能元件的真有理或等阶网络函数。');
  const { numerator, denominator, poles } = rational;
  const order = denominator.length - 1;
  const feedthrough = numerator[order] || 0;
  const a = (numerator[0] || 0) - feedthrough * denominator[0];
  const b = (numerator[1] || 0) - feedthrough * (denominator[1] || 0);
  const calculate = t => {
    if (order === 0) return 0;
    if (order === 1) return a * Math.exp(poles[0].re * t);
    const [p, q] = poles;
    if (p.im) return Math.exp(p.re * t) * (b * Math.cos(p.im * t) + (a + b * p.re) / p.im * Math.sin(p.im * t));
    if (Math.abs(p.re - q.re) < 1e-7 * Math.max(1, Math.abs(p.re), Math.abs(q.re))) return (b + (a + b * p.re) * t) * Math.exp(p.re * t);
    return ((a + b * p.re) * Math.exp(p.re * t) - (a + b * q.re) * Math.exp(q.re * t)) / (p.re - q.re);
  };
  const samples = Array.from({ length: points }, (_, i) => {
    const x = duration * i / (points - 1);
    const y = calculate(x);
    if (!Number.isFinite(y)) throw Error('响应超出数值范围。请缩短计算时长。');
    return { x, y };
  });
  return { samples, feedthrough, unit, rational, kind: 'impulse' };
}

export function pulseResponse(doc, options) {
  const { duration, width } = options;
  if (!(width > 0 && width < duration)) throw Error('脉冲宽度必须大于零且小于仿真时长。');
  const impulse = impulseResponse(doc, { ...options, points: 601 });
  const step = impulse.samples[1].x;
  if (width < step * 3) throw Error('脉冲过窄。请缩短仿真时长以提高时间分辨率。');
  const cumulative = [0];
  for (let i = 1; i < impulse.samples.length; i++) cumulative.push(cumulative[i - 1] + step / 2 * (impulse.samples[i - 1].y + impulse.samples[i].y));
  function area(t) {
    if (t < 0) return 0;
    const i = Math.floor(t / step);
    const a = cumulative[i] ?? cumulative.at(-1);
    const b = cumulative[i + 1] ?? a;
    return a + (b - a) * (t / step - i);
  }
  return { ...impulse, kind: 'pulse', width, samples: impulse.samples.map(({ x }) => ({
    x, y: area(x) - area(x - width) + (x < width ? impulse.feedthrough : 0),
  })) };
}
