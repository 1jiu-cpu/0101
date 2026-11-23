import { addElement, assertValid, empty, parseValue, prune, TYPES } from './model.js';
import { parseNetlist } from './input.js';
import { connectOriented, findVoltageDirection, orientedSymbols, straightSegments, traceWires } from './line-vision.js';
import { readMathLabels } from './math-labels.js';

const round = Math.round;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function threshold({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  const cool = new Uint8Array(gray.length);
  const warm = new Uint8Array(gray.length);
  let neutralInk = 0;
  let coolInk = 0;
  for (let i = 0; i < gray.length; i++) {
    const at = i * 4;
    const alpha = data[at + 3] / 255;
    gray[i] = round(255 * (1 - alpha) + alpha * (.2126 * data[at] + .7152 * data[at + 1] + .0722 * data[at + 2]));
    const red = data[at];
    const green = data[at + 1];
    const blue = data[at + 2];
    if (alpha > .5 && red > green + 38 && red > blue + 25 && gray[i] < 190) warm[i] = 1;
    if (gray[i] < 182 && blue > red + 36 && blue > green + 22 && green > red + 14) { cool[i] = 1; coolInk++; }
    else if (gray[i] < 122) neutralInk++;
    histogram[gray[i]]++;
  }
  const total = histogram.reduce((sum, k, j) => sum + k * j, 0);
  let split = 145;
  let max = 0;
  let low = 0;
  let sumLow = 0;
  for (let i = 0; i < 255; i++) {
    low += histogram[i];
    sumLow += i * histogram[i];
    if (!low || low === gray.length) continue;
    const d = sumLow / low - (total - sumLow) / (gray.length - low);
    const score = low * (gray.length - low) * d * d;
    if (score > max) { max = score; split = i; }
  }
  if (histogram.slice(0, 90).reduce((a, b) => a + b) > gray.length * .63) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
    split = 255 - split;
  }
  const limit = clamp(split + 15, 75, 200);
  return { width, height, warm, data: gray.map((value, i) => Number(value < limit && !(neutralInk > coolInk * .52 && cool[i]))) };
}

const pixel = (im, x, y) => (x >= 0 && y >= 0 && x < im.width && y < im.height ? im.data[y * im.width + x] : 0);

function wireRuns(im, horizontal, minLength) {
  const major = horizontal ? im.width : im.height;
  const minor = horizontal ? im.height : im.width;
  const runs = [];
  for (let axis = 0; axis < minor; axis++) {
    let begin = -1;
    let last = -1;
    for (let p = 0; p <= major; p++) {
      if (p < major && (horizontal ? pixel(im, p, axis) : pixel(im, axis, p))) {
        if (begin < 0) begin = p;
        last = p;
      }
      if (begin >= 0 && (p === major || p - last > 1)) {
        if (last - begin >= minLength) {
          const existing = runs.find(s => s.end >= axis - 1 && s.min <= begin + 7 && s.max >= last - 7 && Math.abs(s.min - begin) <= 8 && Math.abs(s.max - last) <= 8);
          if (existing) {
            existing.end = axis;
            existing.min = Math.min(existing.min, begin);
            existing.max = Math.max(existing.max, last);
          } else runs.push({ start: axis, end: axis, min: begin, max: last });
        }
        begin = -1;
      }
    }
  }
  return runs.filter(s => s.end - s.start < 22).map(s => ({
    h: horizontal, at: round((s.start + s.end) / 2), min: s.min, max: s.max, thickness: s.end - s.start + 1,
  }));
}

const polyline = points => points.slice(1).flatMap(([x, y], i) => {
  const [a, b] = points[i];
  return Array.from({ length: 17 }, (_, k) => [a + (x - a) * k / 16, b + (y - b) * k / 16]);
});
const ellipse = (fn = theta => [Math.cos(theta), Math.sin(theta)]) => Array.from({ length: 64 }, (_, i) => fn(i * 2 * Math.PI / 64));
const zigzag = n => polyline([[-1, 0], ...Array.from({ length: n }, (_, i) => [-.83 + 1.66 * i / (n - 1), i % 2 ? 1 : -1]), [1, 0]]);
const coil = n => Array.from({ length: n }, (_, i) => Array.from({ length: 15 }, (_, j) => [
  -1 + 2 * (i + (1 - Math.cos(j * Math.PI / 14)) / 2) / n, -Math.sin(j * Math.PI / 14),
])).flat();
const templates = [
  ...[4, 5, 6, 7, 8].map(n => ({ type: 'R', shape: zigzag(n), ratios: [.18, .25, .33, .43, .58] })),
  ...[4, 5, 6, 7, 8].map(n => ({ type: 'R', shape: zigzag(n).map(([x, y]) => [x, -y]), ratios: [.18, .26, .34, .44, .54, .65] })),
  { type: 'R', shape: polyline([[-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [-1, 0]]), ratios: [.2, .3, .42, .58, .76] },
  { type: 'C', shape: [...polyline([[-1, -1], [-1, 1]]), ...polyline([[1, -1], [1, 1]])], ratios: [1.05, 1.4, 1.9, 2.5, 3.3, 4.4] },
  ...[3, 4, 5].map(n => ({ type: 'L', shape: coil(n), ratios: [.23, .35, .48, .62] })),
  ...[3, 4, 5].map(n => ({ type: 'L', shape: coil(n).map(([x, y]) => [x, -y]), ratios: [.23, .35, .48, .62] })),
  { type: 'V', shape: ellipse(), ratios: [.78, .9, 1, 1.12] },
  { type: 'E', shape: polyline([[-1, 0], [0, -1], [1, 0], [0, 1], [-1, 0]]), ratios: [.77, 1, 1.24] },
];

function nearInk(im, x, y, radius) {
  for (let a = -radius; a <= radius; a++) for (let b = -radius; b <= radius; b++) if (pixel(im, x + a, y + b)) return true;
  return false;
}

function distanceTo(pts, x, y) {
  let distance = Infinity;
  for (const [a, b] of pts) distance = Math.min(distance, (x - a) ** 2 + (y - b) ** 2);
  return distance;
}

function classify(im, h, a, b, at, thickness) {
  const half = (b - a) / 2;
  const center = (a + b) / 2;
  const point = (x, y) => h ? [round(center + x), round(at + y)] : [round(at + y), round(center + x)];
  const radius = clamp(round(thickness / 2 + half * .04), 1, Math.min(6, Math.max(2, round(half / 4))));
  const atCenter = Array.from({ length: 7 }, (_, i) => pixel(im, ...point(half * (i - 3) / 4, 0))).filter(Boolean).length;
  if (atCenter === 7) return null;
  let best = null;
  for (const template of templates) {
    if (template.type === 'C' ? half > 40 : half < (template.type === 'L' ? 15 : 7)) continue;
    for (const ratio of template.ratios) {
      const height = half * ratio;
      if (height < 3 || height > 95) continue;
      let covered = 0;
      const points = template.shape.map(([x, y]) => [x * half, y * height]);
      for (const [x, y] of points) covered += Number(nearInk(im, ...point(x, y), radius));
      const recall = covered / points.length;
      if (recall < .65 || best && recall < best.score) continue;
      let extra = 0;
      let counted = 0;
      const stride = half * height < 850 ? 1 : 2;
      for (let x = -Math.floor(half) + 2; x < half - 1; x += stride) for (let y = -Math.ceil(height * 1.18); y <= height * 1.18; y += stride) {
        if (!pixel(im, ...point(x, y))) continue;
        if (['V', 'E'].includes(template.type) && Math.hypot(x / half, y / height) < .72) continue;
        counted++;
        if (distanceTo(points, x, y) > (radius + stride + .75) ** 2) extra++;
      }
      const precision = counted ? 1 - extra / counted : .92;
      const score = recall * (.55 + .45 * precision);
      if (score > .74 && (!best || score > best.score)) best = { type: template.type, score, height, half };
    }
  }
  if (!best) return null;
  let swap = false;
  let sourceUncertain = false;
  if (['V', 'E'].includes(best.type)) {
    const left = [-.4, -.5, -.3].reduce((sum, x) => sum + [-.18, .18].filter(y => nearInk(im, ...point(half * x, best.height * y), 1)).length, 0);
    const right = [.4, .5, .3].reduce((sum, x) => sum + [-.18, .18].filter(y => nearInk(im, ...point(half * x, best.height * y), 1)).length, 0);
    const arrow = [-.35, -.16, 0, .16, .35].every(x => nearInk(im, ...point(half * x, 0), 1));
    if (arrow) { best.type = best.type === 'V' ? 'I' : 'G'; swap = left > right; }
    else swap = right > left;
    sourceUncertain = Math.abs(left - right) < 2 || arrow;
  }
  return { ...best, x: h ? center : at, y: h ? at : center, h, swap, sourceUncertain };
}

const segmentLength = s => s.max - s.min;
const projected = (s, x, y) => s.h ? x : y;
const perpendicular = (s, x, y) => s.h ? y : x;
const contains = (s, p, pad = 0) => s.min - pad <= p && p <= s.max + pad;
const endNear = (s, p, pad) => Math.min(Math.abs(s.min - p), Math.abs(s.max - p)) <= pad;
const world = (s, k) => s.h ? { x: k, y: s.at } : { x: s.at, y: k };

function contactMarks(im) {
  if (!im.warm) return [];
  const work = im.warm.slice();
  const contacts = [];
  for (let i = 0; i < work.length; i++) {
    if (!work[i]) continue;
    const queue = [i];
    work[i] = 0;
    let x1 = im.width;
    let x2 = 0;
    let y1 = im.height;
    let y2 = 0;
    for (let j = 0; j < queue.length; j++) {
      const at = queue[j];
      const x = at % im.width;
      const y = Math.floor(at / im.width);
      x1 = Math.min(x1, x); x2 = Math.max(x2, x);
      y1 = Math.min(y1, y); y2 = Math.max(y2, y);
      for (const next of [x > 0 ? at - 1 : -1, x < im.width - 1 ? at + 1 : -1, at - im.width, at + im.width]) {
        if (work[next]) { work[next] = 0; queue.push(next); }
      }
    }
    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;
    if (w >= 5 && h >= 5 && w <= 34 && h <= 34 && w / h > .68 && w / h < 1.45 && queue.length > w * h * .43) {
      contacts.push({ x: round((x1 + x2) / 2), y: round((y1 + y2) / 2), radius: Math.max(w, h) / 2 });
    }
  }
  return contacts;
}

function switchCandidates(im, wires, minimum) {
  const marks = contactMarks(im);
  const symbols = [];
  for (const [i, left] of marks.entries()) for (const right of marks.slice(i + 1)) {
    const h = Math.abs(left.y - right.y) < Math.max(3, left.radius * .5);
    if (!h && Math.abs(left.x - right.x) >= Math.max(3, left.radius * .5)) continue;
    const [near, far] = [left, right].sort((a, b) => h ? a.x - b.x : a.y - b.y);
    const start = h ? near.x : near.y;
    const end = h ? far.x : far.y;
    const align = h ? (near.y + far.y) / 2 : (near.x + far.x) / 2;
    const gap = end - start;
    if (gap < Math.max(27, 4 * left.radius) || gap > 180) continue;
    const suitable = wires.filter(s => s.h === h && Math.abs(s.at - align) < Math.max(4, left.radius * .7));
    const a = suitable.filter(s => s.min < start - minimum && s.max >= start - left.radius && s.max < end - 4).sort((x, y) => segmentLength(y) - segmentLength(x))[0];
    const b = suitable.filter(s => s.max > end + minimum && s.min <= end + right.radius && s.min > start + 4).sort((x, y) => segmentLength(y) - segmentLength(x))[0];
    if (!a || !b) continue;
    const middle = (start + end) / 2;
    const get = (u, v) => h ? pixel(im, u, v) : pixel(im, v, u);
    const testing = [];
    for (let u = start + Math.ceil(left.radius); u < end - right.radius; u++) {
      let found = false;
      for (let v = round(align - gap * .17); v <= align + gap * .17; v++) found ||= Boolean(get(u, v));
      testing.push(found);
    }
    const occupancy = testing.filter(Boolean).length / Math.max(1, testing.length);
    if (occupancy < .3) continue;
    const type = occupancy > .88 ? 'SHORT' : 'OPEN';
    a.max = Math.min(a.max, start + 1);
    b.min = Math.max(b.min, end - 1);
    symbols.push({ type, h, a: a.id, b: b.id, x: h ? middle : align, y: h ? align : middle, half: gap / 2, height: gap * .19, score: .86, rank: 1.7 });
  }
  return symbols;
}

function extractSymbols(im, wires, minimum) {
  const switches = switchCandidates(im, wires, minimum);
  const candidates = [...switches];
  const switchWire = s => switches.some(c => {
    const center = projected(s, c.x, c.y);
    return s.id !== c.a && s.id !== c.b && s.h === c.h && Math.abs(perpendicular(s, c.x, c.y) - s.at) < c.height &&
      s.max >= center - c.half && s.min <= center + c.half && segmentLength(s) < c.half * 3.25;
  });
  wires = wires.filter(s => !switchWire(s));
  const fixedLead = (side, at, farEnd) => wires.some(s => s.h !== side && Math.abs(s.at - farEnd) <= 8 && contains(s, at, 6) && segmentLength(s) >= minimum * 1.8);
  for (const a of wires) {
    const leadA = fixedLead(a.h, a.at, a.min);
    const adjacent = wires.filter(b => b.h === a.h && b.min - a.max > 2 && b.min - a.max < Math.min(245, Math.max(im.width, im.height) * .29) && Math.abs(a.at - b.at) <= 3)
      .sort((a, b) => a.min - b.min);
    for (const b of adjacent.slice(0, 3)) {
    const leadB = fixedLead(b.h, b.at, b.max);
    const structural = Number(leadA) + Number(leadB);
    if (!structural && Math.max(segmentLength(a), segmentLength(b)) < minimum * 3.15) continue;
    const at = (a.at + b.at) / 2;
    const [firstPlate, secondPlate] = [a.max, b.min].map(target => wires.filter(s => s.h !== a.h && Math.abs(s.at - target) <= Math.max(5, s.thickness / 2 + 3)
      && contains(s, at) && Math.abs((s.min + s.max) / 2 - at) < Math.max(7, segmentLength(s) * .18)).sort((p, q) => Math.abs(p.at - target) - Math.abs(q.at - target))[0]);
    let c;
    if (firstPlate && secondPlate && firstPlate.id !== secondPlate.id) {
      const plateA = segmentLength(firstPlate);
      const plateB = segmentLength(secondPlate);
      const span = b.min - a.max;
      const spread = Math.max(plateA, plateB) / Math.min(plateA, plateB);
      if (Math.min(plateA, plateB) >= span * .55 && spread < 3.1 && Math.max(plateA, plateB) < span * 9 &&
          Math.max(plateA, plateB) <= Math.min(im.width, im.height) * .57 && span < 112 && Math.abs(firstPlate.at - secondPlate.at) >= 5) {
        const middle = (firstPlate.at + secondPlate.at) / 2;
        c = { type: spread >= 1.47 ? 'V' : 'C', score: spread >= 1.35 && spread < 1.6 ? .8 : .96, h: a.h,
          x: a.h ? middle : at, y: a.h ? at : middle, half: Math.abs(secondPlate.at - firstPlate.at) / 2,
          height: Math.max(plateA, plateB) / 2, swap: spread >= 1.47 && plateB > plateA, sourceUncertain: false,
          plates: [firstPlate.id, secondPlate.id] };
      }
    }
    c ??= classify(im, a.h, a.max, b.min, at, Math.max(a.thickness, b.thickness));
    if (c) candidates.push({ ...c, a: a.id, b: b.id, rank: c.score + structural * .065 + Math.min(segmentLength(a), segmentLength(b), 180) * .00055 });
    }
  }
  const kept = [];
  for (const c of candidates.sort((a, b) => b.rank - a.rank)) {
    if (!kept.some(p => Math.hypot(p.x - c.x, p.y - c.y) < Math.max(11, Math.min(c.half, p.half)) ||
      p.h === c.h && (p.a === c.a || p.b === c.b))) kept.push(c);
  }
  const inner = s => kept.some(c => {
    if (s.id === c.a || s.id === c.b) return false;
    if (c.plates?.includes(s.id)) return true;
    const p = world(s, s.min);
    const q = world(s, s.max);
    const w = (c.h ? c.half : c.height) + 4;
    const h = (c.h ? c.height : c.half) + 4;
    return [p, q].every(pt => Math.abs(pt.x - c.x) <= w && Math.abs(pt.y - c.y) <= h);
  });
  const cleaned = wires.filter(s => !inner(s));
  const used = new Set(kept.flatMap(c => [c.a, c.b]));
  for (const stem of cleaned) {
    if (stem.h) continue;
    for (const bar of cleaned) {
      if (!bar.h || used.has(bar.id) || Math.abs(bar.at - stem.max) > 4 || !contains(bar, stem.at) ||
          Math.abs((bar.min + bar.max) / 2 - stem.at) > 5 || segmentLength(bar) > minimum * 5 ||
          kept.some(c => !c.h && Math.abs(c.x - stem.at) <= 4 && Math.abs(c.y - bar.at) <= c.half + 5)) continue;
      const band = [];
      for (let y = bar.at + Math.max(2, bar.thickness); y < bar.at + Math.min(55, segmentLength(bar) * .72); y++) {
        let h = 0;
        for (let x = bar.min; x <= bar.max; x++) h += pixel(im, x, y);
        if (h >= 3 && h < segmentLength(bar) * .88 && pixel(im, stem.at, y)) band.push(y);
      }
      if (!band.some(y => band.some(z => Math.abs(z - y) >= Math.max(3, bar.thickness + 1)))) continue;
      kept.push({ type: 'GND', a: stem.id, x: stem.at, y: bar.at, score: .92, h: false, half: 9, height: segmentLength(bar) / 2 });
      used.add(bar.id);
      break;
    }
  }
  return { symbols: kept, wires: cleaned.filter(s => !kept.some(c => c.type === 'GND' && s.h && s.at > c.y && s.at < c.y + c.height * 2 && contains(s, c.x) && segmentLength(s) <= c.height * 2.2)) };
}

export function segmentConnections(im, wires) {
  const joins = [];
  for (const [i, a] of wires.entries()) for (const b of wires.slice(i + 1)) {
    const pad = Math.max(3, Math.min(6, Math.max(a.thickness, b.thickness) + 1));
    if (a.h === b.h) {
      if (Math.abs(a.at - b.at) <= Math.max(1, Math.min(a.thickness, b.thickness) - 1) &&
        Math.min(a.max, b.max) - Math.max(a.min, b.min) >= -1) joins.push({ a: a.id, b: b.id, connected: true });
      continue;
    }
    const h = a.h ? a : b;
    const v = a.h ? b : a;
    const x = v.at;
    const y = h.at;
    if (!contains(h, x, pad) || !contains(v, y, pad)) continue;
    if (endNear(h, x, pad) || endNear(v, y, pad)) {
      if (nearInk(im, x, y, pad)) joins.push({ a: a.id, b: b.id, x, y, connected: true });
      continue;
    }
    const thickness = Math.max(a.thickness, b.thickness);
    const k = Math.ceil(thickness * .62) + 1;
    let diagonals = 0;
    for (const dx of [-k, k]) for (const dy of [-k, k]) diagonals += pixel(im, x + dx, y + dy);
    const dot = diagonals >= 3;
    joins.push({ a: a.id, b: b.id, x, y, connected: dot, crossing: true, confidence: dot ? .91 : .65 });
  }
  return joins;
}

function bounds(im, x, y, w, h) {
  return { x: clamp(round(x), 0, im.width - 1), y: clamp(round(y), 0, im.height - 1),
    right: clamp(round(x + w), 0, im.width), bottom: clamp(round(y + h), 0, im.height) };
}

function spans(start, end, nonEmpty, gap = 0) {
  const groups = [];
  let a = -1;
  let b = -1;
  for (let i = start; i <= end; i++) {
    if (i < end && nonEmpty(i)) {
      if (a < 0) a = i;
      b = i;
    } else if (a >= 0 && (i === end || i - b > gap)) { groups.push([a, b + 1]); a = -1; }
  }
  return groups;
}

function glyph(im, { x, y, right, bottom }) {
  const size = 16;
  return Array.from({ length: size * size }, (_, i) => {
    const px = x + (i % size + .5) * (right - x) / size;
    const py = y + (Math.floor(i / size) + .5) * (bottom - y) / size;
    return pixel(im, Math.floor(px), Math.floor(py));
  });
}

let characters;
function alphabet() {
  if (characters) return characters;
  if (typeof document === 'undefined') return [];
  const surface = document.createElement('canvas');
  surface.width = surface.height = 40;
  const ctx = surface.getContext('2d', { willReadFrequently: true });
  characters = [];
  for (const family of ['Arial', 'Consolas', 'Times New Roman']) for (const weight of ['400', '700']) {
    ctx.font = `${weight} 27px "${family}"`;
    for (const char of '0123456789.RCLVIΩkMmµunpFHAS') {
      ctx.clearRect(0, 0, 40, 40);
      ctx.fillText(char, 4, 28);
      const { data } = ctx.getImageData(0, 0, 40, 40);
      const im = { width: 40, height: 40, data: Uint8Array.from({ length: 1600 }, (_, i) => Number(data[i * 4 + 3] > 110)) };
      const cols = spans(0, 40, x => Array.from({ length: 40 }, (_, y) => pixel(im, x, y)).some(Boolean), 40);
      const rows = spans(0, 40, y => im.data.subarray(y * 40, y * 40 + 40).some(Boolean), 40);
      if (!cols.length || !rows.length) continue;
      const [x, right] = cols[0];
      const [y, bottom] = rows[0];
      characters.push({ char, ratio: (right - x) / (bottom - y), bits: glyph(im, { x, right, y, bottom }) });
    }
  }
  return characters;
}

function ocr(im, area) {
  const dictionary = alphabet();
  if (!dictionary.length) return [];
  const bands = spans(area.y, area.bottom, y => {
    let ink = 0;
    for (let x = area.x; x < area.right; x++) ink += pixel(im, x, y);
    return ink > 0 && ink < (area.right - area.x) * .48;
  }, 1);
  return bands.flatMap(([y, bottom]) => {
    const h = bottom - y;
    if (h < 5 || h > 36) return [];
    const pieces = spans(area.x, area.right, x => {
      for (let iy = y; iy < bottom; iy++) if (pixel(im, x, iy)) return true;
      return false;
    });
    const words = [];
    let last = -1;
    for (const [x, right] of pieces) {
      if (last >= 0 && x - last > Math.max(2, h * .43) || !words.length) words.push({ text: '', cost: 0 });
      last = right;
      const vert = spans(y, bottom, iy => im.data.subarray(iy * im.width + x, iy * im.width + right).some(Boolean), h);
      if (!vert.length || right - x > h * 1.6) continue;
      const [top, end] = vert[0];
      const ratio = (right - x) / (end - top);
      const bits = glyph(im, { x, right, y: top, bottom: end });
      const word = words.at(-1);
      if (end - top <= h * .28 && right - x <= h * .31 && top >= y + h * .56) { word.text += '.'; continue; }
      let best = null;
      for (const item of dictionary) {
        const d = bits.reduce((sum, value, i) => sum + Number(value !== item.bits[i]), 0) / bits.length + Math.abs(Math.log(item.ratio / ratio)) * .13;
        if (!best || d < best.cost) best = { char: item.char, cost: d };
      }
      word.text += best.cost < .42 ? best.char : '?';
      word.cost += best.cost;
    }
    return words.filter(w => w.text).map(w => ({ ...w, cost: w.cost / w.text.length }));
  });
}

function readLabel(im, c) {
  const { x, y, half, height, h } = c;
  const b = h ? [
    bounds(im, x - half - 26, y - height - 62, 2 * half + 52, 60),
    bounds(im, x - half - 26, y + height + 4, 2 * half + 52, 58),
  ] : [
    bounds(im, x + height + 5, y - half - 22, 105, 2 * half + 44),
    bounds(im, x - height - 108, y - half - 22, 104, 2 * half + 44),
  ];
  const words = b.flatMap(area => ocr(im, area)).sort((a, b) => a.cost - b.cost);
  const name = words.find(w => new RegExp('^' + c.type + '\\d+$').test(w.text) && w.cost < .27)?.text;
  for (const { text, cost } of words) {
    const unit = TYPES[c.type].unit;
    const explicit = unit && text.endsWith(unit);
    const engineering = /^\d+(?:\.\d+)?[kMmunpµ]$/.test(text) && cost < .19;
    if (!unit || !explicit && !engineering || cost > .27) continue;
    try { return { name, value: parseValue(text, unit), text, cost }; } catch { /* Try another candidate. */ }
  }
  return { name };
}

export function rebuildRecognition(report) {
  const { wires, joins, symbols, width, height } = report;
  const result = empty(report.title || '图片识别电路');
  const parent = new Map(wires.map(s => [s.id, s.id]));
  function root(id) {
    let p = id;
    while (parent.get(p) !== p) p = parent.get(p);
    return p;
  }
  for (const j of joins) if (j.connected) parent.set(root(j.a), root(j.b));
  const grounded = new Set(symbols.filter(c => c.type === 'GND').map(c => root(c.a)));
  const ids = new Map();
  function net(id) {
    const key = root(id);
    if (grounded.has(key)) return '0';
    if (!ids.has(key)) ids.set(key, 'n' + (ids.size + 1));
    return ids.get(key);
  }
  const scale = clamp(700 / Math.max(width, height), 1, 3);
  const uniqueName = (name, used) => name && !used.some(e => e.name === name) ? name : undefined;
  for (const [i, c] of symbols.entries()) {
    const kind = c.type;
    const [a, b] = c.swap ? [c.b, c.a] : [c.a, c.b];
    const rotation = kind === 'GND' ? 0 : ((c.angle === undefined ? c.h ? 0 : 90 : round(c.angle / 90) * 90) + (c.swap ? 180 : 0) + 360) % 360;
    const spec = TYPES[kind];
    const terminals = kind === 'GND' ? { g: net(c.a) } : { p: net(a), n: net(b) };
    const options = { id: `image${i + 1}`, name: uniqueName(c.label?.name, result.elements), value: c.label?.value ?? spec.value,
      expression: c.label?.expression ?? c.label?.text ?? '', terminals, pose: { x: round(c.x * scale + 70), y: round(c.y * scale + 70), rotation } };
    if (c.label?.ac !== undefined) Object.assign(options, { value: 0, ac: c.label.ac, phase: c.label.phase, expression: '' });
    if (kind === 'Z') options.reactance = c.label?.reactance ?? 0;
    addElement(result, kind, options);
  }
  if (report.method === 'oriented' && !result.nodes.some(n => n.reference)) {
    const supply = new Set(result.elements.filter(e => e.type === 'V').flatMap(e => Object.values(e.terminals)));
    const degrees = node => result.elements.filter(e => Object.values(e.terminals).includes(node.id)).length;
    const chosen = result.nodes.filter(n => !supply.has(n.id)).sort((a, b) => degrees(b) - degrees(a))[0] ?? result.nodes[0];
    if (chosen) chosen.reference = true;
  }
  return assertValid(prune(result));
}

function recognizeOriented(im, title) {
  const minimum = clamp(round(Math.min(im.width, im.height) * .04), 12, 24);
  const rails = straightSegments(im, minimum);
  const candidates = orientedSymbols(im, rails, minimum);
  if (!candidates.length) return null;
  const graph = traceWires(im, rails, candidates, minimum);
  const symbols = graph.complete;
  if (!symbols.length) return null;
  const display = connectOriented(im, rails, symbols, minimum);
  const math = readMathLabels(im, display.wires, symbols);
  for (const s of symbols) {
    const e = math.get(s);
    if (s.type === 'V' && e?.kind === 'phasor') {
      const direction = findVoltageDirection(im, s, rails, e);
      s.swap = direction?.swap ?? false;
      s.sourceUncertain = !direction;
      s.label = { ...e.best, name: e.name };
    } else if (s.type === 'R' && e?.kind === 'impedance') {
      s.type = e.symbol === 'Z' || /∠/.test(e.best.text) || e.best.reactance || e.best.value <= 0 ? 'Z' : 'R';
      s.label = { ...e.best, name: e.name, shared: e.shared, expression: '' };
    } else if (s.type === 'V') s.sourceUncertain = true;
    else s.label = readLabel(im, s);
  }
  const region = id => graph.root(graph.ports.get(id));
  const sourceNets = new Set(symbols.filter(s => s.type === 'V').flatMap(s => [region(s.a), region(s.b)]));
  for (const s of symbols.filter(s => s.type !== 'V')) s.swap = !sourceNets.has(region(s.a)) && sourceNets.has(region(s.b));
  const report = { title, width: im.width, height: im.height, method: 'oriented', wires: graph.wires, joins: graph.joins,
    symbols: symbols.map(s => ({ ...s, a: graph.ports.get(s.a), b: graph.ports.get(s.b) })),
    uncertain: candidates.filter(s => !symbols.includes(s)), unsupported: [], loose: 0 };
  report.model = rebuildRecognition(report);
  return report;
}

export function recognizePixels(im, title = '图片识别电路') {
  const oriented = typeof document === 'undefined' ? null : recognizeOriented(im, title);
  if (oriented?.symbols.some(s => s.label?.ac !== undefined || s.type === 'Z')) return oriented;
  const hasDiagonals = oriented?.symbols.some(s => Math.abs(Math.sin(2 * s.angle * Math.PI / 180)) > .35);
  const minimum = clamp(round(Math.min(im.width, im.height) * .035), 9, 28);
  const wires = [...wireRuns(im, true, minimum), ...wireRuns(im, false, minimum)].map((s, i) => ({ ...s, id: i }));
  if (wires.length > 650) throw Error('图像线条过密。请裁剪到单张清晰的电路图。');
  const found = extractSymbols(im, wires, minimum);
  if (!found.symbols.some(s => s.type !== 'GND')) {
    if (hasDiagonals) return oriented;
    throw Error('没有识别出可靠的电路符号。请裁剪图像、提高对比度，或使用本地视觉模型。');
  }
  const joins = segmentConnections(im, found.wires);
  const network = new Map(found.wires.map(s => [s.id, s.id]));
  const root = id => {
    while (network.has(id) && network.get(id) !== id) id = network.get(id);
    return id;
  };
  for (const pair of joins.filter(j => j.connected)) network.set(root(pair.a), root(pair.b));
  const supported = found.symbols.filter(s => !['E', 'G'].includes(s.type));
  const isolated = s => s.rank < .9 && !supported.some(t => s !== t && [s.a, s.b].filter(id => id !== undefined)
    .some(id => [t.a, t.b].filter(id => id !== undefined).map(root).includes(root(id))));
  const uncertain = supported.filter(isolated);
  const symbols = supported.filter(s => !isolated(s));
  if (hasDiagonals && oriented.symbols.length > symbols.length && symbols.every(s => ['R', 'V'].includes(s.type))) return oriented;
  for (const symbol of symbols) if (!['GND', 'OPEN', 'SHORT'].includes(symbol.type)) symbol.label = readLabel(im, symbol);
  const report = { title, width: im.width, height: im.height, wires: found.wires,
    joins, symbols, uncertain, unsupported: found.symbols.filter(s => ['E', 'G'].includes(s.type)) };
  if (!symbols.some(s => s.type !== 'GND')) throw Error('图像只有孤立或低置信符号。请裁剪到电路本身，或用本地视觉服务重试。');
  report.model = rebuildRecognition(report);
  const attach = new Set(report.symbols.flatMap(s => [s.a, s.b]));
  const loose = report.wires.filter(s => segmentLength(s) >= minimum * 2 && !attach.has(s.id) && !report.joins.some(j => j.connected && [j.a, j.b].includes(s.id)));
  report.loose = loose.length;
  return report;
}

export async function readImage(file) {
  if (!/^image\/(png|jpeg|webp|bmp|gif|svg\+xml)$/.test(file.type)) throw Error('请选择 PNG、JPEG 或 WebP 等图片。');
  if (file.size > 20_000_000) throw Error('请选择 20 MB 以内的图片。');
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    im.src = url;
    await im.decode();
    const canvas = document.createElement('canvas');
    const size = Math.max(im.naturalWidth, im.naturalHeight);
    const factor = size >= 540 ? Math.min(1, 1000 / size) : Math.min(2, 650 / size);
    canvas.width = Math.max(1, round(im.naturalWidth * factor));
    canvas.height = Math.max(1, round(im.naturalHeight * factor));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/png');
    return { pixels: threshold(ctx.getImageData(0, 0, canvas.width, canvas.height)), image };
  } finally { URL.revokeObjectURL(url); }
}

export async function localVision({ endpoint, model, key, image, title }) {
  const host = new URL(endpoint);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || !['http:', 'https:'].includes(host.protocol) || host.username || host.password) throw Error('视觉服务仅可配置为本机回环地址。');
  const url = host.pathname.endsWith('/chat/completions') ? host : new URL(host.href.replace(/\/$/, '') + '/chat/completions');
  const response = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(90000), redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Transcribe schematic, do not solve it. Return only JSON {"netlist":"...","uncertain":["..."]}. Use SPICE lines R C L V I E G F H; op amp U1 plus minus out ref; ideal transformer T1 p1 n1 p2 n2 ratio; K1 L1 L2 coupling; three-phase source V3_1 A B C N amplitude phase. Identify nodes including dots vs crossing wires. Use ground node 0. Explicitly flag missing values or topology in uncertain, do not use fabricated source or nodes.' },
      { type: 'image_url', image_url: { url: image } },
    ] }] }),
  });
  if (!response.ok) throw Error(`本地视觉服务返回 HTTP ${response.status}。`);
  const { choices } = await response.json();
  let result;
  try { result = JSON.parse(choices[0].message.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw Error('视觉服务未返回可解析的网表 JSON。'); }
  if (typeof result.netlist !== 'string' || result.netlist.length > 20000) throw Error('视觉服务未返回有效的网表。');
  return { model: parseNetlist(result.netlist, title), uncertain: Array.isArray(result.uncertain) ? result.uncertain.map(String) : [] };
}
