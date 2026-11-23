import { clone, compareTopology, referenceNode } from './model.js';

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
    layouts.push({ model: result, quality: route(result).quality });
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
    layouts.push({ model: arranged, quality: route(arranged).quality });
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
  layouts.sort((a, b) => a.quality.score - b.quality.score);
  const { model: next, quality } = layouts[0];
  if (!compareTopology(doc, next) || !verifyRouted(next, route(next))) throw Error('自动排版未能通过拓扑一致性检查。');
  return { model: next, ...quality };
}
