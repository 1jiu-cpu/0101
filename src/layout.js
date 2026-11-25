import { clone, compareTopology, referenceNode, snap } from './model.js';
import { detectTopologies } from './topology.js';

const shapes = {
  GND: { g: [0, -28, 0, -1] },
  E: { p: [-50, 0, -1, 0], n: [50, 0, 1, 0], cp: [-22, 32, 0, 1], cn: [22, 32, 0, 1] },
  G: { p: [-50, 0, -1, 0], n: [50, 0, 1, 0], cp: [-22, 32, 0, 1], cn: [22, 32, 0, 1] },
  OP: { plus: [-50, -15, -1, 0], minus: [-50, 15, -1, 0], out: [50, 0, 1, 0], ref: [0, 34, 0, 1] },
  T: { p1: [-50, -27, -1, 0], n1: [-50, 27, -1, 0], p2: [50, -27, 1, 0], n2: [50, 27, 1, 0] },
  V3: { A: [50, -26, 1, 0], B: [50, 0, 1, 0], C: [50, 26, 1, 0], N: [-50, 0, -1, 0] },
};
const two = { p: [-50, 0, -1, 0], n: [50, 0, 1, 0] };
const xy = (x, y) => ({ x, y });
const key = ({ x, y }) => x + ',' + y;
const delta = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const equal = (a, b) => a.x === b.x && a.y === b.y;
const inside = (x, a, b, inclusive = true) => inclusive ? x >= Math.min(a, b) && x <= Math.max(a, b) : x > Math.min(a, b) && x < Math.max(a, b);
const orientH = (e, leftNode) => (e.terminals.p === leftNode ? 0 : 180);
const orientV = (e, topNode) => (e.terminals.p === topNode ? 90 : 270);

export function pinLocations(doc, e) {
  const pose = doc.geometry[e.id];
  const turn = pose.rotation / 90;
  const transform = (x, y) => {
    if (pose.mirror) x = -x;
    return [[x, y], [-y, x], [-x, -y], [y, -x]][turn];
  };
  return Object.entries(shapes[e.type] || two).map(([pin, [x, y, dx, dy]]) => {
    const [offsetX, offsetY] = transform(x, y);
    const [vx, vy] = transform(dx, dy);
    return { id: e.id, pin, node: e.terminals[pin], x: pose.x + offsetX, y: pose.y + offsetY, dx: vx, dy: vy };
  });
}

const dedupe = points => points.filter((p, i) => !i || !equal(points[i - 1], p));
const segments = points => dedupe(points).flatMap((a, i, list) => i < list.length - 1 ? [{ a, b: list[i + 1], h: a.y === list[i + 1].y }] : []);
const collapse = points => {
  const result = [];
  for (const p of dedupe(points)) {
    const start = result.at(-2);
    const mid = result.at(-1);
    if (start && ((start.x === mid.x && mid.x === p.x && inside(mid.y, start.y, p.y)) || (start.y === mid.y && mid.y === p.y && inside(mid.x, start.x, p.x)))) result.pop();
    result.push(p);
  }
  return result;
};

function cross(s, t) {
  if (s.h === t.h) return null;
  const h = s.h ? s : t;
  const v = s.h ? t : s;
  return inside(v.a.x, h.a.x, h.b.x) && inside(h.a.y, v.a.y, v.b.y) ? xy(v.a.x, h.a.y) : null;
}

function overlap(s, t) {
  if (s.h !== t.h) return 0;
  if (s.h && s.a.y === t.a.y) return Math.max(0, Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) - Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x)));
  if (!s.h && s.a.x === t.a.x) return Math.max(0, Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y)) - Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y)));
  return 0;
}

function rectangleHit(segment, rectangle) {
  const { a, b, h } = segment;
  const { x1, x2, y1, y2 } = rectangle;
  return h ? inside(a.y, y1, y2, false) && Math.min(a.x, b.x) < x2 && Math.max(a.x, b.x) > x1
    : inside(a.x, x1, x2, false) && Math.min(a.y, b.y) < y2 && Math.max(a.y, b.y) > y1;
}

function box(doc, element) {
  const p = doc.geometry[element.id];
  const multi = ['OP', 'T', 'V3'].includes(element.type);
  const w = p.rotation % 180 ? multi ? 31 : 23 : 36;
  const h = p.rotation % 180 ? 36 : multi ? 31 : 22;
  return { id: element.id, x1: p.x - w, x2: p.x + w, y1: p.y - h, y2: p.y + h };
}

function boxesOverlap(a, b, margin = 14) {
  return a.x1 - margin < b.x2 && a.x2 + margin > b.x1 && a.y1 - margin < b.y2 && a.y2 + margin > b.y1;
}

function candidates(a, b, boxes, wires) {
  const midX = Math.round((a.x + b.x) / 40) * 20;
  const midY = Math.round((a.y + b.y) / 40) * 20;
  const xs = new Set([a.x, b.x, midX, midX - 40, midX + 40, ...boxes.flatMap(o => [o.x1 - 8, o.x2 + 8])]);
  const ys = new Set([a.y, b.y, midY, midY - 40, midY + 40, ...boxes.flatMap(o => [o.y1 - 8, o.y2 + 8])]);
  for (const s of wires) {
    if (s.h) { ys.add(s.a.y - 16); ys.add(s.a.y + 16); }
    else { xs.add(s.a.x - 16); xs.add(s.a.x + 16); }
  }
  const closest = (set, mid) => [...set].sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid)).slice(0, 18);
  return [
    ...closest(xs, midX).map(x => [a, xy(x, a.y), xy(x, b.y), b]),
    ...closest(ys, midY).map(y => [a, xy(a.x, y), xy(b.x, y), b]),
  ];
}

function labelPositions(doc, wires, boxes) {
  const result = {};
  const occupied = [];
  for (const e of doc.elements) {
    const p = doc.geometry[e.id];
    if (e.type === 'GND') continue;
    const width = Math.min(150, Math.max(62, e.name.length * 9 + 12));
    const options = p.rotation % 180 || ['OP', 'T', 'V3'].includes(e.type)
      ? [{ x: p.x + 40, y: p.y - 12, align: 'start' }, { x: p.x - 40, y: p.y - 12, align: 'end' }, { x: p.x, y: p.y - 76, align: 'middle' }]
      : [{ x: p.x, y: p.y - 45, align: 'middle' }, { x: p.x, y: p.y + 37, align: 'middle' }, { x: p.x + 54, y: p.y + 19, align: 'start' }];
    const rectangle = option => {
      const x1 = option.align === 'start' ? option.x : option.align === 'end' ? option.x - width : option.x - width / 2;
      return { x1, x2: x1 + width, y1: option.y - 14, y2: option.y + 22 };
    };
    const rank = option => {
      const area = rectangle(option);
      let score = wires.filter(s => rectangleHit(s, area)).length * 7;
      for (const o of [...boxes, ...occupied]) if (o.x1 < area.x2 && o.x2 > area.x1 && o.y1 < area.y2 && o.y2 > area.y1) score += 15;
      return score;
    };
    options.sort((a, b) => rank(a) - rank(b));
    const chosen = options[0];
    result[e.id] = chosen;
    occupied.push(rectangle(chosen));
  }
  return { positions: result, rectangles: occupied };
}

export function route(doc) {
  const pins = doc.elements.flatMap(e => pinLocations(doc, e));
  const bins = new Map(doc.nodes.map(n => [n.id, []]));
  for (const pin of pins) bins.get(pin.node)?.push(pin);
  const boxes = doc.elements.map(e => box(doc, e));
  const nets = [...bins].sort((a, b) => (doc.nodes.find(n => n.id === a[0]).reference ? 1 : 0) - (doc.nodes.find(n => n.id === b[0]).reference ? 1 : 0) || a[1].length - b[1].length);
  const wires = [];
  const junctions = [];
  const nodeLabels = [];
  const hops = [];
  let bends = 0;
  const stub = pin => xy(pin.x + 14 * pin.dx, pin.y + 14 * pin.dy);
  for (const [node, list] of nets) {
    if (list.length < 2) continue;
    const remaining = [...list];
    const first = remaining.shift();
    const end = stub(first);
    const own = [{ a: first, b: end, h: first.y === end.y, node }];
    const earlier = wires.slice();
    while (remaining.length) {
      const pairs = [];
      for (const pin of remaining) {
        const start = stub(pin);
        const targets = new Map();
        for (const s of own) {
          const projected = s.h ? xy(Math.max(Math.min(start.x, Math.max(s.a.x, s.b.x)), Math.min(s.a.x, s.b.x)), s.a.y)
            : xy(s.a.x, Math.max(Math.min(start.y, Math.max(s.a.y, s.b.y)), Math.min(s.a.y, s.b.y)));
          for (const p of [s.a, s.b, projected]) {
            if (!list.some(candidate => equal(p, candidate)) || delta(start, p) === 14) targets.set(key(p), p);
          }
        }
        const ordered = [...targets.values()].sort((a, b) => delta(a, start) - delta(b, start)).slice(0, 8);
        for (const b of ordered) pairs.push({ pin, start, b, distance: delta(start, b) });
      }
      pairs.sort((a, b) => a.distance - b.distance);
      let winner = null;
      for (const { pin, start, b, distance } of pairs.slice(0, 14)) {
        if (winner && distance > winner.score) continue;
        const near = boxes.filter(o => o.x1 <= Math.max(start.x, b.x) + 100 && o.x2 >= Math.min(start.x, b.x) - 100 && o.y1 <= Math.max(start.y, b.y) + 100 && o.y2 >= Math.min(start.y, b.y) - 100);
        for (const path of candidates(start, b, near, earlier)) {
          const bendPath = collapse([pin, ...path]);
          const parts = segments(bendPath);
          let score = (parts.length - 1) * 14;
          for (const s of parts) {
            score += delta(s.a, s.b);
            for (const ob of near) if (rectangleHit(s, ob)) score += 1900;
            for (const t of earlier) {
              const p = cross(s, t);
              if (p) score += (equal(p, s.a) || equal(p, s.b) || equal(p, t.a) || equal(p, t.b)) ? 270 : 48;
              if (overlap(s, t)) score += 1600;
            }
            for (const t of own) if (overlap(s, t)) score += 140;
          }
          if (!winner || score < winner.score) winner = { pin, parts, score };
        }
      }
      if (!winner) break;
      remaining.splice(remaining.indexOf(winner.pin), 1);
      own.push(...winner.parts.map(s => ({ ...s, node })));
      bends += Math.max(0, winner.parts.length - 1);
    }
    const seen = new Map();
    for (const s of own) for (const p of [s.a, s.b]) seen.set(key(p), p);
    const dots = [...seen.values()].filter(p => {
      const directions = new Set();
      for (const s of own) {
        if (s.h && p.y === s.a.y && inside(p.x, s.a.x, s.b.x)) {
          if (Math.min(s.a.x, s.b.x) < p.x) directions.add('left');
          if (Math.max(s.a.x, s.b.x) > p.x) directions.add('right');
        } else if (!s.h && p.x === s.a.x && inside(p.y, s.a.y, s.b.y)) {
          if (Math.min(s.a.y, s.b.y) < p.y) directions.add('up');
          if (Math.max(s.a.y, s.b.y) > p.y) directions.add('down');
        }
      }
      return directions.size >= 3;
    });
    junctions.push(...dots.map(p => ({ ...p, node })));
    const label = doc.nodes.find(n => n.id === node);
    if (!label.reference && !/^n\d+$/.test(label.label)) {
      const p = dots.sort((a, b) => a.y - b.y || b.x - a.x)[0] || [...seen.values()].sort((a, b) => a.y - b.y || b.x - a.x)[0];
      if (p) nodeLabels.push({ ...p, label: label.label, node });
    }
    wires.push(...own);
  }
  for (const [i, s] of wires.entries()) for (const [j, t] of wires.slice(0, i).entries()) {
    if (s.node === t.node) continue;
    const p = cross(s, t);
    if (p && !hops.some(h => equal(h, p))) hops.push({ ...p, over: i, under: j, a: s.node, b: t.node });
  }
  const { positions, rectangles } = labelPositions(doc, wires, boxes);
  const points = [...pins, ...wires.flatMap(s => [s.a, s.b]), ...rectangles.flatMap(o => [xy(o.x1, o.y1), xy(o.x2, o.y2)]), ...doc.annotations.flatMap(a => [a, xy(a.x + 13 * a.text.length, a.y - 14)])];
  const bounds = points.length ? {
    x: Math.min(...points.map(p => p.x)) - 28, y: Math.min(...points.map(p => p.y)) - 28,
    right: Math.max(...points.map(p => p.x)) + 28, bottom: Math.max(...points.map(p => p.y)) + 28,
  } : { x: 0, y: 0, right: 800, bottom: 540 };
  const obstructions = wires.reduce((sum, s) => sum + boxes.filter(o => rectangleHit(s, o)).length, 0);
  const labelCollisions = rectangles.reduce((sum, r) => sum + wires.filter(s => rectangleHit(s, r)).length, 0);
  const overlaps = wires.reduce((sum, s, i) => sum + wires.slice(0, i).filter(t => t.node !== s.node && overlap(s, t) > 0).length, 0);
  const area = (bounds.right - bounds.x) * (bounds.bottom - bounds.y);
  const aspect = (bounds.right - bounds.x) / (bounds.bottom - bounds.y);
  const alignment = doc.elements.reduce((sum, e) => sum + Math.abs(doc.geometry[e.id].x % 20) + Math.abs(doc.geometry[e.id].y % 20), 0);
  const score = obstructions * 800 + overlaps * 1000 + labelCollisions * 70 + hops.length * 46 + bends * 14 + Math.sqrt(area) * .06 + Math.abs(Math.log(aspect / 1.6)) * 13 + alignment * .2;
  return { pins, wires, junctions, hops, nodeLabels, positions, bounds, quality: { score, bends, crossings: hops.length, obstructions, labelCollisions, overlaps } };
}

export function verifyRouted(topo, drawing) {
  const groups = new Map(topo.nodes.map(n => [n.id, []]));
  for (const e of topo.elements) for (const [pin, node] of Object.entries(e.terminals)) {
    const painted = drawing.pins.find(p => p.id === e.id && p.pin === pin && p.node === node);
    if (!painted) return false;
    groups.get(node).push(painted);
  }
  const on = (p, s) => s.h ? p.y === s.a.y && inside(p.x, s.a.x, s.b.x) : p.x === s.a.x && inside(p.y, s.a.y, s.b.y);
  const touch = (a, b) => cross(a, b) || on(a.a, b) || on(a.b, b) || on(b.a, a) || on(b.b, a);
  for (const [node, pins] of groups) {
    if (pins.length <= 1) continue;
    const parts = drawing.wires.filter(w => w.node === node);
    const start = parts.find(w => on(pins[0], w));
    if (!start) return false;
    const seen = new Set([start]);
    const queue = [start];
    for (const s of queue) for (const t of parts) {
      if (!seen.has(t) && touch(s, t)) { seen.add(t); queue.push(t); }
    }
    if (pins.some(p => !queue.some(s => on(p, s)))) return false;
  }
  return true;
}

/**
 * Place remaining non-template elements cleanly beside an already-arranged special topology.
 */
function placeRemaining(arranged, placedIds, keepLocked) {
  const occupied = arranged.elements
    .filter(e => placedIds.has(e.id) || (keepLocked && arranged.geometry[e.id].locked))
    .map(e => box(arranged, e));
  let extraX = occupied.length ? snap(Math.max(...occupied.map(b => b.x2)) + 120) : 760;
  let extraY = 180;
  for (const e of arranged.elements) {
    if (placedIds.has(e.id)) continue;
    const pose = arranged.geometry[e.id];
    if (keepLocked && pose.locked) continue;
    if (e.type === 'GND') {
      const cx = occupied.length ? snap((Math.min(...occupied.map(b => b.x1)) + Math.max(...occupied.map(b => b.x2))) / 2) : 400;
      const bottom = occupied.length ? snap(Math.max(...occupied.map(b => b.y2)) + 80) : 520;
      Object.assign(pose, { x: cx, y: bottom, rotation: 0, mirror: false, locked: false });
      occupied.push(box(arranged, e));
      continue;
    }
    while (occupied.some(b => boxesOverlap(b, { x1: extraX - 36, x2: extraX + 36, y1: extraY - 36, y2: extraY + 36 }, 24))) {
      extraY += 120;
      if (extraY > 560) { extraY = 180; extraX += 160; }
    }
    Object.assign(pose, { x: extraX, y: extraY, rotation: 90, mirror: false, locked: false });
    occupied.push(box(arranged, e));
    extraY += 140;
  }
}

/**
 * Generate dedicated textbook-grade layout candidates for special topologies:
 * Wheatstone bridge, Δ (Delta/Π), Y (Wye/Star/T), and Three-Phase (Δ-Y, Y-Δ, Y-Y, Δ-Δ).
 */
function specialLayoutCandidates(model, keepLocked) {
  const results = [];
  const byId = new Map(model.elements.map(e => [e.id, e]));
  const ground = referenceNode(model);
  const gndElement = model.elements.find(e => e.type === 'GND');
  const topo = detectTopologies(model);

  function addCandidate(entries, tag, bonus = 0) {
    const arranged = clone(model);
    const placedIds = new Set();
    for (const [e, x, y, rotation] of entries) {
      if (!e) continue;
      placedIds.add(e.id);
      const pose = arranged.geometry[e.id];
      if (!keepLocked || !pose.locked) Object.assign(pose, { x: snap(x), y: snap(y), rotation, mirror: false, locked: false });
    }
    placeRemaining(arranged, placedIds, keepLocked);
    const quality = route(arranged).quality;
    results.push({ model: arranged, quality, tag, effectiveScore: quality.score - (quality.overlaps === 0 && quality.obstructions === 0 ? bonus : 0) });
  }

  // 1. Dedicated Wheatstone Bridge Layout (orthogonal H-bridge)
  for (const bridge of topo.bridges) {
    const { top, bottom, left, right } = bridge.nodes;
    const tl = byId.get(bridge.arms.topLeft);
    const bl = byId.get(bridge.arms.bottomLeft);
    const tr = byId.get(bridge.arms.topRight);
    const br = byId.get(bridge.arms.bottomRight);
    const crossArm = byId.get(bridge.arms.cross);
    const src = bridge.source ? byId.get(bridge.source) : null;
    const series = bridge.seriesElement ? byId.get(bridge.seriesElement) : null;
    const leftX = src ? 340 : 240;
    const rightX = leftX + 320;
    const midX = (leftX + rightX) / 2;
    const entries = [
      [tl, leftX, 200, orientV(tl, top)],
      [bl, leftX, 440, orientV(bl, left)],
      [tr, rightX, 200, orientV(tr, top)],
      [br, rightX, 440, orientV(br, right)],
      [crossArm, midX, 320, orientH(crossArm, left)],
    ];
    if (src) {
      const srcTop = series ? (series.terminals.p === top ? series.terminals.n : series.terminals.p) : top;
      entries.push([src, 140, 320, orientV(src, srcTop)]);
      if (series) entries.push([series, 240, 120, orientH(series, srcTop)]);
    }
    if (gndElement) entries.push([gndElement, midX, 560, 0]);
    addCandidate(entries, 'bridge', 60);
  }

  // 2. Dedicated Three-Phase Layout (Δ-Y, Y-Δ, Y-Y, Δ-Δ)
  for (const tp of topo.threePhases) {
    const [pA, pB, pC] = tp.phases;
    const phaseY = [140, 280, 420];
    const entries = [];

    // Source side (left)
    if (tp.source.kind === 'V3') {
      entries.push([byId.get(tp.source.elements[0]), 160, 280, 0]);
    } else if (tp.source.connection === 'Y') {
      const srcElems = tp.source.elements.map(id => byId.get(id));
      const order = [pA, pB, pC].map(p => srcElems.find(e => [e.terminals.p, e.terminals.n].includes(p)));
      order.forEach((e, i) => { if (e) entries.push([e, 260, phaseY[i], orientH(e, tp.source.neutral)]); });
    } else if (tp.source.connection === 'Δ') {
      const srcElems = tp.source.elements.map(id => byId.get(id));
      const findEdge = (u, v) => srcElems.find(e => (e.terminals.p === u && e.terminals.n === v) || (e.terminals.p === v && e.terminals.n === u));
      const eAB = findEdge(pA, pB);
      const eBC = findEdge(pB, pC);
      const eCA = findEdge(pC, pA);
      if (eAB) entries.push([eAB, 280, 200, orientV(eAB, pA)]);
      if (eBC) entries.push([eBC, 280, 360, orientV(eBC, pB)]);
      if (eCA) entries.push([eCA, 140, 280, orientV(eCA, pA)]);
    }

    // Load side (right)
    if (tp.load.connection === 'Y') {
      const loadElems = tp.load.elements.map(id => byId.get(id));
      const order = [pA, pB, pC].map(p => loadElems.find(e => [e.terminals.p, e.terminals.n].includes(p)));
      order.forEach((e, i) => { if (e) entries.push([e, 600, phaseY[i], orientH(e, tp.phases[i])]); });
    } else if (tp.load.connection === 'Δ') {
      const loadElems = tp.load.elements.map(id => byId.get(id));
      const findEdge = (u, v) => loadElems.find(e => (e.terminals.p === u && e.terminals.n === v) || (e.terminals.p === v && e.terminals.n === u));
      const eAB = findEdge(pA, pB);
      const eBC = findEdge(pB, pC);
      const eCA = findEdge(pC, pA);
      if (eAB) entries.push([eAB, 580, 200, orientV(eAB, pA)]);
      if (eBC) entries.push([eBC, 580, 360, orientV(eBC, pB)]);
      if (eCA) entries.push([eCA, 720, 280, orientV(eCA, pA)]);
    }

    if (gndElement) entries.push([gndElement, 440, 540, 0]);
    addCandidate(entries, `threePhase:${tp.configuration}`, 50);
  }

  // 3. Dedicated Standalone / Small Delta (Δ / Π) Layout
  if (!topo.bridges.length && !topo.threePhases.length && model.elements.length <= 7) {
    for (const d of topo.deltas.filter(x => x.kind === 'passive').slice(0, 2)) {
      const [nA, nB, nC] = d.nodes;
      const orderedNodes = [...d.nodes].sort((u, v) => (u === ground ? 1 : 0) - (v === ground ? 1 : 0));
      const [topL, topR, bot] = orderedNodes;
      const dElems = d.elements.map(id => byId.get(id));
      const findEdge = (u, v) => dElems.find(e => (e.terminals.p === u && e.terminals.n === v) || (e.terminals.p === v && e.terminals.n === u));
      const eTop = findEdge(topL, topR);
      const eLeft = findEdge(topL, bot);
      const eRight = findEdge(topR, bot);
      const extSrc = model.elements.find(e => ['V', 'I'].includes(e.type) && !d.elements.includes(e.id));
      const offsetX = extSrc ? 160 : 0;

      // Π-orientation: horizontal top bar + two vertical legs to bottom node
      const piEntries = [
        [eTop, 420 + offsetX, 160, orientH(eTop, topL)],
        [eLeft, 300 + offsetX, 300, orientV(eLeft, topL)],
        [eRight, 540 + offsetX, 300, orientV(eRight, topR)],
      ];
      if (extSrc) {
        const srcTop = [extSrc.terminals.p, extSrc.terminals.n].includes(bot)
          ? (extSrc.terminals.p === bot ? extSrc.terminals.n : extSrc.terminals.p)
          : extSrc.terminals.p;
        piEntries.push([extSrc, 140, 300, orientV(extSrc, srcTop)]);
      }
      if (gndElement) piEntries.push([gndElement, 420 + offsetX, 460, 0]);
      addCandidate(piEntries, 'delta-pi', 35);

      // Upright Δ-orientation (one apex top, horizontal base at bottom)
      if (nA !== nB && nB !== nC) {
        const apex = orderedNodes[0];
        const bLeft = orderedNodes[1];
        const bRight = orderedNodes[2];
        const eAL = findEdge(apex, bLeft);
        const eAR = findEdge(apex, bRight);
        const eBase = findEdge(bLeft, bRight);
        const triEntries = [
          [eAL, 300 + offsetX, 200, orientV(eAL, apex)],
          [eAR, 540 + offsetX, 200, orientV(eAR, apex)],
          [eBase, 420 + offsetX, 340, orientH(eBase, bLeft)],
        ];
        if (extSrc) triEntries.push([extSrc, 140, 280, orientV(extSrc, apex)]);
        if (gndElement) triEntries.push([gndElement, 420 + offsetX, 460, 0]);
        addCandidate(triEntries, 'delta-upright', 30);
      }
    }

    // 4. Dedicated Standalone / Embedded Wye (Y / T) Layout
    for (const y of topo.wyes.filter(x => x.kind === 'passive').slice(0, 2)) {
      const yElems = y.elements.map(id => byId.get(id));
      const armFor = port => yElems.find(e => (e.terminals.p === port && e.terminals.n === y.center) || (e.terminals.n === port && e.terminals.p === y.center));
      const extSrc = model.elements.find(e => ['V', 'I'].includes(e.type) && !y.elements.includes(e.id));
      const offsetX = extSrc ? 160 : 0;

      // Try placing each port as the vertical stem (preferring ground/bottom or top-source port)
      const orderedPorts = [...y.ports].sort((u, v) => (v === ground ? 1 : 0) - (u === ground ? 1 : 0));
      const stemPort = orderedPorts[0];
      const sideA = orderedPorts[1];
      const sideB = orderedPorts[2];
      const eStem = armFor(stemPort);
      const eLeft = armFor(sideA);
      const eRight = armFor(sideB);

      // T-shape (stem down to ground/bottom)
      const tEntries = [
        [eLeft, 300 + offsetX, 200, orientH(eLeft, sideA)],
        [eRight, 540 + offsetX, 200, orientH(eRight, y.center)],
        [eStem, 420 + offsetX, 320, orientV(eStem, y.center)],
      ];
      if (extSrc) {
        const srcTop = extSrc.terminals.n === ground ? extSrc.terminals.p : extSrc.terminals.n;
        tEntries.push([extSrc, 140, 280, orientV(extSrc, srcTop)]);
      }
      if (gndElement) tEntries.push([gndElement, 420 + offsetX, 460, 0]);
      addCandidate(tEntries, 'wye-T', 35);

      // Inverted-T / Y-shape (stem up to apex, two horizontal/lower legs)
      const invEntries = [
        [eStem, 420 + offsetX, 160, orientV(eStem, stemPort)],
        [eLeft, 300 + offsetX, 280, orientH(eLeft, sideA)],
        [eRight, 540 + offsetX, 280, orientH(eRight, y.center)],
      ];
      if (extSrc) invEntries.push([extSrc, 140, 280, orientV(extSrc, stemPort)]);
      if (gndElement) invEntries.push([gndElement, 420 + offsetX, 460, 0]);
      addCandidate(invEntries, 'wye-Y', 30);
    }
  }

  return results;
}

export function autoLayout(doc, keepLocked = true) {
  const model = clone(doc);
  if (!doc.elements.length) return { model, ...route(model).quality };
  const ground = referenceNode(model);
  const edges = model.elements.filter(e => e.terminals.p !== undefined);
  const active = [...edges].sort((a, b) => a.name.localeCompare(b.name));
  const first = active.find(e => ['V', 'I'].includes(e.type) && [e.terminals.n, e.terminals.p].includes(ground));
  const root = first ? (first.terminals.n === ground ? first.terminals.p : first.terminals.n) : active.find(e => e.terminals.p !== ground)?.terminals.p;
  const ranks = new Map([[root, 0]]);
  const walk = [root];
  while (walk.length) {
    const n = walk.shift();
    for (const e of active) if ([e.terminals.p, e.terminals.n].includes(n)) {
      const next = e.terminals.p === n ? e.terminals.n : e.terminals.p;
      if (next !== ground && !ranks.has(next)) { ranks.set(next, ranks.get(n) + 1); walk.push(next); }
    }
  }
  const layouts = [];
  for (const spacing of [180, 240]) for (const alternate of [false, true]) {
    const result = clone(model);
    const occ = new Set(result.elements.filter(e => keepLocked && result.geometry[e.id].locked).map(e => key(result.geometry[e.id])));
    const count = new Map();
    const sorted = [...result.elements].sort((a, b) => (a.id === first?.id ? -1 : a.type === 'GND' ? 1 : 0) - (b.id === first?.id ? -1 : b.type === 'GND' ? 1 : 0) || a.name.localeCompare(b.name));
    const lastRank = Math.max(0, ...ranks.values());
    for (const [i, e] of sorted.entries()) {
      const g = result.geometry[e.id];
      if (keepLocked && g.locked) continue;
      if (!keepLocked) g.locked = false;
      const { p, n } = e.terminals;
      const ap = ranks.get(p);
      const bn = ranks.get(n);
      let x = 180 + (i % 4) * spacing;
      let y = 180 + Math.floor(i / 4) * 160;
      let rotation = 0;
      if (e.id === first?.id) { x = 140; y = 300; rotation = n === ground ? 90 : 270; }
      else if (e.type === 'GND') { x = 320 + lastRank * spacing / 2; y = 460; }
      else if (p === ground && bn !== undefined || n === ground && ap !== undefined) {
        x = 340 + (ap ?? bn) * spacing + (lastRank ? 20 : 0);
        y = 300;
        rotation = n === ground ? 90 : 270;
      } else if (ap !== undefined && bn !== undefined) {
        x = 240 + (ap + bn) * spacing / 2;
        y = 160 + (alternate && ap === bn ? 40 : 0);
        rotation = ap <= bn ? 0 : 180;
      }
      const id = key({ x, y });
      const offset = count.get(id) || 0;
      count.set(id, offset + 1);
      if (y === 300) x += offset * (alternate ? 150 : 180);
      else y += offset * 120;
      while (occ.has(key({ x, y }))) y += 100;
      Object.assign(g, { x, y, rotation, mirror: false });
      occ.add(key(g));
    }
    const quality = route(result).quality;
    layouts.push({ model: result, quality, effectiveScore: quality.score });
  }
  const three = model.elements.find(e => e.type === 'V3');
  const amp = model.elements.find(e => e.type === 'OP');
  function alignSpecial(entries) {
    const arranged = clone(model);
    for (const [e, x, y, rotation] of entries) {
      if (!e) continue;
      const pose = arranged.geometry[e.id];
      if (!keepLocked || !pose.locked) Object.assign(pose, { x, y, rotation, mirror: false, locked: false });
    }
    const quality = route(arranged).quality;
    layouts.push({ model: arranged, quality, effectiveScore: quality.score });
  }
  if (three && three.terminals.N === ground && model.elements.length <= 5) {
    const loads = ['A', 'B', 'C'].map(phase => edges.find(e => ['R', 'C', 'L'].includes(e.type) &&
      [e.terminals.p, e.terminals.n].includes(ground) && [e.terminals.p, e.terminals.n].includes(three.terminals[phase])));
    if (loads.every(Boolean) && new Set(loads).size === 3) alignSpecial([
      [three, 160, 260, 0], ...loads.map((e, i) => [e, 610, 110 + i * 150, e.terminals.p === ground ? 180 : 0]),
      [model.elements.find(e => e.type === 'GND'), 300, 500, 0],
    ]);
  }
  if (amp && first?.type === 'V' && amp.terminals.plus === ground && amp.terminals.ref === ground && model.elements.length <= 6) {
    const { out, minus } = amp.terminals;
    const among = (a, b) => active.find(e => e.type === 'R' && [e.terminals.p, e.terminals.n].includes(a) && [e.terminals.p, e.terminals.n].includes(b));
    const input = among(root, minus);
    const feedback = among(minus, out);
    const load = among(out, ground);
    if (input && feedback && input !== feedback) alignSpecial([
      [first, 140, 320, first.terminals.n === ground ? 90 : 270], [input, 300, 345, input.terminals.p === root ? 0 : 180],
      [feedback, 460, 145, feedback.terminals.p === minus ? 0 : 180], [amp, 480, 330, 0],
      [load, 700, 380, load?.terminals.p === out ? 90 : 270], [model.elements.find(e => e.type === 'GND'), 440, 515, 0],
    ]);
  }
  // Add dedicated topology-aware layouts (bridge, Δ, Y, three-phase Δ-Y / Y-Δ)
  layouts.push(...specialLayoutCandidates(model, keepLocked));
  layouts.sort((a, b) => (a.effectiveScore ?? a.quality.score) - (b.effectiveScore ?? b.quality.score));
  const { model: next, quality } = layouts[0];
  if (!compareTopology(doc, next) || !verifyRouted(next, route(next))) throw Error('自动排版未能通过拓扑一致性检查。');
  return { model: next, ...quality };
}

/**
 * Measure visual continuity of unchanged elements between before and after documents.
 */
export function measureContinuity(beforeDoc, afterDoc, removedIds = [], addedIds = []) {
  const removedSet = new Set(removedIds);
  const addedSet = new Set(addedIds);
  const unchanged = afterDoc.elements.filter(e => !addedSet.has(e.id) && !removedSet.has(e.id) && beforeDoc.geometry[e.id]);
  if (!unchanged.length) {
    return { preservedCount: 0, unchangedTotal: 0, preservedRatio: 1, maxDisplacement: 0, meanDisplacement: 0 };
  }
  let preservedCount = 0;
  let maxDisplacement = 0;
  let sumDisplacement = 0;
  for (const e of unchanged) {
    const a = beforeDoc.geometry[e.id];
    const b = afterDoc.geometry[e.id];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d === 0 && a.rotation === b.rotation) preservedCount++;
    maxDisplacement = Math.max(maxDisplacement, d);
    sumDisplacement += d;
  }
  return {
    preservedCount,
    unchangedTotal: unchanged.length,
    preservedRatio: preservedCount / unchanged.length,
    maxDisplacement: Number(maxDisplacement.toFixed(2)),
    meanDisplacement: Number((sumDisplacement / unchanged.length).toFixed(2)),
  };
}

/**
 * Compute an anchor coordinate for a boundary port node using kept elements first, then removed elements.
 */
function portAnchor(beforeDoc, afterDoc, nodeId, keptIds) {
  const keptPins = afterDoc.elements
    .filter(e => keptIds.has(e.id))
    .flatMap(e => pinLocations(afterDoc, e))
    .filter(p => p.node === nodeId);
  if (keptPins.length) {
    return {
      x: keptPins.reduce((s, p) => s + p.x, 0) / keptPins.length,
      y: keptPins.reduce((s, p) => s + p.y, 0) / keptPins.length,
    };
  }
  const beforePins = beforeDoc.elements
    .flatMap(e => pinLocations(beforeDoc, e))
    .filter(p => p.node === nodeId);
  if (beforePins.length) {
    return {
      x: beforePins.reduce((s, p) => s + p.x, 0) / beforePins.length,
      y: beforePins.reduce((s, p) => s + p.y, 0) / beforePins.length,
    };
  }
  return { x: 360, y: 260 };
}

function orientationFromAnchors(e, aPos, bPos, aNode) {
  const dx = bPos.x - aPos.x;
  const dy = bPos.y - aPos.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const leftNode = dx >= 0 ? aNode : (e.terminals.p === aNode ? e.terminals.n : e.terminals.p);
    return orientH(e, leftNode);
  }
  const topNode = dy >= 0 ? aNode : (e.terminals.p === aNode ? e.terminals.n : e.terminals.p);
  return orientV(e, topNode);
}

/**
 * Preserve visual continuity across a single local reduction step:
 * Keep all untouched elements anchored in place and place newly created elements
 * cleanly inside the vacated region without overlap or obstruction.
 */
export function preserveLayout(beforeDoc, afterDoc, { removedIds = [], addedIds = [], rule = '', ports = [] } = {}) {
  const base = clone(afterDoc);
  const removedSet = new Set(removedIds);
  const addedSet = new Set(addedIds);
  const keptElements = base.elements.filter(e => !addedSet.has(e.id) && beforeDoc.geometry[e.id]);
  const keptIds = new Set(keptElements.map(e => e.id));

  // 1. Anchor all unchanged elements to their exact prior poses
  for (const e of keptElements) {
    base.geometry[e.id] = { ...beforeDoc.geometry[e.id] };
  }

  const addedElements = base.elements.filter(e => addedSet.has(e.id));
  if (!addedElements.length) {
    const routed = route(base);
    if (verifyRouted(base, routed)) {
      return { model: base, quality: routed.quality, continuity: measureContinuity(beforeDoc, base, removedIds, addedIds) };
    }
    const fallback = autoLayout(base, false);
    return { model: fallback.model, quality: fallback, continuity: measureContinuity(beforeDoc, fallback.model, removedIds, addedIds) };
  }

  const removedPoses = removedIds.map(id => beforeDoc.geometry[id]).filter(Boolean);
  const centroid = removedPoses.length
    ? {
      x: snap(removedPoses.reduce((s, p) => s + p.x, 0) / removedPoses.length),
      y: snap(removedPoses.reduce((s, p) => s + p.y, 0) / removedPoses.length),
    }
    : { x: 360, y: 260 };

  const keptBoxes = keptElements.map(e => box(base, e));
  const anchors = new Map(ports.map(p => [p, portAnchor(beforeDoc, base, p, keptIds)]));
  const collidesKept = (doc, ids) => {
    const newBoxes = ids.map(id => box(doc, doc.elements.find(e => e.id === id)));
    for (let i = 0; i < newBoxes.length; i++) {
      for (const kb of keptBoxes) if (boxesOverlap(newBoxes[i], kb, 10)) return true;
      for (let j = i + 1; j < newBoxes.length; j++) if (boxesOverlap(newBoxes[i], newBoxes[j], 10)) return true;
    }
    return false;
  };

  const candidatesList = [];
  const evaluate = poses => {
    const cand = clone(base);
    for (const [id, pose] of poses) {
      cand.geometry[id] = { x: snap(pose.x), y: snap(pose.y), rotation: pose.rotation, mirror: false, locked: false };
    }
    const overlapPenalty = collidesKept(cand, addedIds) ? 4000 : 0;
    const drawing = route(cand);
    const valid = verifyRouted(cand, drawing);
    const distFromCentroid = poses.reduce((s, [, p]) => s + Math.hypot(p.x - centroid.x, p.y - centroid.y), 0) / Math.max(1, poses.length);
    const score = drawing.quality.score + overlapPenalty + distFromCentroid * 0.25 + (valid ? 0 : 1e6);
    candidatesList.push({ model: cand, quality: drawing.quality, valid, overlapPenalty, score });
  };

  // 2. Generate rule-specific local placement candidates
  if (addedElements.length === 1) {
    const e = addedElements[0];
    const pA = anchors.get(ports[0]) || centroid;
    const pB = anchors.get(ports[1]) || centroid;
    const preferredRot = orientationFromAnchors(e, pA, pB, ports[0]);
    const altRot = preferredRot % 180 === 0 ? orientV(e, ports[0]) : orientH(e, ports[0]);
    const seedPositions = [
      ...removedPoses.map(p => ({ x: p.x, y: p.y, rotation: p.rotation })),
      { x: centroid.x, y: centroid.y, rotation: preferredRot },
      { x: snap((pA.x + pB.x) / 2), y: snap((pA.y + pB.y) / 2), rotation: preferredRot },
      { x: centroid.x, y: centroid.y, rotation: altRot },
    ];
    for (const dx of [0, -80, 80, -140, 140]) {
      for (const dy of [0, -80, 80, -140, 140]) {
        if (dx === 0 && dy === 0) continue;
        seedPositions.push({ x: centroid.x + dx, y: centroid.y + dy, rotation: preferredRot });
      }
    }
    const seen = new Set();
    for (const pos of seedPositions) {
      const k = `${snap(pos.x)},${snap(pos.y)},${pos.rotation}`;
      if (seen.has(k)) continue;
      seen.add(k);
      evaluate([[e.id, pos]]);
    }
  } else if (addedElements.length === 2) {
    // Source transformation (V+R <-> I||R)
    const [e0, e1] = addedElements;
    const pA = anchors.get(ports[0]) || centroid;
    const pB = anchors.get(ports[1]) || centroid;
    const mainRot0 = orientationFromAnchors(e0, pA, pB, e0.terminals.p);
    const mainRot1 = orientationFromAnchors(e1, pA, pB, e1.terminals.p);
    const isHorizontal = mainRot0 % 180 === 0;
    const isParallelOut = e0.terminals.p === e1.terminals.p || e0.terminals.p === e1.terminals.n && e0.terminals.n === e1.terminals.p;
    if (isParallelOut) {
      // Parallel I || R: place side-by-side
      const shifts = isHorizontal ? [[0, -60, 0, 60], [0, 0, 0, 120], [0, 0, 0, -120]] : [[-70, 0, 70, 0], [0, 0, 140, 0], [0, 0, -140, 0]];
      for (const [dx0, dy0, dx1, dy1] of shifts) {
        evaluate([
          [e0.id, { x: centroid.x + dx0, y: centroid.y + dy0, rotation: mainRot0 }],
          [e1.id, { x: centroid.x + dx1, y: centroid.y + dy1, rotation: mainRot1 }],
        ]);
      }
    } else {
      // Series V + R: place end-to-end along dominant axis
      const shifts = isHorizontal ? [[-80, 0, 80, 0], [80, 0, -80, 0]] : [[0, -70, 0, 70], [0, 70, 0, -70]];
      for (const [dx0, dy0, dx1, dy1] of shifts) {
        evaluate([
          [e0.id, { x: centroid.x + dx0, y: centroid.y + dy0, rotation: mainRot0 }],
          [e1.id, { x: centroid.x + dx1, y: centroid.y + dy1, rotation: mainRot1 }],
        ]);
      }
    }
    if (removedPoses.length >= 2) {
      evaluate([
        [e0.id, { x: removedPoses[0].x, y: removedPoses[0].y, rotation: mainRot0 }],
        [e1.id, { x: removedPoses[1].x, y: removedPoses[1].y, rotation: mainRot1 }],
      ]);
    }
  } else if (addedElements.length === 3 && rule === 'deltaStar') {
    // Δ -> Y: place 3 arms radiating from local center toward the 3 port anchors
    const centerNode = addedElements[0].terminals.n;
    const portInfo = addedElements.map(e => {
      const port = e.terminals.p === centerNode ? e.terminals.n : e.terminals.p;
      return { e, port, anchor: anchors.get(port) || centroid };
    });
    // Sort by y then x to determine top/bottom stem vs left/right arms
    const byY = [...portInfo].sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x);
    const byX = [...portInfo].sort((a, b) => a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);

    const templates = [
      // Top stem + left/right horizontal arms (classic upper bridge Δ->Y!)
      (cx, cy, sx, sy) => {
        const stem = byY[0];
        const rest = byY.slice(1).sort((a, b) => a.anchor.x - b.anchor.x);
        return [
          [stem.e.id, { x: cx, y: cy - sy, rotation: orientV(stem.e, stem.port) }],
          [rest[0].e.id, { x: cx - sx, y: cy + 40, rotation: orientH(rest[0].e, rest[0].port) }],
          [rest[1].e.id, { x: cx + sx, y: cy + 40, rotation: orientH(rest[1].e, centerNode) }],
        ];
      },
      // Bottom stem + left/right horizontal arms (classic lower bridge Δ->Y / T-network!)
      (cx, cy, sx, sy) => {
        const stem = byY[2];
        const rest = byY.slice(0, 2).sort((a, b) => a.anchor.x - b.anchor.x);
        return [
          [stem.e.id, { x: cx, y: cy + sy, rotation: orientV(stem.e, centerNode) }],
          [rest[0].e.id, { x: cx - sx, y: cy - 40, rotation: orientH(rest[0].e, rest[0].port) }],
          [rest[1].e.id, { x: cx + sx, y: cy - 40, rotation: orientH(rest[1].e, centerNode) }],
        ];
      },
      // Left stem + top/bottom vertical arms
      (cx, cy, sx, sy) => {
        const stem = byX[0];
        const rest = byX.slice(1).sort((a, b) => a.anchor.y - b.anchor.y);
        return [
          [stem.e.id, { x: cx - sx, y: cy, rotation: orientH(stem.e, stem.port) }],
          [rest[0].e.id, { x: cx + 40, y: cy - sy, rotation: orientV(rest[0].e, rest[0].port) }],
          [rest[1].e.id, { x: cx + 40, y: cy + sy, rotation: orientV(rest[1].e, centerNode) }],
        ];
      },
      // Right stem + top/bottom vertical arms
      (cx, cy, sx, sy) => {
        const stem = byX[2];
        const rest = byX.slice(0, 2).sort((a, b) => a.anchor.y - b.anchor.y);
        return [
          [stem.e.id, { x: cx + sx, y: cy, rotation: orientH(stem.e, centerNode) }],
          [rest[0].e.id, { x: cx - 40, y: cy - sy, rotation: orientV(rest[0].e, rest[0].port) }],
          [rest[1].e.id, { x: cx - 40, y: cy + sy, rotation: orientV(rest[1].e, centerNode) }],
        ];
      },
    ];
    for (const tmpl of templates) {
      for (const [sx, sy] of [[120, 80], [100, 100]]) {
        evaluate(tmpl(centroid.x, centroid.y, sx, sy));
      }
    }
  } else if (addedElements.length === 3 && rule === 'starDelta') {
    // Y -> Δ: place 3 Δ branches spanning the 3 port anchors
    const portInfo = ports.map(p => ({ port: p, anchor: anchors.get(p) || centroid }));
    const byY = [...portInfo].sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x);
    const findEdge = (u, v) => addedElements.find(e => (e.terminals.p === u && e.terminals.n === v) || (e.terminals.p === v && e.terminals.n === u));

    // Π-template: top horizontal between top two ports + two vertical legs to bottom port
    const topTwo = byY.slice(0, 2).sort((a, b) => a.anchor.x - b.anchor.x);
    const bot = byY[2];
    const eTop = findEdge(topTwo[0].port, topTwo[1].port);
    const eLeft = findEdge(topTwo[0].port, bot.port);
    const eRight = findEdge(topTwo[1].port, bot.port);
    if (eTop && eLeft && eRight) {
      for (const [sx, sy] of [[120, 80], [140, 100]]) {
        evaluate([
          [eTop.id, { x: centroid.x, y: centroid.y - sy, rotation: orientH(eTop, topTwo[0].port) }],
          [eLeft.id, { x: centroid.x - sx, y: centroid.y + 40, rotation: orientV(eLeft, topTwo[0].port) }],
          [eRight.id, { x: centroid.x + sx, y: centroid.y + 40, rotation: orientV(eRight, topTwo[1].port) }],
        ]);
      }
    }
    // Inverted-Π / Δ-template: apex at top + bottom horizontal between lower two ports
    const apex = byY[0];
    const botTwo = byY.slice(1).sort((a, b) => a.anchor.x - b.anchor.x);
    const eAL = findEdge(apex.port, botTwo[0].port);
    const eAR = findEdge(apex.port, botTwo[1].port);
    const eBot = findEdge(botTwo[0].port, botTwo[1].port);
    if (eAL && eAR && eBot) {
      for (const [sx, sy] of [[120, 80], [140, 100]]) {
        evaluate([
          [eAL.id, { x: centroid.x - sx, y: centroid.y - 40, rotation: orientV(eAL, apex.port) }],
          [eAR.id, { x: centroid.x + sx, y: centroid.y - 40, rotation: orientV(eAR, apex.port) }],
          [eBot.id, { x: centroid.x, y: centroid.y + sy, rotation: orientH(eBot, botTwo[0].port) }],
        ]);
      }
    }
  }

  candidatesList.sort((a, b) => a.score - b.score);
  const best = candidatesList[0];
  if (best && best.valid && best.overlapPenalty === 0 && best.quality.overlaps === 0 && best.quality.obstructions === 0) {
    return {
      model: best.model,
      quality: best.quality,
      continuity: measureContinuity(beforeDoc, best.model, removedIds, addedIds),
    };
  }

  // Try locking all untouched elements and letting autoLayout place only the new elements
  const lockedBase = clone(base);
  for (const e of keptElements) lockedBase.geometry[e.id].locked = true;
  for (const id of addedIds) if (lockedBase.geometry[id]) lockedBase.geometry[id].locked = false;
  try {
    const lockedAttempt = autoLayout(lockedBase, true);
    for (const e of keptElements) lockedAttempt.model.geometry[e.id].locked = beforeDoc.geometry[e.id].locked;
    if (lockedAttempt.overlaps === 0 && lockedAttempt.obstructions === 0) {
      return {
        model: lockedAttempt.model,
        quality: lockedAttempt,
        continuity: measureContinuity(beforeDoc, lockedAttempt.model, removedIds, addedIds),
      };
    }
  } catch { /* fall through */ }

  // If best local placement was still valid with zero overlaps, prefer visual continuity over full re-layout
  if (best && best.valid && best.quality.overlaps === 0 && best.quality.obstructions === 0) {
    return {
      model: best.model,
      quality: best.quality,
      continuity: measureContinuity(beforeDoc, best.model, removedIds, addedIds),
    };
  }

  // Last resort: full autoLayout to guarantee topological & visual validity
  const fallback = autoLayout(base, false);
  return {
    model: fallback.model,
    quality: fallback,
    continuity: measureContinuity(beforeDoc, fallback.model, removedIds, addedIds),
  };
}
