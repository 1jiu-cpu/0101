import { parseValue } from './model.js';
import { insideSymbol } from './line-vision.js';

const normalize = text => text.normalize('NFKC').replace(/[−–—]/g, '-').replace(/[<>〈]/g, '∠').replace(/[ωΩ]/g, 'Ω').replace(/\s+/g, '');
const decimal = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const radical = `${decimal}?(?:\\*?)√${decimal}`;
const quantity = `(?:${radical}|${decimal})`;

function angleValue(value) {
  if (/^[+-]?(?:\d+(?:\.\d+)?)?(?:\*?)π(?:\/\d+(?:\.\d+)?)?$/.test(value)) {
    const [a, b] = value.replace('*', '').split('π');
    const d = b ? Number(b.slice(1)) : 1;
    return (a === '-' ? -1 : a === '+' || a === '' ? 1 : Number(a)) * 180 / d;
  }
  const numericAngle = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(deg|°|rad)?$/i);
  if (!numericAngle) return NaN;
  return Number(numericAngle[1]) * (numericAngle[2]?.toLowerCase() === 'rad' ? 180 / Math.PI : 1);
}

export function parsePhasor(text) {
  const expr = normalize(text).replace(/[Vv]$/, '');
  const parts = expr.split('∠');
  if (parts.length !== 2 || !new RegExp(`^${decimal}$`).test(parts[0])) return null;
  const phase = angleValue(parts[1]);
  const ac = Number(parts[0]);
  return Number.isFinite(ac) && Number.isFinite(phase) ? { ac, phase } : null;
}

export function parseImpedance(text) {
  const expr = normalize(text).replace(/\[?Ω\]?$/i, '');
  if (/V$/i.test(expr)) return null;
  const polar = parsePhasor(expr);
  if (polar) {
    const a = polar.phase * Math.PI / 180;
    return { value: polar.ac * Math.cos(a), reactance: polar.ac * Math.sin(a) };
  }
  const number = input => parseValue(input || '0', 'Ω');
  const rectangular = expr.match(new RegExp(`^([+-]?${quantity})?([+-])?(?:j(${quantity})|(${quantity})j)$`, 'i'));
  if (rectangular) {
    const [, re, sign, before, after] = rectangular;
    if (re && !sign) return null;
    return { value: number(re), reactance: number(before || after) * (sign === '-' ? -1 : 1) };
  }
  if (new RegExp(`^[+-]?${quantity}$`).test(expr)) return { value: number(expr), reactance: 0 };
  return null;
}

function glyphs(im) {
  const data = im.data.slice();
  const { width, height } = im;
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const queue = [i];
    data[i] = 0;
    let x = width, y = height, right = 0, bottom = 0;
    for (let j = 0; j < queue.length; j++) {
      const id = queue[j], a = id % width, b = (id - a) / width;
      x = Math.min(x, a); y = Math.min(y, b); right = Math.max(right, a + 1); bottom = Math.max(bottom, b + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = id + dy * width + dx;
        if (a + dx >= 0 && a + dx < width && data[n]) { data[n] = 0; queue.push(n); }
      }
    }
    const w = right - x, h = bottom - y;
    if (queue.length >= 3 && w <= 78 && h <= 53) result.push({ x, y, right, bottom, w, h, cx: (x + right) / 2, cy: (y + bottom) / 2, count: queue.length });
  }
  return result;
}

const resolution = 23;
function pixels(im, box) {
  const bitmap = new Uint8Array(resolution ** 2);
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const j = Math.floor(box.x + (x + .5) * box.w / resolution);
    const i = Math.floor(box.y + (y + .5) * box.h / resolution);
    bitmap[y * resolution + x] = im.data[i * im.width + j];
  }
  return bitmap;
}

function dilate(bitmap) {
  return bitmap.map((v, i) => {
    if (v) return 1;
    const x = i % resolution;
    return Number(bitmap[i - resolution] || bitmap[i + resolution] || (x && bitmap[i - 1]) || (x < resolution - 1 && bitmap[i + 1]));
  });
}

let fonts;
function dictionary() {
  if (fonts) return fonts;
  if (typeof document === 'undefined') return [];
  fonts = [];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 68;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const family of ['Times New Roman', 'Cambria Math', 'Arial', 'Consolas', 'Segoe UI Symbol']) {
    for (const style of ['normal', 'italic', 'bold']) for (const size of [18, 32]) {
      ctx.font = `${style} ${size}px "${family}"`;
      for (const char of '0123456789-.+∠<π√jΩ°EVZIabcnABCRrad/[]') {
        ctx.clearRect(0, 0, 68, 68);
        ctx.fillText(char, 8, 44);
        const rgba = ctx.getImageData(0, 0, 68, 68).data;
        const im = { width: 68, height: 68, data: Uint8Array.from({ length: 68 * 68 }, (_, i) => rgba[i * 4 + 3] > 110 ? 1 : 0) };
        let x = 68, y = 68, right = 0, bottom = 0;
        for (let i = 0; i < im.data.length; i++) if (im.data[i]) {
          x = Math.min(x, i % 68); y = Math.min(y, Math.floor(i / 68));
          right = Math.max(right, i % 68 + 1); bottom = Math.max(bottom, Math.floor(i / 68) + 1);
        }
        if (right <= x || bottom <= y) continue;
        const bits = pixels(im, { x, y, w: right - x, h: bottom - y });
        fonts.push({ char, bits, expanded: dilate(bits), ratio: (right - x) / (bottom - y) });
      }
    }
  }
  return fonts;
}

function choices(im, box, chars, limit = 4) {
  const bits = pixels(im, box), expanded = dilate(bits), ratio = box.w / box.h;
  const scores = new Map();
  for (const ref of dictionary()) {
    if (!chars.includes(ref.char)) continue;
    const aspect = Math.abs(Math.log(ref.ratio / ratio)) * .16;
    if (aspect >= .34) continue;
    let raw = 0, distant = 0;
    for (let i = 0; i < bits.length; i++) {
      raw += Number(bits[i] !== ref.bits[i]);
      distant += Number((bits[i] && !ref.expanded[i]) || (ref.bits[i] && !expanded[i]));
    }
    const score = (raw * .27 + distant * .73) / bits.length + aspect;
    if (score < (scores.get(ref.char) ?? .33)) scores.set(ref.char, score);
  }
  if (box.h <= 3 && box.w >= 4) scores.set('-', Math.min(.01, scores.get('-') ?? .3));
  return [...scores].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([text, score]) => ({ text: text === '<' ? '∠' : text, score }));
}

const xOverlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x);
const flat = b => b.h <= Math.max(3, b.w * .24) && b.w >= 5;
const centerGap = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
const numeric = '0123456789';
const alphabet = numeric + '.-+∠<π√jΩ°EVZIabcnABCRrad/[]';

function tight(im, box, left, right) {
  let x = right, end = left, y = box.bottom, bottom = box.y;
  for (let j = box.y; j < box.bottom; j++) for (let i = left; i < right; i++) {
    if (!im.data[j * im.width + i]) continue;
    x = Math.min(x, i); end = Math.max(end, i + 1); y = Math.min(y, j); bottom = Math.max(bottom, j + 1);
  }
  return end > x && bottom > y ? { x, right: end, y, bottom, w: end - x, h: bottom - y } : null;
}

function splitGlyph(im, b) {
  const single = choices(im, b, alphabet, 5);
  if (b.w < 11 || b.h < 7 || b.w / b.h < .85) return single;
  const scores = [];
  const columns = Array.from({ length: b.w }, (_, x) => {
    let total = 0;
    for (let y = b.y; y < b.bottom; y++) total += im.data[y * im.width + b.x + x];
    return total;
  });
  const targets = [];
  for (let i = 4; i < b.w - 3; i++) {
    if (columns[i] <= columns[i - 1] + 1 && columns[i] <= columns[i + 1] + 1) targets.push(b.x + i);
  }
  const cache = new Map();
  const read = (left, right, starts) => {
    const key = `${left},${right},${starts}`;
    if (cache.has(key)) return cache.get(key);
    const box = tight(im, b, left, right);
    const result = box && box.h >= b.h * .48 && box.w >= 3 && box.w <= box.h * 1.35
      ? choices(im, box, starts ? numeric + '√' : numeric + '√πj+∠', 3) : [];
    cache.set(key, result);
    return result;
  };
  for (const cut of targets) {
    const a = read(b.x, cut, true);
    for (const v of a) for (const w of read(cut, b.right, false)) {
      scores.push({ text: v.text + w.text, score: (v.score + w.score) / 2 + .045 });
    }
    if (b.w / b.h < 1.22) continue;
    for (const next of targets) {
      if (next - cut < 4) continue;
      for (const v of a) for (const w of read(cut, next, false)) for (const z of read(next, b.right, false)) {
        scores.push({ text: v.text + w.text + z.text, score: (v.score + w.score + z.score) / 3 + .065 });
      }
    }
  }
  const seen = new Set();
  return [...single, ...scores].sort((a, b) => a.score - b.score).filter(s => !seen.has(s.text) && seen.add(s.text)).slice(0, 7);
}

function beams(tokens, limit = 65) {
  let paths = [{ text: '', score: 0 }];
  for (const choices of tokens) {
    paths = paths.flatMap(path => choices.map(c => ({ text: path.text + c.text, score: path.score + c.score })))
      .filter(c => !/(?:[A-Za-zΩ][.+-]{2}|∠.*∠|\d[EVZIABCR][\d.+-])/.test(c.text))
      .sort((a, b) => a.score - b.score);
    const seen = new Set();
    paths = paths.filter(p => !seen.has(p.text) && seen.add(p.text)).slice(0, limit);
  }
  return paths;
}

function fraction(im, bar, boxes, size) {
  if (!flat(bar) || bar.w < size * .6) return null;
  const groups = [-1, 1].map(side => boxes.filter(b => b !== bar && xOverlap(b, bar) >= Math.min(b.w * .5, 4) &&
    side * (b.cy - bar.cy) > size * .2 && side * (b.cy - bar.cy) <= size * 1.3 && b.h >= size * .32 &&
    (side === -1 ? b.bottom <= bar.y + 2 : b.y >= bar.bottom - 2))
    .sort((a, b) => a.x - b.x));
  if (!groups.every(g => g.length && g.length <= 4)) return null;
  const get = (group, chars) => beams(group.map(b => choices(im, b, chars))).slice(0, 8);
  const upper = get(groups[0], numeric + 'π-');
  const lower = get(groups[1], numeric);
  const tokens = upper.flatMap(a => lower.map(b => ({ text: a.text + '/' + b.text, score: (a.score + b.score) * .62 })))
    .filter(t => /π\/\d+$/.test(t.text)).sort((a, b) => a.score - b.score).slice(0, 8);
  return tokens.length ? { tokens, parts: groups.flat() } : null;
}

function radicalTokens(im, shape, boxes, size) {
  if (shape.h < size || shape.w < size * .8) return null;
  let roof = null;
  for (let y = shape.y; y <= shape.y + Math.min(4, shape.h * .18); y++) {
    let x = shape.x;
    for (let i = shape.x; i <= shape.right; i++) {
      if (i < shape.right && im.data[y * im.width + i]) continue;
      if (i - x >= Math.max(6, size * .34) && i >= shape.right - 3 && (!roof || i - x > roof.right - roof.x)) roof = { x, right: i, y };
      x = i + 1;
    }
  }
  if (!roof || roof.x - shape.x < 4) return null;
  const children = boxes.filter(b => b !== shape && b.x >= roof.x - 2 && b.right <= roof.right + 2 && b.y > roof.y + 2 &&
    b.bottom <= shape.bottom + 2 && b.h >= size * .43 && b.w >= 3).sort((a, b) => a.x - b.x);
  if (!children.length || children.length > 3) return null;
  const trail = beams(children.map(b => choices(im, b, numeric, 3))).slice(0, 5);
  const coefficient = [];
  const space = roof.x - shape.x;
  if (space >= size * .86) {
    for (const cut of [.42,.48,.53,.59,.65].map(f => Math.round(shape.x + space * f))) {
      const left = tight(im, shape, shape.x, cut);
      if (left && left.h >= size * .45 && left.w >= 4) coefficient.push(...choices(im, left, numeric, 3));
    }
  } else coefficient.push({ text: '', score: .035 });
  if (!coefficient.length || !trail.length) return null;
  const seen = new Set();
  const tokens = coefficient.flatMap(c => trail.map(t => ({ text: c.text + '√' + t.text, score: (c.score + t.score) / 2 + .02 })))
    .sort((a,b) => a.score - b.score).filter(c => !seen.has(c.text) && seen.add(c.text)).slice(0, 7);
  return { tokens, parts: children };
}

function combineSmall(boxes) {
  // Dots on j and decimal points are distinguishable by which stroke they sit over.
  const used = new Set();
  return boxes.flatMap(b => {
    if (used.has(b)) return [];
    if (b.w <= 5 && b.h <= 5) {
      const stem = boxes.find(s => s.h >= 7 && s.h <= 22 && s.w <= 8 && s.y >= b.bottom && s.y - b.bottom <= 5 && xOverlap(s, b) >= 1);
      if (stem) return [];
    }
    const dot = b.w <= 8 && b.h >= 7 ? boxes.find(s => s.w <= 5 && s.h <= 5 && b.y >= s.bottom && b.y - s.bottom <= 5 && xOverlap(b, s) >= 1) : null;
    if (!dot) return [b];
    const x = Math.min(b.x, dot.x), right = Math.max(b.right, dot.right);
    used.add(dot);
    return [{ ...b, x, right, y: dot.y, w: right - x, h: b.bottom - dot.y, cx: (x + right) / 2, cy: (dot.y + b.bottom) / 2 }];
  });
}

function expression(im, anchor, boxes, kind) {
  const { start, y, size } = anchor;
  let pieces = boxes.filter(b => b.x >= start - 1 && b.x < start + Math.min(260, size * 13) &&
    Math.abs(b.cy - y) <= size * 1.37 && b.h <= size * 1.75 && b.w <= size * 2.7).sort((a, b) => a.x - b.x || a.y - b.y);
  const fractions = new Map(pieces.map(b => [b, fraction(im, b, pieces, size) ?? radicalTokens(im, b, pieces, size)]).filter(([, f]) => f));
  const stack = new Set([...fractions.values()].flatMap(f => f.parts));
  pieces = combineSmall(pieces.filter(b => !stack.has(b) && (Math.abs(b.cy - y) <= size * .64 || (b.h >= size * .33 && b.y < y + size * .34))));
  const tokens = [];
  let end = start;
  for (const b of pieces) {
    if (b.x - end > size * .99) break;
    if (b.bottom < y - size * .39 || b.y > y + size * .54) continue;
    let letters = fractions.get(b)?.tokens ?? splitGlyph(im, b);
    if (!tokens.length) letters = letters.filter(c => /^[-+.\d√j]/.test(c.text));
    if (!letters.length) {
      if (b.h > size * .47 && b.count > 10) break;
      continue;
    }
    tokens.push(letters);
    end = Math.max(end, b.right);
    if (tokens.length > 21 || letters[0].text === 'Ω' || (letters[0].text === 'V' && tokens.length > 3)) break;
  }
  if (!tokens.length) return null;
  const parse = kind === 'phasor' ? parsePhasor : parseImpedance;
  // Parse complete token sequences. Partial matches are only legal when the
  // remaining tokens are printed units or delimiters.
  const candidates = beams(tokens, 120).flatMap(p => {
    const text = p.text.replace(/^\+/, '');
    let value;
    try { value = parse(text); } catch { return []; }
    if (!value) return [];
    const missingUnit = kind === 'phasor' && !/V$/.test(text) || kind === 'impedance' && !/Ω$/.test(text);
    return [{ ...value, text, cost: p.score / tokens.length + (missingUnit ? .034 : 0), end }];
  }).sort((a, b) => a.cost - b.cost);
  return candidates[0];
}

function labels(im, components) {
  const marks = components.filter(flat);
  const results = [];
  for (const top of marks) {
    const bottom = marks.find(b => b.cy - top.cy >= 2 && b.cy - top.cy <= 9 && Math.abs(b.cx - top.cx) <= 2 &&
      xOverlap(top, b) >= Math.min(top.w, b.w) * .75 && Math.abs(b.w - top.w) < 4);
    if (!bottom) continue;
    const y = (top.cy + bottom.cy) / 2;
    const start = Math.max(top.right, bottom.right);
    const size = Math.max(9, Math.min(29, (top.w + bottom.w) * .83));
    const prefix = components.filter(b => b.right <= top.x + 2 && top.x - b.right < size * 2 && Math.abs(b.cy - y) < size * .55 &&
      b.h >= size * .57 && b.h <= size * 1.65 && b.w >= 4 && b.w / b.h >= .28)
      .sort((a, b) => (b.right + b.h) - (a.right + a.h));
    if (!prefix.length) continue;
    const name = choices(im, prefix[0], 'EVZIR', 3);
    const voltage = expression(im, { start, y, size }, components, 'phasor');
    const impedance = expression(im, { start, y, size }, components, 'impedance');
    if ((!name.length || name[0].text === 'I') && !/V$/.test(voltage?.text) && !/Ω$/.test(impedance?.text)) continue;
    const kind = /V$/.test(voltage?.text) ? 'phasor' : /Ω$/.test(impedance?.text) ? 'impedance' :
      name[0]?.text === 'Z' || name[0]?.text === 'R' ? 'impedance' : 'phasor';
    const best = kind === 'phasor' ? voltage : impedance;
    if (!best) continue;
    const suffix = components.find(b => b.x >= prefix[0].right - 1 && b.right <= top.x + 1 && b.y > prefix[0].y + prefix[0].h * .39 &&
      b.h >= 4 && b.h < prefix[0].h * .82 && Math.abs(b.cy - y) <= size * .67);
    const subscript = suffix ? choices(im, suffix, numeric + 'abcABCn', 1)[0]?.text : '';
    const symbol = kind === 'phasor' ? name.find(n => ['E', 'V'].includes(n.text))?.text ?? 'V' :
      name.find(n => ['Z', 'R'].includes(n.text))?.text ?? 'Z';
    results.push({ kind, x: prefix[0].x, y, end: best.end, size, name: symbol + (subscript || ''), symbol, best });
  }
  const unique = [];
  for (const r of results.sort((a, b) => (a.best?.cost ?? 1) - (b.best?.cost ?? 1))) {
    if (!unique.some(e => Math.abs(e.y - r.y) < 5 && Math.abs(e.x - r.x) < 12)) unique.push(r);
  }
  return unique;
}

function maskText(im, wires, symbols) {
  const data = im.data.slice();
  for (const s of wires) {
    if (s.length < 24) continue;
    for (let k = 0; k <= s.length; k += .7) {
      const x = Math.round(s.start.x + k * s.u.x), y = Math.round(s.start.y + k * s.u.y);
      const radius = Math.min(3, Math.max(1, Math.round(s.thickness / 2)));
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (x + dx >= 0 && x + dx < im.width) data[(y + dy) * im.width + x + dx] = 0;
      }
    }
  }
  for (const symbol of symbols) {
    const r = Math.ceil(Math.hypot(symbol.half, symbol.height)) + 5;
    for (let y = Math.max(0, Math.floor(symbol.y) - r); y <= Math.min(im.height - 1, Math.ceil(symbol.y) + r); y++) {
      for (let x = Math.max(0, Math.floor(symbol.x) - r); x <= Math.min(im.width - 1, Math.ceil(symbol.x) + r); x++) {
        if (insideSymbol(symbol, { x, y }, 2)) data[y * im.width + x] = 0;
      }
    }
  }
  return { ...im, data };
}

const labelDistance = (symbol, label) => {
  const along = symbol.x < label.x ? (label.x - symbol.x) : Math.max(0, symbol.x - label.end);
  return Math.hypot(along, symbol.y - label.y) + Math.abs(symbol.x - (label.x + label.end) / 2) * .11;
};

export function readMathLabels(im, wires, symbols) {
  const text = maskText(im, wires, symbols);
  const components = glyphs(text);
  const equations = labels(text, components);
  const assignments = new Map();
  const used = new Set();
  const candidates = equations.filter(e => e.best && e.best.cost < .21).flatMap(e => symbols.filter(s => (s.type === 'V') === (e.kind === 'phasor'))
    .map(s => ({ s, e, distance: labelDistance(s, e) }))).sort((a, b) => a.distance - b.distance);
  for (const { s, e, distance } of candidates) {
    if (assignments.has(s) || used.has(e) || distance > Math.min(220, im.width * .26)) continue;
    assignments.set(s, e);
    used.add(e);
  }
  const definitions = new Map();
  for (const e of equations.filter(e => e.best && e.symbol === 'Z' && e.best.cost < .21)) {
    if (!definitions.has(e.name)) definitions.set(e.name, []);
    definitions.get(e.name).push(e);
  }
  const glyphCandidates = components.filter(b => b.h >= 8 && b.h <= 34 && b.w >= 6 &&
    !equations.some(e => b.cx >= e.x - 2 && b.cx <= e.end + 1 && Math.abs(b.cy - e.y) < e.size * 1.3));
  for (const s of symbols.filter(s => s.type === 'R' && !assignments.has(s))) {
    const nearest = glyphCandidates.filter(b => centerGap(b, { cx: s.x, cy: s.y }) < Math.max(31, s.half * 2) &&
      !insideSymbol(s, b, 2)).map(b => ({ b, gap: centerGap(b, { cx: s.x, cy: s.y }), value: choices(text, b, 'ZREV2', 2) }))
      .filter(c => c.value[0]?.text === 'Z' && c.value[0].score < .23).sort((a, b) => a.gap - b.gap)[0];
    if (!nearest) continue;
    const suffix = glyphCandidates.find(b => b.x >= nearest.b.right - 1 && b.x - nearest.b.right <= 6 && b.h < nearest.b.h * .8 &&
      b.y > nearest.b.y + nearest.b.h * .39 && Math.abs(b.cy - nearest.b.cy) < nearest.b.h * .8);
    const subscript = suffix ? choices(text, suffix, numeric + 'abcABCn', 1)[0]?.text : '';
    const defs = definitions.get('Z' + (subscript || ''));
    if (defs?.length === 1) assignments.set(s, { ...defs[0], shared: true, x: nearest.b.cx, y: nearest.b.cy });
  }
  return assignments;
}
