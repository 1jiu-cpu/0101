const angleStep = Math.PI / 60;
const axes = Array.from({ length: 60 }, (_, i) => [Math.cos(i * angleStep), Math.sin(i * angleStep)]);
const unit = (x, y) => Math.hypot(x, y);
export const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const plus = (a, b, t) => ({ x: a.x + b.x * t, y: a.y + b.y * t });
const normal = u => ({ x: -u.y, y: u.x });
const length = s => s.length;
const fraction = (s, p) => dot(sub(p, s.start), s.u);
const distance = (s, p) => Math.abs(cross(s.u, sub(p, s.start)));
const within = (s, t, pad = 0) => t >= -pad && t <= s.length + pad;
export const ink = (im, x, y) => {
  x = Math.round(x);
  y = Math.round(y);
  return x >= 0 && y >= 0 && x < im.width && y < im.height && im.data[y * im.width + x];
};

export function inkNear(im, pt, r = 1) {
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (ink(im, pt.x + i, pt.y + j)) return true;
  return false;
}

function fit(points, dx, dy) {
  if (points.length < 3) return null;
  const count = points.length;
  const x = points.reduce((s, p) => s + p[0], 0) / count;
  const y = points.reduce((s, p) => s + p[1], 0) / count;
  let xx = 0, xy = 0, yy = 0;
  for (const [px, py] of points) {
    const a = px - x, b = py - y;
    xx += a * a; xy += a * b; yy += b * b;
  }
  const theta = .5 * Math.atan2(2 * xy, xx - yy);
  const sign = dx * Math.cos(theta) + dy * Math.sin(theta) < 0 ? -1 : 1;
  const u = { x: sign * Math.cos(theta), y: sign * Math.sin(theta) };
  const center = { x, y };
  let lo = Infinity, hi = -Infinity, deviation = 0;
  for (const [px, py] of points) {
    const a = px - x, b = py - y;
    const projection = a * u.x + b * u.y;
    lo = Math.min(lo, projection);
    hi = Math.max(hi, projection);
    deviation += (a * u.y - b * u.x) ** 2;
  }
  const start = plus(center, u, lo), end = plus(center, u, hi);
  return { start, end, u, length: hi - lo, thickness: Math.max(1, Math.sqrt(deviation / count) * 3.3), angle: Math.atan2(u.y, u.x) };
}

function thin(im) {
  const { width: w, height: h } = im;
  const grid = im.data.slice();
  const active = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (grid[y * w + x]) active.push(y * w + x);
  let previousCount = 0;
  for (let pass = 0; pass < 24; pass++) {
    const removed = [];
    for (const i of active) {
      if (!grid[i]) continue;
      const p = [grid[i - w], grid[i - w + 1], grid[i + 1], grid[i + w + 1], grid[i + w], grid[i + w - 1], grid[i - 1], grid[i - w - 1]];
      const total = p.reduce((a, b) => a + b, 0);
      if (total < 2 || total > 6 || p.filter((v, j) => !v && p[(j + 1) % 8]).length !== 1) continue;
      const blocked = pass % 2 === 0 ? (p[0] && p[2] && p[4]) || (p[2] && p[4] && p[6]) : (p[0] && p[2] && p[6]) || (p[0] && p[4] && p[6]);
      if (!blocked) removed.push(i);
    }
    removed.forEach(i => { grid[i] = 0; });
    if (!removed.length && !previousCount && pass % 2 === 1) break;
    previousCount = removed.length;
  }
  return grid;
}

export function straightSegments(im, minimum) {
  const skeleton = thin(im);
  const positions = [];
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (skeleton[y * im.width + x]) positions.push([x, y]);
  }
  if (positions.length > 140000) return [];
  const radius = Math.ceil(unit(im.width, im.height));
  const candidates = [];
  for (const [rawX, rawY] of axes) {
    const dx = rawX < -.001 ? -rawX : rawX;
    const dy = rawX < -.001 ? -rawY : rawY;
    const bins = Array.from({ length: radius * 2 + 3 }, () => []);
    for (const pt of positions) {
      const id = Math.round(-dy * pt[0] + dx * pt[1]) + radius;
      bins[id].push(pt);
    }
    const counts = bins.map((band, i) => band.length + (bins[i - 1]?.length ?? 0) + (bins[i + 1]?.length ?? 0));
    for (let i = 2; i < counts.length - 2; i++) {
      if (counts[i] < minimum * .78 || counts[i] < counts[i - 1] || counts[i] <= counts[i + 1]) continue;
      const points = [...bins[i - 1], ...bins[i], ...bins[i + 1]].map(pt => ({ pt, t: pt[0] * dx + pt[1] * dy })).sort((a, b) => a.t - b.t);
      let start = 0;
      for (let j = 1; j <= points.length; j++) {
        if (j < points.length && points[j].t - points[j - 1].t <= 3) continue;
        if (points[j - 1].t - points[start].t >= minimum - 1) {
          const segment = fit(points.slice(start, j).map(p => p.pt), dx, dy);
          if (segment?.length >= minimum - 1 && Math.abs(cross(segment.u, { x: dx, y: dy })) < .09) {
            const samples = Array.from({ length: Math.ceil(segment.length) }, (_, k) => plus(segment.start, segment.u, k + .5));
            const score = samples.filter(p => ink(im, p.x, p.y)).length / samples.length;
            if (score >= .84) candidates.push({ ...segment, support: score });
          }
        }
        start = j;
      }
    }
  }
  const result = [];
  for (const s of candidates.sort((a, b) => length(b) * b.support ** 3 - length(a) * a.support ** 3 || a.thickness - b.thickness)) {
    if (result.some(t => {
      if (Math.abs(cross(s.u, t.u)) > .16) return false;
      const [a, b] = [fraction(t, s.start), fraction(t, s.end)].sort((x, y) => x - y);
      const overlap = Math.min(b, t.length) - Math.max(a, 0);
      return overlap >= s.length * .65 && Math.min(distance(t, s.start), distance(t, s.end)) <= 3.3 &&
        distance(t, plus(s.start, s.u, s.length / 2)) <= 3.8;
    })) continue;
    const middle = plus(s.start, s.u, s.length / 2);
    const v = normal(s.u);
    const thickness = [.25, .45, .65].map(f => {
      const spot = plus(s.start, s.u, s.length * f);
      let width = 1;
      for (const direction of [-1, 1]) for (let k = 1; k <= 6 && ink(im, spot.x + v.x * k * direction, spot.y + v.y * k * direction); k++) width++;
      return width;
    }).sort((a, b) => a - b)[1];
    const reverse = Math.abs(s.u.x) < .09 ? s.u.y < 0 : s.u.x < 0;
    result.push({ ...s, middle, thickness, id: result.length, ...(reverse ? { start: s.end, end: s.start, u: { x: -s.u.x, y: -s.u.y }, angle: Math.atan2(-s.u.y, -s.u.x) } : {}) });
    if (result.length >= 420) break;
  }
  return result;
}

const pointsOnRing = Array.from({ length: 56 }, (_, k) => [Math.cos(k * Math.PI / 28), Math.sin(k * Math.PI / 28)]);
function coverage(im, points, point, margin) {
  return points.filter(([x, y]) => inkNear(im, point(x, y), margin)).length / points.length;
}

const boxSides = [
  Array.from({ length: 13 }, (_, k) => [k / 6 - 1, -1]),
  Array.from({ length: 13 }, (_, k) => [k / 6 - 1, 1]),
  Array.from({ length: 9 }, (_, k) => [-1, k / 4 - 1]),
  Array.from({ length: 9 }, (_, k) => [1, k / 4 - 1]),
];

const zigzags = Array.from({length: 5}, (_, i) => i + 4).flatMap(n => [-1, 1].map(sign => {
  const vertices = [[-1, 0], ...Array.from({ length: n }, (_, i) => [-.82 + 1.64 * i / (n - 1), (i % 2 ? 1 : -1) * sign]), [1, 0]];
  return vertices.slice(1).flatMap(([x, y], i) => Array.from({ length: 10 }, (_, k) => [
    vertices[i][0] + (x - vertices[i][0]) * k / 10, vertices[i][1] + (y - vertices[i][1]) * k / 10,
  ]));
}));

function classifyGap(im, a, b, u, gap) {
  const center = { x: (a.end.x + b.start.x) / 2, y: (a.end.y + b.start.y) / 2 };
  const v = normal(u);
  const margin = Math.max(1, Math.min(3, Math.round((a.thickness + b.thickness) / 4) + 1));
  const loc = (s, t) => plus(plus(center, u, s), v, t);
  let best = null;
  const add = (type, score, half, height) => {
    if (!best || score > best.score) best = { type, score, half, height, ...center, u };
  };
  for (const width of [gap / 2 - 1, gap / 2 + 1, gap / 2 + 3]) {
    if (width < 7) continue;
    for (const ratio of [.87, .97, 1.05, 1.14]) {
      const height = width * ratio;
      const ring = coverage(im, pointsOnRing, (x, y) => loc(x * width, y * height), margin);
      if (ring >= .9 && pointsOnRing.filter(([x, y]) => Math.abs(y) > .55)
        .filter(([x, y]) => inkNear(im, loc(x * width, y * height), margin)).length >= 30) add('V', .1 + .9 * ring, width, height);
    }
    for (const ratio of [.21, .27, .33, .40, .47, .55, .64, .74]) {
      const height = width * ratio;
      if (height < 4) continue;
      const point = (x, y) => loc(x * width, y * height);
      const matches = boxSides.map(side => coverage(im, side, point, margin));
      if (Math.min(...matches) >= .76) {
        let clear = 0;
        for (const dx of [-.5,-.25,0,.25,.5]) for (const dy of [-.5,0,.5]) clear += Number(!inkNear(im, point(dx, dy), 0));
        if (clear >= 12) add('R', .04 + .96 * matches.reduce((sum, n) => sum + n / 4, 0), width, height);
      }
      if (best?.score >= .94) continue;
      for (const path of zigzags) {
        const match = coverage(im, path, point, margin);
        if (match >= .94) add('R', match * .94, width, height);
      }
    }
  }
  return best;
}

function rectangleSymbols(im, rails, minimum, existing) {
  const pairs = rails.filter(r => r.length >= Math.max(21, minimum) && r.length <= 88 && r.support >= .94);
  const candidates = [];
  for (const [i, a] of pairs.entries()) for (const b of pairs.slice(i + 1)) {
    if (dot(a.u, b.u) < .99 || Math.abs(a.length - b.length) > Math.min(a.length, b.length) * .31) continue;
    const offset = distance(a, b.middle);
    if (offset < 8 || offset > 25 || Math.abs(fraction(a, b.middle) - a.length / 2) > 5) continue;
    const u = a.u, v = normal(u);
    const center = { x: (a.middle.x + b.middle.x) / 2, y: (a.middle.y + b.middle.y) / 2 };
    if (existing.some(e => unit(e.x-center.x,e.y-center.y) < e.half + 6)) continue;
    const half = (a.length + b.length) / 4;
    const height = offset / 2;
    if (height / half < .18 || height / half > .64) continue;
    const point = (x, y) => plus(plus(center, u, x * half), v, y * height);
    const matches = boxSides.map(side => coverage(im, side, point, 2));
    if (Math.min(...matches) < .84 || [[-.5,0],[0,0],[.5,0],[-.5,.5],[.5,-.5]].some(([x,y])=>inkNear(im,point(x,y),0))) continue;
    const leads = [-1, 1].map(sign => {
      const start = plus(center, u, sign * (half + 2));
      const direction = { x: sign * u.x, y: sign * u.y };
      let end = 0;
      for (let j = 1, skipped = 0; j <= 54; j++) {
        if (inkNear(im, plus(start, direction, j), 1)) { end = j; skipped = 0; }
        else if (++skipped > 2) break;
      }
      return end >= 10 ? { start, end: plus(start, direction, end), u: direction, length: end } : null;
    });
    if (leads.every(Boolean)) candidates.push({ ...center, u, half, height, leads, score: Math.min(...matches), type: 'R',
      h: Math.abs(u.x) >= Math.abs(u.y), angle: Math.atan2(u.y, u.x) * 180 / Math.PI });
  }
  for (const c of candidates.sort((a,b)=>b.score-a.score)) {
    if (existing.some(e => unit(e.x-c.x,e.y-c.y) < Math.min(e.half,c.half))) continue;
    const [a,b] = c.leads;
    const one = rails.length;
    rails.push({ ...a, id: one, start: a.end, end: a.start, u: c.u, thickness: 2, support: .93 }, { ...b, id: one+1, thickness: 2, support: .93 });
    const { leads, ...final } = c;
    existing.push({ ...final, a: one, b: one+1 });
  }
  return existing;
}

export function orientedSymbols(im, wires, minimum) {
  const possibles = [];
  for (const a of wires) for (const b of wires) {
    if (a === b || dot(a.u, b.u) < .965) continue;
    const gap = fraction(a, b.start) - a.length;
    if (gap < 10 || gap > Math.min(115, minimum * 6)) continue;
    if (distance(a, b.start) > 4 + gap * .09 || distance(b, a.end) > 4 + gap * .09) continue;
    const connecting = sub(b.start, a.end);
    const span = unit(connecting.x, connecting.y);
    const u = { x: connecting.x / span, y: connecting.y / span };
    if (Math.min(dot(u, a.u), dot(u, b.u)) < .95) continue;
    const c = classifyGap(im, a, b, u, span);
    if (!c || c.score < .925) continue;
    const rank = c.score + Math.min(90, Math.min(a.length, b.length)) * .0006;
    possibles.push({ ...c, a: a.id, b: b.id, rank, h: Math.abs(c.u.x) >= Math.abs(c.u.y), angle: Math.atan2(c.u.y, c.u.x) * 180 / Math.PI });
  }
  const symbols = [];
  for (const s of possibles.sort((a, b) => b.rank - a.rank)) {
    if (!symbols.some(c => unit(c.x - s.x, c.y - s.y) < Math.max(9, Math.min(c.half, s.half)) ||
      c.a === s.a || c.b === s.b)) symbols.push(s);
  }
  return rectangleSymbols(im, wires, minimum, symbols);
}

function offStrokeDot(im, pt, a, b) {
  const r = Math.max(3, Math.round(Math.max(a.thickness, b.thickness) * 1.3));
  const samples = pointsOnRing.map(([x, y]) => ({ x: pt.x + x * r, y: pt.y + y * r }))
    .filter(p => Math.abs(cross(a.u, sub(p, pt))) > r * .62 && Math.abs(cross(b.u, sub(p, pt))) > r * .62);
  return samples.length > 5 && samples.filter(p => ink(im, p.x, p.y)).length / samples.length >= .77;
}

function terminalRing(im, point) {
  return [-2, 0, 2].some(dx => [-2, 0, 2].some(dy => {
    const center = { x: point.x + dx, y: point.y + dy };
    if (ink(im, center.x, center.y)) return false;
    return [3, 4, 5].some(radius => pointsOnRing.filter(([x, y]) => inkNear(im, { x: center.x + x * radius, y: center.y + y * radius }, 1)).length >= 45);
  }));
}

export function joinSegments(im, segments) {
  const joins = [];
  for (const [i, a] of segments.entries()) for (const b of segments.slice(i + 1)) {
    const turn = cross(a.u, b.u);
    const d = sub(b.start, a.start);
    if (Math.abs(turn) < .13) {
      if (Math.min(distance(a, b.start), distance(a, b.end)) <= 2.6) {
        const [start, end] = [fraction(a, b.start), fraction(a, b.end)].sort((x, y) => x - y);
        if (Math.min(distance(b, a.start), distance(b, a.end)) <= 3.1) {
          const gap = Math.max(start - a.length, -end);
          const center = plus(a.start, a.u, start > a.length ? (start + a.length) / 2 : end / 2);
          if (gap <= 3 || gap <= 12 && terminalRing(im, center)) joins.push({ a: a.id, b: b.id, connected: true });
        }
      }
      continue;
    }
    const p = cross(d, b.u) / turn;
    const q = cross(d, a.u) / turn;
    const pad = Math.abs(turn) > .55 ? 5 : 3;
    if (!within(a, p, 9) || !within(b, q, 9)) continue;
    const point = plus(a.start, a.u, p);
    const x = Math.round(point.x), y = Math.round(point.y);
    if ((!within(a, p, pad) || !within(b, q, pad) || !inkNear(im, point, 2)) &&
        !(!within(a, p, -pad) && !within(b, q, -pad) && terminalRing(im, point))) continue;
    const interior = within(a, p, -pad) && within(b, q, -pad);
    const dotJunction = interior && offStrokeDot(im, point, a, b);
    joins.push({ a: a.id, b: b.id, x, y, connected: !interior || dotJunction, ...(interior ? { crossing: true, confidence: dotJunction ? .94 : .8 } : {}) });
  }
  return joins;
}

export function insideSymbol(s, point, pad) {
  const delta = sub(point, s);
  return Math.abs(dot(delta, s.u)) <= s.half + pad && Math.abs(cross(s.u, delta)) <= s.height + pad;
}

export function connectOriented(im, wires, symbols, minimum) {
  const leads = new Set(symbols.flatMap(s => [s.a, s.b]));
  const likely = wires.filter(s => leads.has(s.id) || (s.length >= minimum * 1.75 && s.support >= .93 &&
    !symbols.some(c => insideSymbol(c, s.start, 6) && insideSymbol(c, s.end, 6))));
  const joins = joinSegments(im, likely);
  const groups = new Map(likely.map(s => [s.id, s.id]));
  const root = id => {
    let k = id;
    while (groups.get(k) !== k && groups.has(k)) k = groups.get(k);
    return k;
  };
  for (const j of joins) if (j.connected) groups.set(root(j.a), root(j.b));
  const included = new Set([...leads].map(root));
  const kept = likely.filter(w => included.has(root(w.id)));
  const ids = new Set(kept.map(w => w.id));
  const crossings = [];
  const selected = joins.filter(j => {
    if (!ids.has(j.a) || !ids.has(j.b)) return false;
    if (!j.crossing || j.connected) return true;
    if (root(j.a) === root(j.b)) return false;
    if (crossings.some(c => unit(c.x - j.x, c.y - j.y) < 5 &&
      [root(c.a), root(c.b)].includes(root(j.a)) && [root(c.a), root(c.b)].includes(root(j.b)))) return false;
    crossings.push(j);
    return true;
  });
  return { wires: kept, joins: selected, root };
}

function regions(data, width, height) {
  const ids = new Int32Array(data.length);
  let count = 0;
  const queue = new Int32Array(data.length);
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || ids[start]) continue;
    const label = ++count;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    ids[start] = label;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = (p - x) / width;
      for (let j = Math.max(0, y - 1); j <= Math.min(height - 1, y + 1); j++) {
        for (let i = Math.max(0, x - 1); i <= Math.min(width - 1, x + 1); i++) {
          const q = j * width + i;
          if (data[q] && !ids[q]) { ids[q] = label; queue[tail++] = q; }
        }
      }
    }
  }
  return ids;
}

function clearArea(im, data, x, y, r, condition) {
  for (let b = Math.max(0, Math.floor(y - r)); b <= Math.min(im.height - 1, Math.ceil(y + r)); b++) {
    for (let a = Math.max(0, Math.floor(x - r)); a <= Math.min(im.width - 1, Math.ceil(x + r)); a++) {
      if (condition(a, b)) data[b * im.width + a] = 0;
    }
  }
}

function sampleRegions(ids, im, start, direction, from, to, radius = 2) {
  const counts = new Map();
  for (let step = from; step <= to; step++) {
    const point = plus(start, direction, step);
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
      const a = Math.round(point.x) + x, b = Math.round(point.y) + y;
      if (a < 0 || b < 0 || a >= im.width || b >= im.height) continue;
      const id = ids[b * im.width + a];
      if (id) counts.set(id, (counts.get(id) || 0) + (x || y ? 1 : 2));
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function traceWires(im, rails, symbols, minimum) {
  const wireMap = new Map(rails.map(w => [w.id, w]));
  const data = im.data.slice();
  for (const c of symbols) {
    clearArea(im, data, c.x, c.y, unit(c.half, c.height) + 6, (x, y) => insideSymbol(c, { x, y }, 3));
  }
  const crossings = [];
  for (const j of joinSegments(im, rails.filter(w => w.length >= minimum * 2.15 && w.support >= .96))) {
    if (!j.crossing || j.connected || symbols.some(s => insideSymbol(s, j, 12))) continue;
    const a = wireMap.get(j.a), b = wireMap.get(j.b);
    // Only cut verified through-lines. A corner, terminal or T must retain
    // its pixel connectivity even if a small fitted fragment crosses it.
    const enough = w => {
      const along = fraction(w, j);
      return along >= 10 && w.length - along >= 10 && [-1, 1].every(sign =>
        [4, 7, 10].every(k => inkNear(im, plus(j, w.u, k * sign), 1)));
    };
    if (!enough(a) || !enough(b) || Math.abs(cross(a.u, b.u)) < .35) continue;
    if (crossings.some(c => unit(c.x - j.x, c.y - j.y) < 7)) continue;
    const r = Math.max(4, Math.min(8, Math.ceil(Math.max(a.thickness, b.thickness) * 1.6)));
    clearArea(im, data, j.x, j.y, r, (x, y) => unit(x - j.x, y - j.y) <= r);
    crossings.push({ ...j, a, b, r });
  }
  const ids = regions(data, im.width, im.height);
  const ports = new Map();
  for (const s of symbols) {
    for (const [idx, id] of [s.a, s.b].entries()) {
      const rail = wireMap.get(id);
      const anchor = idx ? rail.start : rail.end;
      const outward = idx ? rail.u : { x: -rail.u.x, y: -rail.u.y };
      const group = sampleRegions(ids, im, anchor, outward, 4, Math.max(5, Math.min(rail.length - 2, 17)));
      if (group) ports.set(id, group);
    }
  }
  const complete = symbols.filter(s => ports.has(s.a) && ports.has(s.b));
  const paths = [];
  const crossed = [];
  const roots = new Map([...ports.values()].map(group => [group, group]));
  const root = id => {
    if (!roots.has(id)) roots.set(id, id);
    while (roots.get(id) !== id) id = roots.get(id);
    return id;
  };
  for (const c of crossings) {
    const branches = [c.a, c.b].map(w => [-1, 1].map(sign => sampleRegions(ids, im, c, { x: sign * w.u.x, y: sign * w.u.y }, c.r + 2, c.r + 8, 1)));
    for (const [a,b] of branches) if (a && b && a !== b) { roots.set(root(a), root(b)); paths.push({ a, b, connected: true }); }
    if (branches[0][0] && branches[1][0]) crossed.push({ a: branches[0][0], b: branches[1][0], x: c.x, y: c.y, connected: false, crossing: true, confidence: .85 });
  }
  const retained = new Set(complete.flatMap(s => [ports.get(s.a), ports.get(s.b)]).map(root));
  const include = id => retained.has(root(id));
  const joins = [...paths, ...crossed].filter(j => include(j.a) && include(j.b) && (j.connected || root(j.a) !== root(j.b)));
  const wires = [...new Set([...ports.values()].filter(include).concat(joins.flatMap(j => [j.a, j.b])))].map(id => ({ id }));
  return { wires, joins, root, ports, complete };
}

function arrowScore(im, head, direction, width) {
  const v = normal(direction);
  const strokes = [-1, 1].map(sign => {
    let hits = 0;
    for (let i = 2; i <= 7; i++) {
      const t = i / 7 * width;
      const pos = plus(plus(head, direction, -t), v, sign * t * .43);
      hits += Number(inkNear(im, pos, 1));
    }
    return hits / 6;
  });
  if (Math.min(...strokes) < .83) return 0;
  const edge = plus(head, direction, -width * 1.3);
  const outside = [-1, 1].filter(sign => inkNear(im, plus(edge, v, sign * width * .52), 0)).length;
  return outside === 0 ? Math.min(...strokes) : 0;
}

function filledArrow(im, head, direction, length) {
  if (length < 16) return 0;
  const v = normal(direction);
  const width = distance => {
    const center = plus(head, direction, -distance);
    if (!inkNear(im, center, 1)) return 0;
    let count = 0;
    for (let k = -7; k <= 7; k++) {
      const point = plus(center, v, k);
      count += Number(Boolean(ink(im, point.x, point.y)));
    }
    return count;
  };
  const near = Array.from({ length: 12 }, (_, i) => width(i - 2));
  const away = [13, 16, Math.min(length - 1, 20)].map(width).sort((a, b) => a - b)[1];
  const peak = Math.max(...near);
  const broad = near.filter(n => n >= away + 2).length;
  return away >= 1 && peak >= Math.max(5, away + 3) && broad >= 2 && width(-5) < peak * .63 ? Math.min(1, (peak - away) / 6 + .33) : 0;
}

export function findVoltageDirection(im, symbol, rails, label) {
  const { u, half } = symbol;
  const arrows = [];
  for (const wire of rails) {
    if (wire.id === symbol.a || wire.id === symbol.b || Math.abs(dot(u, wire.u)) < .958 || wire.length > half * 4.1 || wire.length < half * .68) continue;
    const center = plus(wire.start, wire.u, wire.length / 2);
    const dx = sub(center, symbol);
    const lateral = Math.abs(cross(u, dx));
    const longitudinal = Math.abs(dot(u, dx));
    if (lateral < half * 1.03 || lateral > half * 2.65 + 5 || longitudinal > half * 1.6 + 6) continue;
    for (const [head, direction] of [[wire.end, wire.u], [wire.start, { x: -wire.u.x, y: -wire.u.y }]]) {
      const filled = filledArrow(im, head, direction, wire.length);
      const outline = Math.max(0, ...[-2, 0, 2].flatMap(shift =>
        [8, 10, 12, 15].filter(w => w >= 2.8 * wire.thickness).map(w => arrowScore(im, plus(head, direction, shift), direction, w))));
      const shape = Math.max(filled, outline * .84);
      if (shape) {
        const toLabel = label ? unit(Math.max(label.x - center.x, center.x - (label.end ?? label.x), 0), center.y - label.y) : 0;
        arrows.push({ swap: dot(u, direction) > 0, score: shape * 12 - lateral * .15 - longitudinal * .12 - toLabel * .06 + Math.min(2.8, wire.length / 15), wire: wire.id });
      }
    }
  }
  arrows.sort((a, b) => b.score - a.score);
  if (arrows.length && !arrows.some(a => a.swap !== arrows[0].swap && a.score >= arrows[0].score - 1)) return arrows[0];

  const v = normal(u);
  const positive = [];
  for (const sign of [-1, 1]) for (const pos of [.34, .43, .51]) {
    const center = plus(symbol, u, sign * half * pos);
    const t = Math.max(3, Math.min(6, half * .19));
    const actual = [plus(center, u, t), plus(center, u, -t), plus(center, v, t), plus(center, v, -t)];
    const corners = [plus(actual[0], v, t), plus(actual[0], v, -t), plus(actual[1], v, t), plus(actual[1], v, -t)];
    if (actual.every(p => inkNear(im, p, 1)) && corners.every(p => !inkNear(im, p, 0))) positive.push(sign);
  }
  if (positive.length && positive.every(sign => sign === positive[0])) return { swap: positive[0] > 0 };
  return null;
}
