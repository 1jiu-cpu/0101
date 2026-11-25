import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { clone, compareTopology } from '../src/model.js';
import { example } from '../src/examples.js';
import { parseNetlist } from '../src/input.js';
import { autoLayout, route, verifyRouted } from '../src/layout.js';
import { exportSvg } from '../src/drawing.js';
import { solve } from '../src/analysis.js';
import { circuitFingerprint, detectTopologies } from '../src/topology.js';
import { applyReduction, recommendations, reduceStepByStep } from '../src/reduce.js';
import { verifyEquivalence } from '../src/verify.js';
import { extractIrFromSvg, invokeTool, TOOL_SCHEMAS } from '../src/tooling.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(root, 'tools/circuitlab-cli.mjs');
const serverPath = resolve(root, 'server.mjs');
const nearly = (actual, expected, tol = 1e-7) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} was expected near ${expected}`);

function runProcess(args, stdinText = '') {
  return new Promise((resolveProc, rejectProc) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', rejectProc);
    child.on('close', code => resolveProc({ code, stdout, stderr }));
    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

test('topology recognition detects Wheatstone bridges (balanced & unbalanced), delta, wye, and three-phase configurations', () => {
  const bridge = example('bridge');
  const tBridge = detectTopologies(bridge);
  assert.equal(tBridge.bridges.length, 1);
  assert.equal(tBridge.bridges[0].balanced, false);
  assert.equal(tBridge.bridges[0].nodes.top, 'in');
  assert.equal(tBridge.bridges[0].nodes.bottom, '0');
  assert.ok(tBridge.deltas.length >= 2);

  const balanced = example('balancedBridge');
  const tBal = detectTopologies(balanced);
  assert.equal(tBal.bridges.length, 1);
  assert.equal(tBal.bridges[0].balanced, true);

  const dy = example('deltaY');
  const tDy = detectTopologies(dy);
  assert.equal(tDy.threePhases.length, 1);
  assert.equal(tDy.threePhases[0].configuration, 'Δ-Y');

  const yd = parseNetlist('V3_1 A B C 0 220\nR1 A B 30\nR2 B C 30\nR3 C A 30');
  const tYd = detectTopologies(yd);
  assert.equal(tYd.threePhases.length, 1);
  assert.equal(tYd.threePhases[0].configuration, 'Y-Δ');

  // Canonical fingerprint is invariant under internal node/element renaming
  const a = parseNetlist('R1 x n1 100\nR2 y n1 200\nR3 z n1 300');
  const b = parseNetlist('R9 p n99 300\nR8 q n99 100\nR7 r n99 200');
  assert.equal(circuitFingerprint(a), circuitFingerprint(b));
});

test('dedicated topology layouts for bridge, delta, wye, and three-phase Δ-Y / Y-Δ are clean and overlap-free', () => {
  const cases = [
    ['bridge', example('bridge'), true],
    ['balancedBridge', example('balancedBridge'), true],
    ['deltaY', example('deltaY'), false],
    ['wyeDelta', parseNetlist('V3_1 A B C 0 220\nR1 A B 30\nR2 B C 30\nR3 C A 30'), false],
    ['standaloneDelta', parseNetlist('R1 a b 100\nR2 b c 200\nR3 c a 300'), true],
    ['standaloneWye', parseNetlist('R1 a n1 100\nR2 b n1 200\nR3 c n1 300'), true],
  ];
  for (const [name, doc, expectZeroCrossings] of cases) {
    const laid = autoLayout(doc, false);
    const routed = route(laid.model);
    assert.ok(compareTopology(doc, laid.model), `${name} topology preserved`);
    assert.ok(verifyRouted(laid.model, routed), `${name} routed valid`);
    assert.equal(routed.quality.overlaps, 0, `${name} zero wire overlaps`);
    assert.equal(routed.quality.obstructions, 0, `${name} zero obstructions`);
    if (expectZeroCrossings) {
      assert.equal(routed.quality.crossings, 0, `${name} zero crossings`);
    }
  }
  // Verify H-bridge geometry symmetry on Wheatstone bridge
  const bridgeModel = autoLayout(example('bridge'), false).model;
  const r1 = bridgeModel.geometry[bridgeModel.elements.find(e => e.name === 'R1').id];
  const r2 = bridgeModel.geometry[bridgeModel.elements.find(e => e.name === 'R2').id];
  const r3 = bridgeModel.geometry[bridgeModel.elements.find(e => e.name === 'R3').id];
  const r4 = bridgeModel.geometry[bridgeModel.elements.find(e => e.name === 'R4').id];
  const r5 = bridgeModel.geometry[bridgeModel.elements.find(e => e.name === 'R5').id];
  assert.equal(r1.x, r2.x, 'left bridge arms aligned vertically');
  assert.equal(r3.x, r4.x, 'right bridge arms aligned vertically');
  assert.equal(r5.rotation % 180, 0, 'cross bridge arm is horizontal');
  assert.ok(r5.x > Math.min(r1.x, r3.x) && r5.x < Math.max(r1.x, r3.x), 'cross arm centered between left and right columns');
});

test('unbalanced Wheatstone bridge reduces strictly step-by-step via Δ→Y with independent verification and visual continuity', () => {
  const bridge = example('bridge');
  const origCurrent = solve(bridge, 'dc').branches.find(b => b.name === 'V1').current.re;
  const outcome = reduceStepByStep(bridge);

  // Must NOT jump directly to final resistor: Δ→Y, series, series, parallel, series = 5 steps
  assert.equal(outcome.totalSteps, 5);
  assert.equal(outcome.steps[0].rule, 'deltaStar');
  assert.deepEqual(outcome.steps.slice(1).map(s => s.rule).sort(), ['parallel', 'series', 'series', 'series']);
  assert.equal(outcome.model.history.length, 5);

  // Check final equivalent resistance: 29000 / 17 Ω
  const finalR = outcome.model.elements.filter(e => e.type === 'R');
  assert.equal(finalR.length, 1);
  nearly(finalR[0].value, 29000 / 17, 1e-6);

  // Check EVERY intermediate step independently
  for (const step of outcome.steps) {
    assert.ok(step.basis && step.formula && step.relationship);
    assert.equal(step.verification.passed, true);
    assert.ok(step.verification.residual < 1e-9);
    assert.ok(step.verification.checks.some(c => c.scope === 'fullCircuit' && c.passed));
    assert.ok(step.highlight.beforeElements.length >= 1);
    assert.ok(step.highlight.afterElements.length >= 1);
    const stepCurrent = solve({ ...step.after, history: [] }, 'dc').branches.find(b => b.name === 'V1').current.re;
    nearly(stepCurrent, origCurrent, 1e-9);
    // Visual continuity: untouched elements remain anchored
    assert.ok(step.continuity.preservedRatio >= 0.75, `step ${step.index} continuity ${step.continuity.preservedRatio}`);
  }
  // On Step 1 (Δ→Y), untouched V1, R2, R4, GND stay 100% anchored!
  assert.equal(outcome.steps[0].continuity.preservedRatio, 1);
});

test('balanced Wheatstone bridge supports both balance-arm removal and Δ→Y step-by-step derivation', () => {
  const balanced = example('balancedBridge');
  const viaBalance = reduceStepByStep(balanced, { allowBridgeBalance: true });
  assert.equal(viaBalance.steps[0].rule, 'bridgeBalance');
  assert.equal(viaBalance.totalSteps, 4); // bridgeBalance -> series -> series -> parallel
  nearly(viaBalance.model.elements.find(e => e.type === 'R').value, 2000, 1e-6);

  const viaDeltaY = reduceStepByStep(balanced, { allowBridgeBalance: false });
  assert.equal(viaDeltaY.steps[0].rule, 'deltaStar');
  assert.equal(viaDeltaY.totalSteps, 5);
  nearly(viaDeltaY.model.elements.find(e => e.type === 'R').value, 2000, 1e-6);
});

test('bidirectional Δ↔Y works for complex impedance Z, capacitors C, and inductors L with independent verification', () => {
  // Complex impedance Z: Δ → Y → Δ round-trip
  const zDelta = parseNetlist('Z1 a b 10 10\nZ2 b c 20 -5\nZ3 c a 15 5');
  const dToY = recommendations(zDelta).find(r => r.rule === 'deltaStar');
  assert.ok(dToY);
  const { model: zWye, step: s1 } = applyReduction(zDelta, dToY);
  assert.equal(s1.verification.passed, true);
  const yToD = recommendations(zWye).find(r => r.rule === 'starDelta');
  assert.ok(yToD);
  const { model: zBack, step: s2 } = applyReduction(zWye, yToD);
  assert.equal(s2.verification.passed, true);
  const origRe = zDelta.elements.map(e => e.value).sort((a, b) => a - b);
  const backRe = zBack.elements.map(e => e.value).sort((a, b) => a - b);
  for (let i = 0; i < 3; i++) nearly(backRe[i], origRe[i], 1e-7);

  // Capacitor C: symmetric Δ (10 µF) → Y (30 µF) → Δ (10 µF)
  const cDelta = parseNetlist('C1 a b 10u\nC2 b c 10u\nC3 c a 10u');
  const { model: cWye } = applyReduction(cDelta, recommendations(cDelta).find(r => r.rule === 'deltaStar'));
  for (const e of cWye.elements) nearly(e.value, 30e-6, 1e-12);
  const { model: cBack } = applyReduction(cWye, recommendations(cWye).find(r => r.rule === 'starDelta'));
  for (const e of cBack.elements) nearly(e.value, 10e-6, 1e-12);

  // Inductor L: asymmetric Y → Δ → Y
  const lWye = parseNetlist('L1 a n1 10m\nL2 b n1 20m\nL3 c n1 30m');
  const { model: lDelta } = applyReduction(lWye, recommendations(lWye).find(r => r.rule === 'starDelta'));
  const { model: lBack } = applyReduction(lDelta, recommendations(lDelta).find(r => r.rule === 'deltaStar'));
  const lVals = lBack.elements.map(e => e.value).sort((a, b) => a - b);
  nearly(lVals[0], 0.01, 1e-9);
  nearly(lVals[1], 0.02, 1e-9);
  nearly(lVals[2], 0.03, 1e-9);
});

test('cycle detection prevents pointless Δ↔Y oscillation and lookahead unlocks source-transform reductions', () => {
  // Standalone Y network has no surrounding circuit to merge with -> must stop without oscillating
  const standaloneY = parseNetlist('R1 a n5 100\nR2 b n5 200\nR3 c n5 300');
  const yOut = reduceStepByStep(standaloneY);
  assert.equal(yOut.totalSteps, 0);
  assert.equal(yOut.stopReason, 'irreducible_no_progress');

  // Mixed Thevenin + Norton parallel network: lookahead uses sourceTransform to unlock sourceParallel & parallel
  const mixed = parseNetlist('V1 in n1 10\nR1 n1 0 1k\nI1 0 in 5m\nR2 in 0 1k');
  const origVin = solve(mixed, 'dc').nodes.find(n => n.id === 'in').voltage.re;
  const mOut = reduceStepByStep(mixed);
  assert.ok(mOut.totalSteps >= 2);
  assert.ok(mOut.steps.some(s => s.rule === 'sourceTransform'));
  assert.equal(mOut.model.elements.filter(e => e.type !== 'GND').length, 2);
  const finalVin = solve(mOut.model, 'dc').nodes.find(n => n.id === 'in').voltage.re;
  nearly(finalVin, origVin, 1e-9);

  // Node preservation protects designated measurement node (deriving Norton equivalent at 'out' while preserving v(out))
  const div = example('divider');
  const origVout = solve(div, 'dc').nodes.find(n => n.id === 'out').voltage.re;
  const keptOut = reduceStepByStep(div, { preserveNodes: ['out'] });
  assert.ok(keptOut.model.nodes.some(n => n.id === 'out'));
  nearly(solve(keptOut.model, 'dc').nodes.find(n => n.id === 'out').voltage.re, origVout, 1e-9);
  const keptBoth = reduceStepByStep(div, { preserveNodes: ['in', 'out'] });
  assert.equal(keptBoth.totalSteps, 0);
});

test('independent equivalence verifier detects electrically non-equivalent circuits', () => {
  const before = example('bridge');
  const stepRes = applyReduction(before, recommendations(before).find(r => r.rule === 'deltaStar'));
  const corrupted = clone(stepRes.model);
  corrupted.elements.find(e => e.type === 'R').value *= 1.05; // 5% error
  const check = verifyEquivalence(before, corrupted, {
    rule: 'deltaStar',
    removedIds: stepRes.step.removedIds,
    addedIds: stepRes.step.addedIds,
    ports: stepRes.step.ports,
  });
  assert.equal(check.passed, false);
  assert.ok(check.residual > 1e-3);
});

test('SVG renderer highlights changed regions and embeds round-trippable Circuit IR', () => {
  const bridge = example('bridge');
  const { step } = applyReduction(bridge, recommendations(bridge).find(r => r.rule === 'deltaStar'));
  const beforeSvg = exportSvg({ ...step.before, history: [] }, {
    highlight: { elements: step.highlight.beforeElements, ports: step.highlight.ports, mode: 'before', label: 'Δ 区域' },
  });
  const afterSvg = exportSvg({ ...step.after, history: [] }, {
    highlight: { elements: step.highlight.afterElements, ports: step.highlight.ports, mode: 'after', label: 'Y 区域' },
  });
  assert.match(beforeSvg, /highlight-region-before/);
  assert.match(beforeSvg, /highlight-before/);
  assert.match(afterSvg, /highlight-region-after/);
  assert.match(afterSvg, /highlight-after/);
  const recovered = extractIrFromSvg(afterSvg);
  assert.ok(compareTopology({ ...step.after, history: [] }, recovered));
});

test('LLM tooling registry supports read, edit, validate, analyze, topology, step reduction, verify, and render', () => {
  assert.ok(TOOL_SCHEMAS.length >= 10);

  // 1. Read & detect topology
  const read = invokeTool('circuit_read', { example: 'bridge' });
  assert.equal(read.summary.topologies.bridges.length, 1);

  // 2. Edit: modify R4 from 3k to 2k to balance the bridge
  const edited = invokeTool('circuit_edit', {
    circuit: read.circuit,
    operations: [
      { op: 'updateElement', name: 'R4', value: '2k' },
      { op: 'renameCircuit', title: '编辑后平衡电桥' },
    ],
    autoLayout: true,
  });
  assert.equal(edited.summary.title, '编辑后平衡电桥');
  assert.equal(edited.summary.topologies.bridges[0].balanced, true);

  // 3. Validate with DC solvability check
  const val = invokeTool('circuit_validate', { circuit: edited.circuit, checkSolve: 'dc' });
  assert.equal(val.valid, true);
  assert.equal(val.solvability.dc.solvable, true);

  // 4. Analyze DC
  const analyzed = invokeTool('circuit_analyze', { circuit: edited.circuit, mode: 'dc' });
  nearly(analyzed.result.kcl, 0, 1e-12);

  // 5. List reduction options & execute single step with highlighted SVG
  const opts = invokeTool('circuit_reduce_options', { circuit: read.circuit });
  assert.ok(opts.count > 0);
  assert.ok(opts.recommendedIndex >= 0);
  const oneStep = invokeTool('circuit_reduce_step', { circuit: read.circuit, renderSvg: true });
  assert.equal(oneStep.applied, true);
  assert.equal(oneStep.step.rule, 'deltaStar');
  assert.match(oneStep.step.beforeSvg, /highlight-region-before/);
  assert.match(oneStep.step.afterSvg, /highlight-region-after/);

  // 6. Step-by-step auto reduction with SVG + Markdown
  const auto = invokeTool('circuit_reduce_auto', { circuit: read.circuit, renderSvg: true });
  assert.equal(auto.totalSteps, 5);
  assert.ok(auto.markdown.includes('步骤 1'));
  assert.ok(auto.steps.every(s => s.beforeSvg && s.afterSvg && s.verification.passed));

  // 7. Verify equivalence independently between original and final circuit
  const ver = invokeTool('circuit_verify_equivalence', { before: read.circuit, after: auto.finalCircuit });
  assert.equal(ver.passed, true);
  assert.ok(ver.residual < 1e-9);

  // 8. Render standalone SVG with highlight
  const rendered = invokeTool('circuit_render', {
    circuit: read.circuit,
    autoLayout: true,
    highlight: { elements: ['R1', 'R3', 'R5'], ports: ['in', 'a', 'b'], mode: 'before' },
  });
  assert.equal(rendered.routedValid, true);
  assert.match(rendered.svg, /highlight-region-before/);
});

test('CLI tool and stdio MCP server work end-to-end with deterministic JSON output', async () => {
  // CLI: list tools
  const toolsRun = await runProcess([cliPath, 'tools']);
  assert.equal(toolsRun.code, 0, toolsRun.stderr);
  const parsedTools = JSON.parse(toolsRun.stdout);
  assert.equal(parsedTools.ok, true);
  assert.equal(parsedTools.tools.length, TOOL_SCHEMAS.length);

  // CLI: reduce-auto markdown output
  const mdRun = await runProcess([cliPath, 'reduce-auto', '--example', 'bridge', '--format', 'markdown']);
  assert.equal(mdRun.code, 0, mdRun.stderr);
  assert.match(mdRun.stdout, /总步数：5/);
  assert.match(mdRun.stdout, /三角形转星形/);

  // MCP JSON-RPC 2.0 over stdio
  const mcpInput = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'circuit_detect_topology', arguments: { example: 'bridge' } } }),
  ].join('\n') + '\n';
  const mcpRun = await runProcess([cliPath, 'mcp'], mcpInput);
  assert.equal(mcpRun.code, 0, mcpRun.stderr);
  const responses = mcpRun.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[0].result.serverInfo.name, 'circuitlab');
  assert.equal(responses[1].result.tools.length, TOOL_SCHEMAS.length);
  assert.equal(responses[2].result.structuredContent.bridges.length, 1);
});

test('HTTP server exposes local /api/tools endpoints alongside static workbench', async () => {
  const child = spawn(process.execPath, [serverPath, '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolvePort, rejectPort) => {
      let buf = '';
      const timer = setTimeout(() => rejectPort(Error('Server startup timeout')), 5000);
      child.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(timer); resolvePort(Number(m[1])); }
      });
      child.on('error', err => { clearTimeout(timer); rejectPort(err); });
    });

    const listRes = await fetch(`http://127.0.0.1:${port}/api/tools`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.ok, true);
    assert.equal(listData.tools.length, TOOL_SCHEMAS.length);

    const callRes = await fetch(`http://127.0.0.1:${port}/api/tools/circuit_reduce_auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ example: 'bridge', renderSvg: false }),
    });
    assert.equal(callRes.status, 200);
    const callData = await callRes.json();
    assert.equal(callData.ok, true);
    assert.equal(callData.result.totalSteps, 5);
  } finally {
    child.kill();
  }
});
