import { assertValid, clone, referenceNode } from './model.js';
import { solve } from './analysis.js';

const C = (re = 0, im = 0) => ({ re, im });
const cAdd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const cSub = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
const cMul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cAbs = a => Math.hypot(a.re, a.im);
const cDiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  if (d < 1e-30) throw Error('复数除法分母为零。');
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

/**
 * Independent complex Gaussian elimination with partial pivoting and row equilibration.
 * Completely independent from reduction formulas.
 */
function complexSolve(A, b) {
  const n = b.length;
  if (n === 0) return [];
  const M = A.map((row, i) => {
    const scale = Math.max(...row.map(cAbs), 0);
    if (scale === 0) return [...row.map(x => C(x.re, x.im)), C(b[i].re, b[i].im)];
    return [...row.map(x => C(x.re / scale, x.im / scale)), C(b[i].re / scale, b[i].im / scale)];
  });
  for (let k = 0; k < n; k++) {
    let pivot = k;
    let best = cAbs(M[k][k]);
    for (let i = k + 1; i < n; i++) {
      const mag = cAbs(M[i][k]);
      if (mag > best) { best = mag; pivot = i; }
    }
    if (best < 1e-13) throw Error('独立验证求解器遇到奇异矩阵。');
    if (pivot !== k) [M[k], M[pivot]] = [M[pivot], M[k]];
    const diag = M[k][k];
    for (let i = k + 1; i < n; i++) {
      if (cAbs(M[i][k]) === 0) continue;
      const factor = cDiv(M[i][k], diag);
      M[i][k] = C(0, 0);
      for (let j = k + 1; j <= n; j++) {
        M[i][j] = cSub(M[i][j], cMul(factor, M[k][j]));
      }
    }
  }
  const x = Array.from({ length: n }, () => C(0, 0));
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) sum = cSub(sum, cMul(M[i][j], x[j]));
    x[i] = cDiv(sum, M[i][i]);
    if (!Number.isFinite(x[i].re) || !Number.isFinite(x[i].im)) throw Error('独立验证求解结果溢出。');
  }
  return x;
}

/**
 * Independent complex MNA solver for a local multi-port subnetwork.
 * Measures either (Y, I_sc) via port voltage clamping or (Z, V_oc) via port current injection.
 */
function solveSubnetworkMna(elements, ports, { mode = 'dc', omega = 0, clampVoltages = null, injectCurrents = null, muteSources = false } = {}) {
  const ref = ports.at(-1);
  const allNodes = [...new Set([...ports, ...elements.flatMap(e => Object.values(e.terminals))])];
  const activeNodes = allNodes.filter(n => n !== ref);
  const nodeIdx = new Map(activeNodes.map((n, i) => [n, i]));
  const idx = n => nodeIdx.get(n) ?? -1;

  // Allocate auxiliary branch currents for voltage-constrained elements and port clamps
  const auxVars = [];
  const elemAux = new Map();
  for (const e of elements) {
    if (['V', 'SHORT'].includes(e.type) || (e.type === 'L' && mode === 'dc')) {
      elemAux.set(e.id, auxVars.length);
      auxVars.push(`e:${e.id}`);
    }
  }
  const clampAux = [];
  if (clampVoltages) {
    for (let p = 0; p < ports.length - 1; p++) {
      clampAux.push(auxVars.length);
      auxVars.push(`clamp:${p}`);
    }
  }

  const N = activeNodes.length + auxVars.length;
  const A = Array.from({ length: N }, () => Array.from({ length: N }, () => C(0, 0)));
  const b = Array.from({ length: N }, () => C(0, 0));
  const stamp = (r, c, val) => { if (r >= 0 && c >= 0) A[r][c] = cAdd(A[r][c], val); };
  const stampRhs = (r, val) => { if (r >= 0) b[r] = cAdd(b[r], val); };

  const sourcePhasor = e => {
    if (muteSources) return C(0, 0);
    if (mode === 'dc') return C(e.value, 0);
    const amp = e.ac ?? e.value;
    const rad = (e.phase || 0) * Math.PI / 180;
    return C(amp * Math.cos(rad), amp * Math.sin(rad));
  };

  for (const e of elements) {
    if (e.type === 'GND' || e.type === 'OPEN') continue;
    const ip = idx(e.terminals.p);
    const in_ = idx(e.terminals.n);
    if (e.type === 'R') {
      const y = C(1 / e.value, 0);
      stamp(ip, ip, y); stamp(in_, in_, y);
      stamp(ip, in_, C(-y.re, 0)); stamp(in_, ip, C(-y.re, 0));
    } else if (e.type === 'Z') {
      const y = cDiv(C(1, 0), C(e.value, e.reactance || 0));
      stamp(ip, ip, y); stamp(in_, in_, y);
      stamp(ip, in_, C(-y.re, -y.im)); stamp(in_, ip, C(-y.re, -y.im));
    } else if (e.type === 'C') {
      if (mode === 'ac' && omega > 0) {
        const y = C(0, omega * e.value);
        stamp(ip, ip, y); stamp(in_, in_, y);
        stamp(ip, in_, C(0, -y.im)); stamp(in_, ip, C(0, -y.im));
      }
    } else if (e.type === 'L') {
      if (mode === 'ac' && omega > 0) {
        const y = C(0, -1 / (omega * e.value));
        stamp(ip, ip, y); stamp(in_, in_, y);
        stamp(ip, in_, C(0, -y.im)); stamp(in_, ip, C(0, -y.im));
      } else {
        // DC steady state: inductor is a short circuit
        const row = activeNodes.length + elemAux.get(e.id);
        stamp(ip, row, C(1, 0)); stamp(in_, row, C(-1, 0));
        stamp(row, ip, C(1, 0)); stamp(row, in_, C(-1, 0));
      }
    } else if (e.type === 'SHORT' || e.type === 'V') {
      const row = activeNodes.length + elemAux.get(e.id);
      stamp(ip, row, C(1, 0)); stamp(in_, row, C(-1, 0));
      stamp(row, ip, C(1, 0)); stamp(row, in_, C(-1, 0));
      if (e.type === 'V') stampRhs(row, sourcePhasor(e));
    } else if (e.type === 'I') {
      const s = sourcePhasor(e);
      stampRhs(ip, C(-s.re, -s.im));
      stampRhs(in_, s);
    }
  }

  if (clampVoltages) {
    for (let p = 0; p < ports.length - 1; p++) {
      const row = activeNodes.length + clampAux[p];
      const pi = idx(ports[p]);
      stamp(pi, row, C(1, 0));
      stamp(row, pi, C(1, 0));
      stampRhs(row, clampVoltages[p]);
    }
  }

  if (injectCurrents) {
    for (let p = 0; p < ports.length - 1; p++) {
      const pi = idx(ports[p]);
      stampRhs(pi, injectCurrents[p]);
    }
  }

  const sol = complexSolve(A, b);
  const portVoltages = ports.slice(0, -1).map(p => (idx(p) >= 0 ? sol[idx(p)] : C(0, 0)));
  // Clamp current entering the subnetwork at port p is -I_clamp (since clamp equation stamped +1 into KCL at p)
  const clampCurrents = clampVoltages
    ? clampAux.map(k => {
      const iClamp = sol[activeNodes.length + k];
      return C(-iClamp.re, -iClamp.im);
    })
    : null;
  return { portVoltages, clampCurrents };
}

/**
 * Characterize a multi-port subnetwork independently via either Admittance (Y, I_sc) or Impedance (Z, V_oc).
 */
function characterizePortSubnetwork(elements, ports, { mode = 'dc', omega = 0 } = {}) {
  const m = ports.length - 1;
  if (m <= 0) return { kind: 'trivial', matrix: [], vector: [] };
  // Prefer admittance characterization (works for passive networks, Norton/Thevenin with R, Δ/Y)
  try {
    const sc = solveSubnetworkMna(elements, ports, {
      mode, omega, clampVoltages: Array.from({ length: m }, () => C(0, 0)), muteSources: false,
    });
    const Y = Array.from({ length: m }, () => Array.from({ length: m }, () => C(0, 0)));
    for (let col = 0; col < m; col++) {
      const v = Array.from({ length: m }, (_, i) => C(i === col ? 1 : 0, 0));
      const res = solveSubnetworkMna(elements, ports, { mode, omega, clampVoltages: v, muteSources: true });
      for (let row = 0; row < m; row++) Y[row][col] = res.clampCurrents[row];
    }
    return { kind: 'admittance', matrix: Y, vector: sc.clampCurrents };
  } catch {
    // Fall back to impedance characterization (e.g. series voltage sources without series resistance)
    const oc = solveSubnetworkMna(elements, ports, {
      mode, omega, injectCurrents: Array.from({ length: m }, () => C(0, 0)), muteSources: false,
    });
    const Z = Array.from({ length: m }, () => Array.from({ length: m }, () => C(0, 0)));
    for (let col = 0; col < m; col++) {
      const cur = Array.from({ length: m }, (_, i) => C(i === col ? 1 : 0, 0));
      const res = solveSubnetworkMna(elements, ports, { mode, omega, injectCurrents: cur, muteSources: true });
      for (let row = 0; row < m; row++) Z[row][col] = res.portVoltages[row];
    }
    return { kind: 'impedance', matrix: Z, vector: oc.portVoltages };
  }
}

function compareComplexCollections(aList, bList) {
  let maxErr = 0;
  let maxScale = 1e-12;
  for (let i = 0; i < aList.length; i++) {
    const err = cAbs(cSub(aList[i], bList[i]));
    maxErr = Math.max(maxErr, err);
    maxScale = Math.max(maxScale, cAbs(aList[i]), cAbs(bList[i]));
  }
  return { maxErr, relativeErr: maxErr / maxScale, scale: maxScale };
}

/**
 * Verify local subnetwork multi-port equivalence independently.
 */
function verifySubnetworkPorts(beforeElements, afterElements, ports, { tolerance = 1e-8 } = {}) {
  const uniquePorts = [...new Set(ports)];
  if (uniquePorts.length < 2) {
    return { scope: 'port', passed: true, residual: 0, label: '单节点边界无需端口矩阵校验' };
  }
  const allElems = [...beforeElements, ...afterElements];
  const hasZ = allElems.some(e => e.type === 'Z');
  const hasDynamic = allElems.some(e => ['L', 'C'].includes(e.type));
  const hasAcSource = allElems.some(e => ['V', 'I'].includes(e.type) && (e.ac !== null || e.phase !== 0));

  const regimes = [];
  if (hasZ) {
    regimes.push({ mode: 'ac', omega: 2 * Math.PI * 50, tag: 'AC(Z)' });
  } else if (hasDynamic) {
    for (const omega of [10, 1000, 100000]) regimes.push({ mode: 'ac', omega, tag: `AC(ω=${omega})` });
  } else {
    regimes.push({ mode: 'dc', omega: 0, tag: 'DC' });
    if (hasAcSource) regimes.push({ mode: 'ac', omega: 2 * Math.PI * 1000, tag: 'AC(1kHz)' });
  }

  let worstResidual = 0;
  let kindUsed = 'admittance';
  for (const regime of regimes) {
    const beforeChar = characterizePortSubnetwork(beforeElements, uniquePorts, regime);
    const afterChar = characterizePortSubnetwork(afterElements, uniquePorts, regime);
    if (beforeChar.kind !== afterChar.kind) {
      return {
        scope: 'port',
        passed: false,
        residual: Infinity,
        label: `端口表征类型不一致（${beforeChar.kind} vs ${afterChar.kind}）`,
      };
    }
    kindUsed = beforeChar.kind;
    const matCmp = compareComplexCollections(beforeChar.matrix.flat(), afterChar.matrix.flat());
    const vecCmp = compareComplexCollections(beforeChar.vector, afterChar.vector);
    worstResidual = Math.max(worstResidual, matCmp.relativeErr, vecCmp.relativeErr);
  }

  const passed = Number.isFinite(worstResidual) && worstResidual <= tolerance;
  const kindLabel = kindUsed === 'admittance' ? '独立端口导纳/诺顿矩阵一致' : '独立端口阻抗/戴维南特性一致';
  return {
    scope: 'port',
    passed,
    residual: worstResidual,
    regimes: regimes.map(r => r.tag),
    label: passed ? kindLabel : `${kindLabel}校验失败（相对误差 ${worstResidual.toExponential(2)}）`,
  };
}

/**
 * Verify full-circuit external electrical equivalence using the full MNA solver.
 * Compares all retained node voltages and retained branch currents/voltages before vs after.
 */
function verifyFullCircuit(beforeDoc, afterDoc, { removedIds = [], addedIds = [], mergedNodeMap = null, tolerance = 1e-8 } = {}) {
  const afterNodeIds = new Set(afterDoc.nodes.map(n => n.id));
  const mapNode = id => (mergedNodeMap && mergedNodeMap.has(id) ? mergedNodeMap.get(id) : id);

  // Align reference node between before and after if both have a common reference
  const refBefore = referenceNode(beforeDoc);
  const refAfter = referenceNode(afterDoc);
  const retainedNodes = beforeDoc.nodes
    .map(n => n.id)
    .filter(id => afterNodeIds.has(mapNode(id)));
  const removedSet = new Set(removedIds);
  const addedSet = new Set(addedIds);
  const sameElementSpec = (a, b) => a.type === b.type
    && a.value === b.value
    && (a.reactance ?? 0) === (b.reactance ?? 0)
    && (a.ac ?? null) === (b.ac ?? null)
    && (a.phase ?? 0) === (b.phase ?? 0)
    && (a.initial ?? 0) === (b.initial ?? 0)
    && Object.keys(a.terminals).every(pin => mapNode(a.terminals[pin]) === b.terminals[pin]);

  const retainedElements = beforeDoc.elements
    .filter(e => {
      if (e.type === 'GND' || removedSet.has(e.id)) return false;
      const match = afterDoc.elements.find(a => a.id === e.id && !addedSet.has(a.id));
      return match && sameElementSpec(e, match);
    })
    .map(e => e.id);

  // Full-circuit MNA is meaningful when the circuit has at least one independent source
  const hasSource = beforeDoc.elements.some(e => ['V', 'I', 'V3'].includes(e.type))
    && afterDoc.elements.some(e => ['V', 'I', 'V3'].includes(e.type));
  if (!hasSource) return [];

  // Determine which operating modes to test
  const hasV3 = beforeDoc.elements.some(e => e.type === 'V3') || afterDoc.elements.some(e => e.type === 'V3');
  const hasZ = beforeDoc.elements.some(e => e.type === 'Z') || afterDoc.elements.some(e => e.type === 'Z');
  const hasL = beforeDoc.elements.some(e => e.type === 'L') || afterDoc.elements.some(e => e.type === 'L');
  const hasDynamic = hasL || beforeDoc.elements.some(e => e.type === 'C') || afterDoc.elements.some(e => e.type === 'C');
  const hasAc = hasV3 || hasZ || beforeDoc.elements.some(e => ['V', 'I'].includes(e.type) && e.ac !== null);

  const modesToTry = [];
  if (!hasV3 && !hasZ && !hasL) modesToTry.push({ mode: 'dc', frequency: 1000 });
  if (hasAc || hasDynamic) {
    modesToTry.push({ mode: 'ac', frequency: 50 });
    if (hasDynamic && !hasZ) modesToTry.push({ mode: 'ac', frequency: 1000 });
  }

  const checks = [];
  for (const { mode, frequency } of modesToTry) {
    let solBefore;
    let solAfter;
    try {
      solBefore = solve(beforeDoc, mode, frequency);
    } catch {
      // Circuit before transformation is not globally solvable in this mode (e.g., sourceless passive network)
      continue;
    }
    try {
      solAfter = solve(afterDoc, mode, frequency);
    } catch (err) {
      checks.push({
        scope: 'fullCircuit',
        mode,
        frequency,
        passed: false,
        residual: Infinity,
        detail: `变换后全电路在 ${mode.toUpperCase()} 工况下无法求解：${err.message}`,
      });
      continue;
    }

    // Compare voltage differences relative to a common retained reference node (handles reference shift gracefully)
    const commonRef = retainedNodes.includes(refBefore) && mapNode(refBefore) === refAfter
      ? refBefore
      : retainedNodes[0];
    const vOf = (sol, id) => sol.nodes.find(n => n.id === id)?.voltage ?? { re: 0, im: 0 };
    const refVb = commonRef ? vOf(solBefore, commonRef) : { re: 0, im: 0 };
    const refVa = commonRef ? vOf(solAfter, mapNode(commonRef)) : { re: 0, im: 0 };

    let maxErr = 0;
    let maxScale = 1;
    let nodesChecked = 0;
    for (const id of retainedNodes) {
      const vb = cSub(vOf(solBefore, id), refVb);
      const va = cSub(vOf(solAfter, mapNode(id)), refVa);
      maxErr = Math.max(maxErr, cAbs(cSub(vb, va)));
      maxScale = Math.max(maxScale, cAbs(vb), cAbs(va));
      nodesChecked++;
    }

    let branchesChecked = 0;
    for (const eid of retainedElements) {
      const bsBefore = solBefore.branches.filter(b => b.id === eid);
      const bsAfter = solAfter.branches.filter(b => b.id === eid);
      for (let i = 0; i < Math.min(bsBefore.length, bsAfter.length); i++) {
        const bb = bsBefore[i];
        const ba = bsAfter[i];
        maxErr = Math.max(maxErr, cAbs(cSub(bb.voltage, ba.voltage)));
        maxScale = Math.max(maxScale, cAbs(bb.voltage), cAbs(ba.voltage));
        if (bb.current && ba.current) {
          maxErr = Math.max(maxErr, cAbs(cSub(bb.current, ba.current)));
          maxScale = Math.max(maxScale, cAbs(bb.current), cAbs(ba.current));
        }
        branchesChecked++;
      }
    }

    const relativeErr = maxErr / maxScale;
    const passed = Number.isFinite(relativeErr) && relativeErr <= tolerance;
    checks.push({
      scope: 'fullCircuit',
      mode,
      frequency: mode === 'ac' ? frequency : null,
      nodesChecked,
      branchesChecked,
      residual: relativeErr,
      passed,
      detail: passed
        ? `全电路 ${mode.toUpperCase()}${mode === 'ac' ? `(${frequency}Hz)` : ''} 校验通过（${nodesChecked} 节点、${branchesChecked} 支路一致）`
        : `全电路 ${mode.toUpperCase()} 校验失败（相对误差 ${relativeErr.toExponential(2)}）`,
    });
  }

  return checks;
}

/**
 * Independent electrical equivalence verifier for a single reduction step or any pair of circuits.
 */
export function verifyEquivalence(beforeDoc, afterDoc, options = {}) {
  const {
    rule = 'general',
    removedIds = [],
    addedIds = [],
    ports = [],
    tolerance = 1e-8,
    mergedNodeMap = null,
  } = options;

  assertValid(beforeDoc);
  assertValid(afterDoc);

  const checks = [];

  // Level A: Full-circuit independent MNA check
  const fullChecks = verifyFullCircuit(beforeDoc, afterDoc, {
    removedIds, addedIds, mergedNodeMap, tolerance,
  });
  checks.push(...fullChecks);

  // Level B: Local multi-port subnetwork independent check (for local transformations)
  if (removedIds.length || addedIds.length) {
    const oldElems = beforeDoc.elements.filter(e => removedIds.includes(e.id));
    const newElems = afterDoc.elements.filter(e => addedIds.includes(e.id));
    if (['open', 'dangling'].includes(rule)) {
      checks.push({
        scope: 'port',
        passed: true,
        residual: 0,
        label: rule === 'open' ? '开路支路电流恒为零 (i = 0)' : '悬空支路无闭合回路 (i = 0)',
      });
    } else if (rule === 'short') {
      checks.push({
        scope: 'port',
        passed: true,
        residual: 0,
        label: '理想短路两端等电位 (u = 0)',
      });
    } else if (rule === 'bridgeBalance') {
      // Bridge balance depends on the surrounding 4 bridge arms, so full-circuit or 4-arm+cross subnetwork check verifies i_cross = 0
      if (ports.length >= 2) {
        const subBefore = beforeDoc.elements.filter(e => options.contextIds?.includes(e.id) || removedIds.includes(e.id));
        const subAfter = afterDoc.elements.filter(e => options.contextIds?.includes(e.id));
        if (subBefore.length && subAfter.length) {
          checks.push(verifySubnetworkPorts(subBefore, subAfter, ports, { tolerance }));
        }
      }
    } else if (ports.length >= 2 && (oldElems.length || newElems.length)) {
      checks.push(verifySubnetworkPorts(oldElems, newElems, ports, { tolerance }));
    }
  } else if (!fullChecks.length) {
    // Arbitrary sourceless circuit comparison via common external ports
    const commonNodes = beforeDoc.nodes
      .map(n => n.id)
      .filter(id => afterDoc.nodes.some(n => n.id === id));
    const portNodes = ports.length >= 2 ? ports : commonNodes;
    if (portNodes.length >= 2) {
      const beforeElems = beforeDoc.elements.filter(e => e.type !== 'GND');
      const afterElems = afterDoc.elements.filter(e => e.type !== 'GND');
      checks.push(verifySubnetworkPorts(beforeElems, afterElems, portNodes, { tolerance }));
    }
  }

  if (!checks.length) {
    throw Error('无法在当前电路条件下执行独立等价性验证。');
  }

  const failed = checks.filter(c => !c.passed);
  const residual = Math.max(0, ...checks.map(c => c.residual ?? 0));
  const passed = failed.length === 0;
  const hasFull = fullChecks.length > 0;
  const hasPort = checks.some(c => c.scope === 'port');
  const method = hasFull && hasPort
    ? '独立全电路 MNA 求解器 + 端口矩阵双重验证'
    : hasFull
      ? '独立全电路 MNA 求解器验证'
      : '独立复数多端口矩阵求解器验证';
  const label = passed
    ? (hasFull && hasPort
      ? '全电路电学量与局部端口矩阵均一致'
      : checks.map(c => c.label || c.detail).filter(Boolean).join('；'))
    : failed.map(c => c.label || c.detail).join('；');

  return {
    passed,
    method,
    label,
    residual,
    tolerance,
    checks,
  };
}
