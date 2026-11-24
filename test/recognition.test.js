import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizePixels, rebuildRecognition, segmentConnections, threshold } from '../src/recognize.js';
import { addElement, compareTopology, empty } from '../src/model.js';
import { orientedSymbols, straightSegments, traceWires } from '../src/line-vision.js';
import { parseImpedance, parsePhasor } from '../src/math-labels.js';

export function raster(width, height) {
  const result = { width, height, data: new Uint8Array(width * height) };
  function dot(x, y, radius = 1) {
    for (let i = -radius; i <= radius; i++) for (let j = -radius; j <= radius; j++) {
      if (i * i + j * j <= radius * radius + 1) result.data[(Math.round(y) + j) * width + Math.round(x) + i] = 1;
    }
  }
  function line(a, b, radius) {
    const steps = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) * 2 + 1;
    for (let i = 0; i <= steps; i++) dot(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps, radius);
  }
  const chain = (points, radius) => points.slice(1).forEach((p, i) => line(points[i], p, radius));
  return { ...result, dot, line, chain };
}

test('pixel pipeline recognizes a resistor and capacitor from an independent raster drawing', () => {
  const image = raster(480, 330);
  image.chain([[52, 65], [173, 65]], 1);
  image.chain([[173, 65], [179, 55], [188, 75], [197, 55], [206, 75], [215, 55], [224, 75], [231, 65]], 1);
  image.chain([[231, 65], [387, 65], [387, 156]], 1);
  image.line([368, 156], [406, 156], 1);
  image.line([368, 170], [406, 170], 1);
  image.chain([[387, 170], [387, 255], [52, 255]], 1);
  const report = recognizePixels(image);
  const target = empty();
  addElement(target, 'R', { terminals: { p: 'a', n: 'b' } });
  addElement(target, 'C', { terminals: { p: 'b', n: 'c' } });
  assert.ok(compareTopology(report.model, target, { values: false }), JSON.stringify(report.symbols));
});

test('dots, plain crossings, T-junctions and manual crossing edits have separate electrical semantics', () => {
  const im = raster(210, 210);
  const h = { id: 0, h: true, at: 100, min: 20, max: 180, thickness: 3 };
  const v = { id: 1, h: false, at: 100, min: 20, max: 180, thickness: 3 };
  const edge = { id: 2, h: false, at: 40, min: 100, max: 180, thickness: 3 };
  im.line([20, 100], [180, 100], 1);
  im.line([100, 20], [100, 180], 1);
  im.line([40, 100], [40, 180], 1);
  assert.equal(segmentConnections(im, [h, v])[0].connected, false);
  assert.equal(segmentConnections(im, [h, edge])[0].connected, true);
  im.dot(100, 100, 5);
  assert.equal(segmentConnections(im, [h, v])[0].connected, true);
  const report = { width: 210, height: 210, wires: [h, v, edge], joins: [{ a: 0, b: 1, connected: false }],
    symbols: [{ type: 'R', a: 0, b: 2, x: 32, y: 80, h: true }, { type: 'C', a: 1, b: 2, x: 165, y: 70, h: true }] };
  const before = rebuildRecognition(report);
  report.joins[0].connected = true;
  const after = rebuildRecognition(report);
  assert.equal(after.nodes.length, before.nodes.length - 1);
  assert.equal(compareTopology(before, after), false);
});

test('preprocessing uses alpha compositing and consistent polarity', () => {
  const b = threshold({ width: 3, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 255, 200, 200, 200, 255, 0, 0, 0, 0]) });
  assert.deepEqual([...b.data], [1, 0, 0]);
});

test('rotated IEC shapes are recognized at an angle that is not a multiple of 15 degrees', () => {
  const image = raster(330, 220);
  const radians = 37 * Math.PI / 180;
  const fromLocal = (x, y) => [150 + x * Math.cos(radians) - y * Math.sin(radians),
    105 + x * Math.sin(radians) + y * Math.cos(radians)];
  const draw = points => image.chain(points.map(([x, y]) => fromLocal(x, y)), 1);
  draw([[-100, 0], [-24, 0]]);
  draw([[24, 0], [110, 0]]);
  draw([[-24, -9], [24, -9], [24, 9], [-24, 9], [-24, -9]]);
  const rails = straightSegments(image, 14);
  const symbols = orientedSymbols(image, rails, 14);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].type, 'R');
  assert.ok(Math.abs(symbols[0].angle - 37) < 2);
  const graph = traceWires(image, rails, symbols, 14);
  assert.equal(graph.complete.length, 1);
  assert.notEqual(graph.root(graph.ports.get(symbols[0].a)), graph.root(graph.ports.get(symbols[0].b)));
});

test('math labels distinguish degree and pi angles and parse rectangular or polar impedances', () => {
  assert.deepEqual(parsePhasor('17.5∠−42.5° V'), { ac: 17.5, phase: -42.5 });
  assert.deepEqual(parsePhasor('63∠5π/6 V'), { ac: 63, phase: 150 });
  assert.deepEqual(parsePhasor('63∠3.141592653589793rad V'), { ac: 63, phase: 180 });
  assert.equal(parsePhasor('63∠π/0 V'), null);
  assert.equal(parsePhasor('63∠rad V'), null);
  assert.deepEqual(parseImpedance('2√7 − j3.5 [Ω]'), { value: 2 * Math.sqrt(7), reactance: -3.5 });
  assert.deepEqual(parseImpedance('−j8 Ω'), { value: 0, reactance: -8 });
  const polar = parseImpedance('25∠−60° Ω');
  assert.ok(Math.hypot(polar.value - 12.5, polar.reactance + 12.5 * Math.sqrt(3)) < 1e-12);
  assert.equal(parseImpedance('12.5∠ V'), null);
});
