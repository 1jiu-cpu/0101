import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solve, transfer } from '../src/analysis.js';
import { compareTopology } from '../src/model.js';
import { exportNetlist, parseNetlist } from '../src/input.js';

const model = () => JSON.parse(readFileSync(new URL('fixtures/delta-y-reference.circuit.json', import.meta.url), 'utf8'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);

test('delta source and balanced Y load give unique line currents but no unique source circulation', () => {
  const result = solve(model(), 'ac', 50);
  const loads = result.branches.filter(b => b.type === 'Z');
  for (const branch of loads) near(branch.current.magnitude, 20 / Math.sqrt(3));
  const rectangular = [[10 / Math.sqrt(3), -10], [-20 / Math.sqrt(3), 0], [10 / Math.sqrt(3), 10]];
  for (const [i, branch] of loads.entries()) {
    near(branch.current.re, rectangular[i][0]);
    near(branch.current.im, rectangular[i][1]);
  }
  near(loads.reduce((sum, b) => sum + b.power.re, 0), 2000 * Math.sqrt(3));
  near(loads.reduce((sum, b) => sum + b.power.im, 0), 2000);
  assert.equal(result.redundant, true);
  assert.equal(result.branches.filter(b => b.type === 'V' && b.current === null && b.power === null).length, 3);
  near(result.kcl, 0);
  near(result.laws, 0);
  near(result.power.magnitude, 0);
});

test('the delta source loop reports inconsistent phasor constraints and never fabricates a solution', () => {
  const d = model();
  d.elements[2].phase += 1;
  assert.throws(() => solve(d, 'ac'), /理想电源约束互相矛盾/);
  const floating = parseNetlist('V1 x y 5\nR1 x y 10\nR2 b 0 1k');
  assert.throws(() => solve(floating, 'ac'), /方程奇异/);
});

test('fixed complex impedance supports exact input and round-trips without extrapolating over frequency', () => {
  const d = parseNetlist('V1 a 0 DC 0 AC 200\nZ1 a 0 5√3 5');
  near(d.elements.find(e => e.type === 'Z').value, 5 * Math.sqrt(3));
  assert.ok(compareTopology(d, parseNetlist(exportNetlist(d))));
  assert.throws(() => solve(d, 'dc'), /只适用于给定工况/);
  assert.throws(() => transfer(d, { source: 'e1', node: 'a' }), /只适用于给定工况/);
});
