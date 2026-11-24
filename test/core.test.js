import test from 'node:test';
import assert from 'node:assert/strict';
import { addElement, compareTopology, clone, disconnect, mergeNodes, parseValue, empty, validate } from '../src/model.js';
import { example } from '../src/examples.js';
import { autoLayout, route, verifyRouted } from '../src/layout.js';
import { exportSvg } from '../src/drawing.js';
import { parseDescription, parseNetlist, exportNetlist } from '../src/input.js';
import { acThevenin, branchMethod, graphEquations, impulseResponse, periodic, portParameters, pulseResponse, solve, transient, transfer, thevenin, twoPort } from '../src/analysis.js';
import { applyReduction, recommendations, reduceAll } from '../src/reduce.js';

const nearly = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was expected to be near ${expected}`);
const voltage = (r, id) => r.nodes.find(n => n.id === id).voltage;

test('engineering units distinguish milli from mega and reject inconsistent units', () => {
  nearly(parseValue('2.2 kΩ', 'Ω'), 2200);
  nearly(parseValue('2MΩ', 'Ω'), 2e6);
  nearly(parseValue('2mΩ', 'Ω'), .002);
  nearly(parseValue('100 纳法', 'F'), 1e-7);
  assert.throws(() => parseValue('1 A', 'Ω'), /单位/);
  assert.throws(() => parseValue('1e400'), /范围/);
});

test('a new circuit has distinct pins until the model explicitly connects them', () => {
  const d = empty();
  const v = addElement(d, 'V');
  const r = addElement(d, 'R');
  assert.equal(new Set([...Object.values(v.terminals), ...Object.values(r.terminals)]).size, 4);
  mergeNodes(d, v.terminals.p, r.terminals.p);
  mergeNodes(d, v.terminals.n, r.terminals.n);
  assert.equal(d.nodes.length, 2);
  assert.deepEqual(v.terminals, r.terminals);
  disconnect(d, [{ id: r.id, pin: 'p' }]);
  assert.notEqual(v.terminals.p, r.terminals.p);
});

test('layout is deterministic, preserves locked components, and proves topology equivalence', () => {
  const d = example('bridge');
  d.geometry.e1.locked = true;
  const optimized = autoLayout(d).model;
  assert.ok(compareTopology(d, optimized));
  assert.deepEqual(optimized.geometry, autoLayout(d).model.geometry);
  assert.deepEqual(d.geometry.e1, optimized.geometry.e1);
  assert.ok(route(optimized).wires.every(s => s.a.x === s.b.x || s.a.y === s.b.y));
  assert.ok(exportSvg(optimized).includes('viewBox='));
});

test('crossing visual nets remain distinct and generate a bridge record', () => {
  const d = empty();
  addElement(d, 'R', { terminals: { p: 'left', n: 'horizontal' }, pose: { x: 100, y: 260 } });
  addElement(d, 'R', { terminals: { p: 'horizontal', n: 'right' }, pose: { x: 480, y: 260 } });
  addElement(d, 'R', { terminals: { p: 'top', n: 'vertical' }, pose: { x: 280, y: 90, rotation: 90 } });
  addElement(d, 'R', { terminals: { p: 'vertical', n: 'bottom' }, pose: { x: 280, y: 430, rotation: 90 } });
  const r = route(d);
  assert.ok(r.hops.some(h => new Set([h.a, h.b]).size === 2));
  const joined = clone(d);
  mergeNodes(joined, 'horizontal', 'vertical');
  assert.equal(compareTopology(d, joined), false);
  assert.ok(route(joined).junctions.some(j => j.node === 'horizontal'));
});

test('all teaching circuits render connected ports and multiport layouts avoid overlapping nets', () => {
  for (const id of ['rc', 'divider', 'rlc', 'bridge', 'op', 'three']) {
    const d = example(id);
    const layout = route(d);
    assert.ok(verifyRouted(d, layout), id);
    assert.equal(layout.quality.overlaps, 0, id);
    assert.equal(layout.quality.obstructions, 0, id);
  }
});

test('SVG carries the project topology while display-only SVG can omit embedded data', () => {
  const d = example();
  assert.match(exportSvg(d), /<metadata id="circuitlab-ir">/);
  assert.doesNotMatch(exportSvg(d, { embedModel: false }), /circuitlab-ir/);
});

test('versioned JSON and the supported subset of netlists can round-trip a transformer network', () => {
  const d = parseNetlist('V1 in 0 5 AC 5\nT1 in 0 out 0 2\nR1 out 0 100');
  assert.ok(compareTopology(d, JSON.parse(JSON.stringify(d)), { names: true }));
  assert.ok(compareTopology(d, parseNetlist(exportNetlist(d)), { values: false }));
  const r = solve(d, 'ac', 500);
  nearly(voltage(r, 'out').re, 2.5);
  nearly(r.power.re, 0);
});

test('Chinese staged generation honors series, parallel, and explicit node order', () => {
  const rc = parseDescription('5 V 电压源、1 kΩ 电阻与 100 nF 电容串联，构成低通电路。');
  assert.ok(compareTopology(example(), rc, { values: false }));
  const explicit = parseDescription('V1 12 V 接在 in 与 0 之间；R1 1 kΩ 接在 in 与 out 之间；R2 2 kΩ 接在 out 与 0 之间。');
  nearly(voltage(solve(explicit), 'out').re, 8);
  const parallel = parseDescription('电压源 5 V，电阻 1 kΩ 与电阻 2 kΩ 并联。');
  nearly(solve(parallel).branches.find(b => b.name === 'V1').current.re, -.0075);
  assert.throws(() => parseDescription('电阻 1 kΩ 与电容 1 µF。'), /无法唯一/);
});

test('MNA produces independently known DC branch currents, KCL, KVL and power', () => {
  const d = example('divider');
  const r = solve(d);
  nearly(voltage(r, 'out').re, 8);
  nearly(r.branches.find(b => b.name === 'R1').current.re, .004);
  nearly(r.branches.find(b => b.name === 'V1').current.re, -.004);
  nearly(r.kcl, 0);
  nearly(r.laws, 0);
  nearly(r.power.re, 0);
  nearly(graphEquations(d).loopResiduals[0], 0);
});

test('floating topology and inconsistent ideal sources report singularity', () => {
  assert.throws(() => solve(parseNetlist('V1 in 0 5\nR1 a b 1k')), /奇异/);
  assert.throws(() => solve(parseNetlist('V1 a 0 5\nV2 a 0 6')), /奇异/);
  assert.ok(validate(parseNetlist('R1 a b 1k')).warnings.length);
});

test('ideal op amp, VCVS, VCCS, CCCS and CCVS use their actual control constraints', () => {
  nearly(voltage(solve(example('op')), 'out').re, -4);
  const d = parseNetlist('V1 a 0 2\nR1 a 0 1k\nE1 b 0 a 0 3\nG1 0 c a 0 2m\nR2 c 0 1k\nF1 0 d R1 4\nR3 d 0 1k\nH1 e 0 R1 3k\nR4 e 0 1k');
  const r = solve(d);
  nearly(voltage(r, 'b').re, 6);
  nearly(voltage(r, 'c').re, 4);
  nearly(voltage(r, 'd').re, 8);
  nearly(voltage(r, 'e').re, 6);
});

test('mutual inductance and balanced phase voltages have the expected phasors', () => {
  const d = parseNetlist('V1 a 0 0 AC 1\nL1 a 0 10m\nL2 b 0 40m\nK1 L1 L2 .8');
  nearly(voltage(solve(d, 'ac', 500), 'b').re, 1.6);
  const phases = solve(example('three'), 'ac', 50);
  nearly(voltage(phases, 'A').magnitude, 220);
  nearly(voltage(phases, 'B').angle, -120);
  nearly(voltage(phases, 'C').angle, 120);
  nearly(phases.power.re, 0);
});

test('first-order time response matches the analytic step and independent initial voltage', () => {
  const d = example();
  const r = transient(d, { node: 'out', duration: .0005, points: 501 });
  nearly(r.samples[100].y, 5 * (1 - Math.exp(-1)), 2e-5);
  d.elements.find(e => e.type === 'C').initial = 2;
  const zi = transient(d, { node: 'out', duration: .0005, points: 501, response: 'zeroInput' });
  nearly(zi.samples[0].y, 2);
  nearly(zi.samples[100].y, 2 / Math.E, 2e-5);
  nearly(r.residual, 0, 1e-9);
});

test('second-order series RLC step matches the damped analytical solution', () => {
  const d = parseNetlist('V1 in 0 1\nR1 in a 10\nL1 a out .01\nC1 out 0 100u');
  const r = transient(d, { node: 'out', duration: .01, points: 2001 });
  const omega = Math.sqrt(1 / (.01 * 1e-4) - 500 ** 2);
  const t = r.samples[1000].x;
  const expected = 1 - Math.exp(-500 * t) * (Math.cos(omega * t) + 500 * Math.sin(omega * t) / omega);
  nearly(r.samples[1000].y, expected, 3e-6);
});

test('RC sweep has the half-power cutoff, phase, and computed transfer pole', () => {
  const f = 1 / (2 * Math.PI * .0001);
  const r = transfer(example(), { node: 'out', source: 'e1', start: f, stop: 2 * f, points: 3 });
  nearly(r.samples[0].magnitude, 1 / Math.sqrt(2));
  nearly(r.samples[0].phase, -45);
  nearly(r.rational.poles[0].re, -10000, 1e-6);
  nearly(r.rational.numerator[0], 10000, 1e-6);
});

test('Thevenin and two-port impedances agree with hand calculations', () => {
  const rc = example('divider');
  const result = thevenin(rc, 'out', '0');
  nearly(result.voltage, 8);
  nearly(result.resistance, 2000 / 3);
  nearly(result.norton, .012);
  nearly(result.maxPower, .024);
  const model = parseNetlist('R1 a 0 1k\nR2 a b 1k\nR3 b 0 1k');
  const z = twoPort(model, [['a', '0'], ['b', '0']]);
  nearly(z[0][0].re, 2000 / 3);
  nearly(z[0][1].re, 1000 / 3);
  nearly(z[1][0].re, 1000 / 3);
});

test('series, parallel, and star/delta transformations preserve port conductance', () => {
  const model = parseNetlist('V1 in 0 9\nR1 in n1 1k\nR2 n1 0 2k\nR3 in 0 3k');
  const next = reduceAll(model);
  assert.equal(next.history.length, 2);
  nearly(next.elements.find(e => e.type === 'R').value, 1500);
  assert.ok(next.history.every(s => s.verification.residual < 1e-10));
  nearly(solve(model).branches[0].current.re, solve(next).branches[0].current.re);
  const y = parseNetlist('R1 a n5 100\nR2 b n5 200\nR3 c n5 300');
  const d = applyReduction(y, recommendations(y).find(r => r.rule === 'starDelta')).model;
  const { model: back } = applyReduction(d, recommendations(d, d.elements.map(e => e.id)).find(r => r.rule === 'deltaStar'));
  assert.deepEqual(back.elements.map(e => Math.round(e.value)).sort(), [100, 200, 300]);
});

test('source conversion and zero-state RLC reduction retain external behavior', () => {
  const v = parseNetlist('V1 a n1 DC 4 AC 3 30\nR1 n1 0 2k');
  const equivalent = applyReduction(v, recommendations(v).find(r => r.rule === 'sourceTransform')).model;
  nearly(voltage(solve(equivalent), 'a').re, 4);
  nearly(voltage(solve(equivalent, 'ac', 50), 'a').angle, 30);
  const nonzero = parseNetlist('C1 a 0 1u IC=2\nC2 a 0 2u');
  assert.equal(recommendations(nonzero).length, 0);
});

test('branch and loop current methods solve the same mixed-source DC bridge as MNA', () => {
  const circuit = parseNetlist('V1 in 0 12\nR1 in a 2k\nR2 a 0 3k\nR3 a b 1k\nR4 b 0 5k\nI1 0 b 2m');
  const reference = solve(circuit);
  for (const method of ['branch', 'loop']) {
    const result = branchMethod(circuit, method);
    for (const branch of result.branches) nearly(branch.current, reference.branches.find(b => b.name === branch.name).current.re);
    nearly(result.kcl, 0);
    nearly(result.kvl, 0);
  }
  const { loops, cutsets } = graphEquations(circuit);
  for (const a of cutsets) for (const b of loops) nearly(a.reduce((sum, value, i) => sum + value * b[i], 0), 0);
});

test('two-port admittance and chain conversions invert and transform the computed impedance', () => {
  const d = parseNetlist('R1 a 0 1k\nR2 a b 1k\nR3 b 0 1k');
  const r = portParameters(twoPort(d, [['a', '0'], ['b', '0']]));
  nearly(r.y[0][0].re, .002);
  nearly(r.y[0][1].re, -.001);
  nearly(r.abcd[0][0].re, 2);
  nearly(r.abcd[0][1].re, 1000);
});

test('impulse response reports the analytic pole term and algebraic feedthrough', () => {
  const result = impulseResponse(example(), { source: 'e1', node: 'out', duration: .0004, points: 5 });
  nearly(result.samples[1].y, 10000 / Math.E, 1e-7);
  nearly(result.feedthrough, 0);
  const highPass = parseNetlist('V1 in 0 5\nC1 in out 100n\nR1 out 0 1k');
  const hp = impulseResponse(highPass, { source: 'e1', node: 'out' });
  nearly(hp.feedthrough, 1);
  nearly(hp.samples[0].y, -10000, 1e-7);
});

test('periodic response applies linear transfer to each nonzero Fourier coefficient', () => {
  const d = example('divider');
  const result = periodic(d, { source: 'e1', node: 'out', frequency: 300, terms: 8, waveform: 'square' });
  nearly(result.harmonics[0].input, 4 / Math.PI);
  assert.equal(result.harmonics[1].order, 3);
  for (const sample of result.samples) nearly(sample.y, sample.input * 2 / 3);
});

test('AC driving-point impedance and conjugate load follow the series RL network', () => {
  const d = parseNetlist('V1 in 0 DC 0 AC 6\nR1 in a 5\nL1 a out 0.01');
  const r = acThevenin(d, 'out', '0', 100);
  nearly(r.impedance.re, 5);
  nearly(r.impedance.im, 2 * Math.PI);
  nearly(r.load.im, -2 * Math.PI);
  nearly(r.maxPower, 1.8);
});

test('rectangular pulse convolution agrees with the difference of analytic RC step responses', () => {
  const result = pulseResponse(example(), { source: 'e1', node: 'out', duration: .0006, width: .0002 });
  const t = result.samples[300].x;
  const expected = Math.exp(-(t - result.width) / .0001) - Math.exp(-t / .0001);
  nearly(result.samples[300].y, expected, 3e-6);
});
