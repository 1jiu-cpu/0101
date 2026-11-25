import { referenceNode, TYPES } from './model.js';

const PASSIVE_TWO_PORT = new Set(['R', 'Z', 'C', 'L']);
const ends = e => [e.terminals.p, e.terminals.n];
const hasTwoPins = e => TYPES[e.type]?.pins.length === 2 && e.terminals.p !== undefined && e.terminals.n !== undefined;
const connects = (e, a, b) => (e.terminals.p === a && e.terminals.n === b) || (e.terminals.p === b && e.terminals.n === a);

function nodeAdjacency(doc) {
  const adj = new Map(doc.nodes.map(n => [n.id, []]));
  for (const e of doc.elements) {
    for (const [pin, node] of Object.entries(e.terminals)) {
      adj.get(node)?.push({ id: e.id, pin, element: e });
    }
  }
  return adj;
}

function pairKey(a, b) {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function complexMul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function complexSub(a, b) {
  return { re: a.re - b.re, im: a.im - b.im };
}

function elementImpedanceValue(e) {
  if (e.type === 'Z') return { re: e.value, im: e.reactance || 0 };
  if (e.type === 'C') return { re: 1 / e.value, im: 0 };
  return { re: e.value, im: 0 };
}

function isBridgeBalanced(topLeft, bottomLeft, topRight, bottomRight) {
  const types = new Set([topLeft.type, bottomLeft.type, topRight.type, bottomRight.type]);
  if (types.size !== 1) return false;
  const type = topLeft.type;
  if (!PASSIVE_TWO_PORT.has(type)) return false;
  if (['C', 'L'].includes(type) && [topLeft, bottomLeft, topRight, bottomRight].some(e => e.initial)) return false;
  const z1 = elementImpedanceValue(topLeft);
  const z2 = elementImpedanceValue(bottomLeft);
  const z3 = elementImpedanceValue(topRight);
  const z4 = elementImpedanceValue(bottomRight);
  const lhs = complexMul(z1, z4);
  const rhs = complexMul(z2, z3);
  const diff = complexSub(lhs, rhs);
  const magDiff = Math.hypot(diff.re, diff.im);
  const scale = Math.max(Math.hypot(lhs.re, lhs.im), Math.hypot(rhs.re, rhs.im), 1e-12);
  return magDiff <= scale * 1e-9;
}

/**
 * Find all Delta (Δ / Π) 3-cycles of compatible two-terminal elements.
 */
export function findDeltas(doc, { allowSources = true, sameTypeOnly = true } = {}) {
  const candidates = doc.elements.filter(e => {
    if (!hasTwoPins(e) || e.terminals.p === e.terminals.n) return false;
    if (PASSIVE_TWO_PORT.has(e.type)) return true;
    return allowSources && e.type === 'V';
  });
  const byPair = new Map();
  for (const e of candidates) {
    const k = pairKey(e.terminals.p, e.terminals.n);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(e);
  }
  const nodeIds = doc.nodes.map(n => n.id);
  const results = [];
  const seen = new Set();
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const abList = byPair.get(pairKey(nodeIds[i], nodeIds[j]));
      if (!abList?.length) continue;
      for (let k = j + 1; k < nodeIds.length; k++) {
        const bcList = byPair.get(pairKey(nodeIds[j], nodeIds[k]));
        const caList = byPair.get(pairKey(nodeIds[k], nodeIds[i]));
        if (!bcList?.length || !caList?.length) continue;
        for (const ab of abList) {
          for (const bc of bcList) {
            if (sameTypeOnly && ab.type !== bc.type) continue;
            for (const ca of caList) {
              if (sameTypeOnly && ab.type !== ca.type) continue;
              const ids = [ab.id, bc.id, ca.id].sort();
              const sig = ids.join(',');
              if (seen.has(sig)) continue;
              seen.add(sig);
              const kind = ab.type === 'V' ? 'source' : 'passive';
              results.push({
                kind,
                elementType: ab.type,
                nodes: [nodeIds[i], nodeIds[j], nodeIds[k]],
                elements: [ab.id, bc.id, ca.id],
                names: [ab.name, bc.name, ca.name],
                edges: {
                  ab: ab.id,
                  bc: bc.id,
                  ca: ca.id,
                },
              });
            }
          }
        }
      }
    }
  }
  return results;
}

/**
 * Find all Wye (Y / Star / T) 3-arm subnetworks sharing a center node.
 */
export function findWyes(doc, { allowSources = true, strictCenterDegree = true, sameTypeOnly = true } = {}) {
  const adj = nodeAdjacency(doc);
  const results = [];
  for (const node of doc.nodes) {
    const incident = adj.get(node.id) || [];
    const nonGndIncident = incident.filter(m => m.element.type !== 'GND');
    const twoPinArms = nonGndIncident.filter(m => {
      const e = m.element;
      if (!hasTwoPins(e) || e.terminals.p === e.terminals.n) return false;
      return PASSIVE_TWO_PORT.has(e.type) || (allowSources && e.type === 'V');
    });
    if (strictCenterDegree && nonGndIncident.length !== 3) continue;
    if (twoPinArms.length < 3) continue;
    const armElements = [...new Map(twoPinArms.map(m => [m.element.id, m.element])).values()];
    if (armElements.length !== 3) continue;
    if (sameTypeOnly && new Set(armElements.map(e => e.type)).size !== 1) continue;
    const ports = armElements.map(e => (e.terminals.p === node.id ? e.terminals.n : e.terminals.p));
    if (new Set(ports).size !== 3) continue;
    const kind = armElements[0].type === 'V' ? 'source' : 'passive';
    results.push({
      kind,
      elementType: armElements[0].type,
      center: node.id,
      centerIsReference: node.reference,
      centerIsGeneric: !node.reference && node.id === node.label && /^n\d+$/.test(node.label),
      ports,
      elements: armElements.map(e => e.id),
      names: armElements.map(e => e.name),
    });
  }
  return results;
}

/**
 * Find Wheatstone bridge (K4 - e) passive subnetworks and identify canonical roles.
 */
export function findBridges(doc) {
  const ground = referenceNode(doc);
  const passive = doc.elements.filter(e => hasTwoPins(e) && PASSIVE_TWO_PORT.has(e.type) && e.terminals.p !== e.terminals.n);
  const sources = doc.elements.filter(e => ['V', 'I'].includes(e.type) && e.terminals.p !== e.terminals.n);
  const adj = nodeAdjacency(doc);
  const byPair = new Map();
  for (const e of passive) {
    const k = pairKey(e.terminals.p, e.terminals.n);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(e);
  }
  const nodeIds = doc.nodes.map(n => n.id);
  const bridges = [];
  const seen = new Set();

  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      for (let k = j + 1; k < nodeIds.length; k++) {
        for (let l = k + 1; l < nodeIds.length; l++) {
          const quad = [nodeIds[i], nodeIds[j], nodeIds[k], nodeIds[l]];
          const pairSpecs = [
            [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
          ];
          const present = [];
          const missing = [];
          for (const [u, v] of pairSpecs) {
            const list = byPair.get(pairKey(quad[u], quad[v]));
            if (list?.length) present.push([u, v, list]);
            else missing.push([u, v]);
          }
          // Standard Wheatstone bridge has 5 passive edges (K4 - e), or 6 edges where one pair is driven by a source.
          if (present.length < 5) continue;
          const drivePairs = missing.length === 1
            ? [missing[0]]
            : pairSpecs.filter(([u, v]) => sources.some(s => connects(s, quad[u], quad[v])) || quad[u] === ground || quad[v] === ground);

          for (const [d0, d1] of drivePairs.slice(0, 1)) {
            const others = [0, 1, 2, 3].filter(idx => idx !== d0 && idx !== d1);
            const [o0, o1] = others;
            let top = quad[d0];
            let bottom = quad[d1];
            const directSource = sources.find(s => connects(s, top, bottom));
            // Prefer ground at bottom, or source positive at top
            if (top === ground || (directSource && directSource.terminals.p === bottom && bottom !== ground)) {
              [top, bottom] = [bottom, top];
            }
            const left = quad[o0];
            const right = quad[o1];
            const topLeft = byPair.get(pairKey(top, left))?.[0];
            const bottomLeft = byPair.get(pairKey(left, bottom))?.[0];
            const topRight = byPair.get(pairKey(top, right))?.[0];
            const bottomRight = byPair.get(pairKey(right, bottom))?.[0];
            const cross = byPair.get(pairKey(left, right))?.[0];
            if (!topLeft || !bottomLeft || !topRight || !bottomRight || !cross) continue;
            const elemIds = [topLeft.id, bottomLeft.id, topRight.id, bottomRight.id, cross.id];
            const sig = [...elemIds].sort().join(',');
            if (seen.has(sig)) continue;
            seen.add(sig);

            // Check if a source drives the bridge via a series impedance into top or bottom
            let driveSource = directSource || null;
            let seriesElement = null;
            if (!driveSource) {
              const topIncident = (adj.get(top) || []).map(m => m.element).filter(e => !elemIds.includes(e.id));
              for (const ext of topIncident) {
                if (!hasTwoPins(ext)) continue;
                const far = ext.terminals.p === top ? ext.terminals.n : ext.terminals.p;
                const s = sources.find(src => connects(src, far, bottom));
                if (s) {
                  driveSource = s;
                  seriesElement = ext;
                  break;
                }
              }
            }

            // Ensure deterministic left/right ordering by element name
            let orderedLeft = left;
            let orderedRight = right;
            let tl = topLeft;
            let bl = bottomLeft;
            let tr = topRight;
            let br = bottomRight;
            if (tl.name.localeCompare(tr.name) > 0) {
              [orderedLeft, orderedRight] = [right, left];
              [tl, tr] = [topRight, topLeft];
              [bl, br] = [bottomRight, bottomLeft];
            }

            const balanced = isBridgeBalanced(tl, bl, tr, br);
            bridges.push({
              nodes: { top, bottom, left: orderedLeft, right: orderedRight },
              arms: {
                topLeft: tl.id,
                bottomLeft: bl.id,
                topRight: tr.id,
                bottomRight: br.id,
                cross: cross.id,
              },
              elements: [tl.id, bl.id, tr.id, br.id, cross.id],
              names: [tl.name, bl.name, tr.name, br.name, cross.name],
              source: driveSource?.id || null,
              seriesElement: seriesElement?.id || null,
              balanced,
              upperDelta: {
                nodes: [top, orderedLeft, orderedRight],
                elements: [tl.id, tr.id, cross.id],
              },
              lowerDelta: {
                nodes: [bottom, orderedLeft, orderedRight],
                elements: [bl.id, br.id, cross.id],
              },
            });
          }
        }
      }
    }
  }
  return bridges;
}

/**
 * Find three-phase compound topologies: Δ-Y, Y-Δ, Y-Y, Δ-Δ (supporting both V3 and 3-V sources).
 */
export function findThreePhase(doc) {
  const deltas = findDeltas(doc, { allowSources: true, sameTypeOnly: true });
  const wyes = findWyes(doc, { allowSources: true, strictCenterDegree: false, sameTypeOnly: true });
  const v3Sources = doc.elements.filter(e => e.type === 'V3');
  const results = [];

  const sourceConfigs = [];
  for (const v3 of v3Sources) {
    sourceConfigs.push({
      connection: 'Y',
      kind: 'V3',
      phases: [v3.terminals.A, v3.terminals.B, v3.terminals.C],
      neutral: v3.terminals.N,
      elements: [v3.id],
    });
  }
  for (const d of deltas.filter(x => x.kind === 'source')) {
    sourceConfigs.push({
      connection: 'Δ',
      kind: 'V-delta',
      phases: [...d.nodes],
      neutral: null,
      elements: [...d.elements],
    });
  }
  for (const y of wyes.filter(x => x.kind === 'source')) {
    sourceConfigs.push({
      connection: 'Y',
      kind: 'V-wye',
      phases: [...y.ports],
      neutral: y.center,
      elements: [...y.elements],
    });
  }

  const loadConfigs = [
    ...deltas.filter(x => x.kind === 'passive').map(d => ({
      connection: 'Δ',
      phases: [...d.nodes],
      neutral: null,
      elements: [...d.elements],
      elementType: d.elementType,
    })),
    ...wyes.filter(x => x.kind === 'passive').map(y => ({
      connection: 'Y',
      phases: [...y.ports],
      neutral: y.center,
      elements: [...y.elements],
      elementType: y.elementType,
    })),
  ];

  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  for (const src of sourceConfigs) {
    for (const load of loadConfigs) {
      if (sameSet(src.phases, load.phases)) {
        results.push({
          configuration: `${src.connection}-${load.connection}`,
          phases: [...src.phases],
          source: src,
          load,
          elements: [...src.elements, ...load.elements],
        });
      }
    }
  }
  return results;
}

/**
 * Run all dedicated topology detectors on a Circuit IR document.
 */
export function detectTopologies(doc) {
  const bridges = findBridges(doc);
  const deltas = findDeltas(doc);
  const wyes = findWyes(doc, { strictCenterDegree: true });
  const relaxedWyes = findWyes(doc, { strictCenterDegree: false });
  const threePhases = findThreePhase(doc);
  const summary = [];
  if (threePhases.length) summary.push(...threePhases.map(tp => `三相 ${tp.configuration} 网络`));
  if (bridges.length) summary.push(...bridges.map(b => b.balanced ? '平衡惠斯通电桥' : '惠斯通电桥'));
  if (!threePhases.length && !bridges.length) {
    if (deltas.length) summary.push(`${deltas.length} 处三角形 (Δ) 网络`);
    if (wyes.length) summary.push(`${wyes.length} 处星形 (Y) 网络`);
  }
  return {
    bridges,
    deltas,
    wyes,
    allWyes: relaxedWyes,
    threePhases,
    summary,
  };
}

/**
 * Quantize a numeric parameter for canonical circuit fingerprinting.
 */
function quantize(v) {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return 0;
  return Number(v.toPrecision(6));
}

/**
 * Deterministic structural + quantized-value fingerprint of a Circuit IR.
 * Invariant under element ID renaming and internal node renaming.
 * Used for cycle detection during automated reduction path planning.
 */
export function circuitFingerprint(doc, { preserveNodes = [] } = {}) {
  const keepSet = new Set(preserveNodes);
  const labels = new Map();
  const edges = new Map();
  const addVertex = (id, label) => {
    labels.set(id, JSON.stringify(label));
    edges.set(id, []);
  };
  const addEdge = (u, v, pin) => {
    edges.get(u).push([v, pin]);
    edges.get(v).push([u, pin]);
  };

  for (const n of doc.nodes) {
    const tag = n.reference ? 'REF' : keepSet.has(n.id) ? `KEEP:${n.id}` : 'N';
    addVertex('n:' + n.id, ['net', tag]);
  }
  for (const e of doc.elements) {
    if (e.type === 'GND') continue;
    const isSymmetric = ['R', 'Z', 'C', 'L', 'OPEN', 'SHORT'].includes(e.type);
    addVertex('e:' + e.id, [
      e.type,
      quantize(e.value),
      e.type === 'Z' ? quantize(e.reactance) : null,
      quantize(e.initial),
      quantize(e.ac),
      quantize(((e.phase % 360) + 360) % 360),
    ]);
    for (const [pin, node] of Object.entries(e.terminals)) {
      if (!labels.has('n:' + node)) continue;
      addEdge('e:' + e.id, 'n:' + node, isSymmetric ? 't' : pin);
    }
    if (['F', 'H'].includes(e.type) && e.control && labels.has('e:' + e.control)) {
      const cid = 'ctl:' + e.id;
      addVertex(cid, ['ctl']);
      addEdge('e:' + e.id, cid, 'out');
      addEdge(cid, 'e:' + e.control, 'in');
    }
  }
  for (const [i, c] of doc.couplings.entries()) {
    const kid = 'k:' + i;
    addVertex(kid, ['k', quantize(c.k)]);
    if (labels.has('e:' + c.a)) addEdge(kid, 'e:' + c.a, 'L');
    if (labels.has('e:' + c.b)) addEdge(kid, 'e:' + c.b, 'L');
  }

  // Weisfeiler-Lehman color refinement
  let colors = labels;
  const iterations = Math.min(labels.size + 1, 16);
  for (let step = 0; step < iterations; step++) {
    const next = new Map();
    const palette = new Map();
    const keys = [...colors.keys()].sort();
    const signatures = keys.map(k => {
      const nbrs = edges.get(k).map(([v, p]) => `${p}:${colors.get(v)}`).sort();
      return [k, `${colors.get(k)}|[${nbrs.join(',')}]`];
    });
    const uniqueSigs = [...new Set(signatures.map(([, s]) => s))].sort();
    uniqueSigs.forEach((s, idx) => palette.set(s, idx));
    const prevCount = new Set(colors.values()).size;
    for (const [k, s] of signatures) next.set(k, String(palette.get(s)));
    colors = next;
    if (palette.size === prevCount && step > 0) break;
  }

  // Combine initial vertex types with refined colors and edge multiset for collision resistance
  const vertexHist = [...colors.keys()].map(k => `${labels.get(k)}#${colors.get(k)}`).sort();
  const edgeHist = [];
  for (const [u, list] of edges) {
    for (const [v, p] of list) {
      if (u < v) edgeHist.push(`${colors.get(u)}-${p}-${colors.get(v)}`);
    }
  }
  edgeHist.sort();
  return `V(${vertexHist.join(';')})|E(${edgeHist.join(';')})`;
}
