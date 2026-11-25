import {
  TYPES, addElement, assertValid, clone, disconnect, empty, formatValue,
  mergeNodes, parseValue, prune, referenceNode, removeElements, snapshot, validate,
} from './model.js';
import { example, EXAMPLES } from './examples.js';
import { autoLayout, route, verifyRouted } from './layout.js';
import { exportSvg } from './drawing.js';
import { exportNetlist, parseDescription, parseNetlist, retype } from './input.js';
import {
  acThevenin, branchMethod, graphEquations, impulseResponse, periodic,
  portParameters, pulseResponse, solve, thevenin, transfer, transient, twoPort,
} from './analysis.js';
import { circuitFingerprint, detectTopologies } from './topology.js';
import { applyReduction, recommendations, reduceStepByStep, selectNextReduction } from './reduce.js';
import { verifyEquivalence } from './verify.js';

function unescapeXml(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Extract embedded Circuit IR JSON from a CircuitLab SVG string without DOM dependencies.
 */
export function extractIrFromSvg(svgText) {
  const match = String(svgText ?? '').match(/<metadata\s+id=["']circuitlab-ir["'][^>]*>([\s\S]*?)<\/metadata>/i);
  if (!match) throw Error('SVG 中未找到嵌入的 CircuitLab IR 元数据。');
  const parsed = JSON.parse(unescapeXml(match[1]));
  return assertValid(parsed.doc ?? parsed);
}

/**
 * Resolve any supported circuit input (IR object, JSON string, SVG string, netlist, Chinese description, or example ID).
 */
export function resolveCircuit(input = {}) {
  if (!input || typeof input !== 'object') throw Error('请提供有效的电路输入参数对象。');
  if (input.circuit) {
    const raw = typeof input.circuit === 'string' ? JSON.parse(input.circuit) : input.circuit;
    const model = clone(raw.doc ?? raw);
    if (!Array.isArray(model.history)) model.history = [];
    return assertValid(model);
  }
  if (input.example) {
    if (!EXAMPLES.some(e => e.id === input.example)) {
      throw Error(`未知示例 ID：${input.example}。可用示例：${EXAMPLES.map(e => e.id).join(', ')}`);
    }
    return example(input.example);
  }
  if (input.svg) return extractIrFromSvg(input.svg);
  if (input.netlist) return parseNetlist(input.netlist, input.title || '网表电路');
  if (input.description) return parseDescription(input.description);
  throw Error('请提供 circuit（Circuit IR）、netlist、description、svg 或 example 之一。');
}

function summarizeCircuit(doc) {
  const validation = validate(doc);
  const topo = detectTopologies(doc);
  const routed = route(doc);
  return {
    title: doc.title,
    elementCount: doc.elements.filter(e => e.type !== 'GND').length,
    nodeCount: doc.nodes.length,
    referenceNode: referenceNode(doc) ?? null,
    nodes: doc.nodes.map(n => ({ id: n.id, label: n.label, reference: n.reference })),
    elements: doc.elements.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      value: e.value,
      ...(e.type === 'Z' ? { reactance: e.reactance } : {}),
      ...(e.ac !== null ? { ac: e.ac, phase: e.phase } : {}),
      ...(e.initial ? { initial: e.initial } : {}),
      terminals: e.terminals,
      pose: doc.geometry[e.id],
    })),
    topologies: topo,
    fingerprint: circuitFingerprint(doc),
    validation,
    layoutQuality: routed.quality,
    routedValid: verifyRouted(doc, routed),
    netlist: validation.errors.length === 0 ? exportNetlist(doc) : null,
  };
}

function findElement(doc, ref) {
  if (!ref) return null;
  return doc.elements.find(e => e.id === ref || e.name === ref) || null;
}

function parseMaybeValue(val, unit) {
  if (typeof val === 'number') return val;
  return parseValue(val, unit);
}

function renderStepSvgs(step, { embedModel = false } = {}) {
  const beforeDoc = { ...step.before, history: [] };
  const afterDoc = { ...step.after, history: [] };
  const beforeHighlight = {
    elements: step.highlight?.beforeElements || step.removedIds || [],
    ports: step.highlight?.ports || step.ports || [],
    region: step.highlight?.beforeRegion || null,
    mode: 'before',
    label: `步骤 ${step.index} 变换前`,
  };
  const afterHighlight = {
    elements: step.highlight?.afterElements || step.addedIds || [],
    ports: step.highlight?.ports || step.ports || [],
    region: step.highlight?.afterRegion || null,
    mode: 'after',
    label: `步骤 ${step.index} 变换后`,
  };
  return {
    beforeSvg: exportSvg(beforeDoc, { embedModel, highlight: beforeHighlight }),
    afterSvg: exportSvg(afterDoc, { embedModel, highlight: afterHighlight }),
  };
}

function serializeStep(step, { renderSvg = false, embedModel = false, includeSnapshots = true } = {}) {
  const base = {
    index: step.index,
    rule: step.rule,
    title: step.title,
    basis: step.basis || step.condition,
    condition: step.condition,
    formula: step.formula,
    calculations: step.calculations || [],
    relationship: step.relationship,
    removedIds: step.removedIds || [],
    removedNames: step.removedNames || step.names || [],
    addedIds: step.addedIds || [],
    addedNames: step.addedNames || [],
    ports: step.ports || [],
    eliminatedNodes: step.eliminatedNodes || [],
    createdNodes: step.createdNodes || [],
    highlight: step.highlight || null,
    continuity: step.continuity || null,
    verification: step.verification,
  };
  if (includeSnapshots) {
    base.before = step.before;
    base.after = step.after;
  }
  if (renderSvg) {
    const svgs = renderStepSvgs(step, { embedModel });
    base.beforeSvg = svgs.beforeSvg;
    base.afterSvg = svgs.afterSvg;
  }
  return base;
}

/**
 * Format a step-by-step reduction result into human/LLM-readable Markdown.
 */
export function formatReductionMarkdown(outcome) {
  const lines = [
    `# 电路逐步等效化简报告：${outcome.model.title}`,
    '',
    `- 总步数：${outcome.totalSteps}`,
    `- 终止原因：${outcome.stopReason}`,
    `- 已避免循环数：${outcome.cyclesAvoided}`,
    '',
  ];
  for (const step of outcome.steps) {
    lines.push(`## 步骤 ${step.index}：${step.title} (\`${step.rule}\`)`);
    lines.push(`- **参与元件**：${(step.removedNames || step.names || []).join('、')} → ${(step.addedNames || []).join('、') || '（移除）'}`);
    lines.push(`- **外部端口**：${(step.ports || []).join(', ')}`);
    lines.push(`- **变换依据**：${step.basis || step.condition}`);
    lines.push(`- **计算公式与结果**：\`${step.formula}\``);
    lines.push(`- **等效关系**：${step.relationship}`);
    lines.push(`- **独立求解器验证**：${step.verification.passed ? '通过' : '失败'}（${step.verification.method}；${step.verification.label}；最大残差 ${step.verification.residual.toExponential(2)}）`);
    if (step.continuity && step.continuity.unchangedTotal > 0) {
      lines.push(`- **视觉连续性**：未参与元件保持原位 ${step.continuity.preservedCount}/${step.continuity.unchangedTotal}（${Math.round(step.continuity.preservedRatio * 100)}%，平均位移 ${step.continuity.meanDisplacement} px）`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================================
// Tool Implementations
// ============================================================================

export function toolCircuitRead(args = {}) {
  const doc = resolveCircuit(args);
  return {
    summary: summarizeCircuit(doc),
    circuit: doc,
  };
}

export function toolCircuitEdit(args = {}) {
  const doc = args.circuit || args.netlist || args.description || args.example || args.svg
    ? resolveCircuit(args)
    : empty(args.title || '未命名电路');
  const operations = Array.isArray(args.operations) ? args.operations : [];
  const applied = [];

  for (const op of operations) {
    if (!op || typeof op.op !== 'string') throw Error('每条编辑操作必须包含 op 字段。');
    switch (op.op) {
      case 'addElement': {
        const spec = TYPES[op.type];
        if (!spec) throw Error(`未知元件类型：${op.type}`);
        const attrs = {};
        if (op.id) attrs.id = op.id;
        if (op.name) attrs.name = op.name;
        if (op.terminals) attrs.terminals = op.terminals;
        if (op.value !== undefined) attrs.value = parseMaybeValue(op.value, spec.unit);
        if (op.reactance !== undefined) attrs.reactance = parseMaybeValue(op.reactance, 'Ω');
        if (op.ac !== undefined) attrs.ac = op.ac === null ? null : parseMaybeValue(op.ac, spec.unit);
        if (op.phase !== undefined) attrs.phase = Number(op.phase);
        if (op.initial !== undefined) attrs.initial = parseMaybeValue(op.initial, spec.initial || '');
        if (op.control) {
          const ctrl = findElement(doc, op.control);
          if (!ctrl) throw Error(`控制支路不存在：${op.control}`);
          attrs.control = ctrl.id;
        }
        if (op.pose) attrs.pose = op.pose;
        const created = addElement(doc, op.type, attrs);
        applied.push({ op: 'addElement', id: created.id, name: created.name });
        break;
      }
      case 'updateElement': {
        const target = findElement(doc, op.id ?? op.name);
        if (!target) throw Error(`未找到要修改的元件：${op.id ?? op.name}`);
        if (op.type && op.type !== target.type) retype(doc, target.id, op.type);
        const spec = TYPES[target.type];
        if (op.newName) target.name = String(op.newName).trim();
        if (op.value !== undefined) target.value = parseMaybeValue(op.value, spec.unit);
        if (op.reactance !== undefined && target.type === 'Z') target.reactance = parseMaybeValue(op.reactance, 'Ω');
        if (op.ac !== undefined) target.ac = op.ac === null ? null : parseMaybeValue(op.ac, spec.unit);
        if (op.phase !== undefined) target.phase = Number(op.phase);
        if (op.initial !== undefined) target.initial = parseMaybeValue(op.initial, spec.initial || '');
        if (op.currentSign !== undefined) target.currentSign = op.currentSign;
        if (op.voltageSign !== undefined) target.voltageSign = op.voltageSign;
        if (op.terminals) {
          for (const [pin, nodeId] of Object.entries(op.terminals)) {
            if (!Object.hasOwn(target.terminals, pin)) throw Error(`${target.name} 不包含端口 ${pin}`);
            if (!doc.nodes.some(n => n.id === nodeId)) doc.nodes.push({ id: nodeId, label: nodeId, reference: nodeId === '0' });
            target.terminals[pin] = nodeId;
          }
          prune(doc);
        }
        if (op.control !== undefined) {
          const ctrl = findElement(doc, op.control);
          if (!ctrl) throw Error(`控制支路不存在：${op.control}`);
          target.control = ctrl.id;
        }
        if (op.pose) Object.assign(doc.geometry[target.id], op.pose);
        applied.push({ op: 'updateElement', id: target.id, name: target.name });
        break;
      }
      case 'removeElement': {
        const target = findElement(doc, op.id ?? op.name);
        if (!target) throw Error(`未找到要删除的元件：${op.id ?? op.name}`);
        removeElements(doc, [target.id]);
        applied.push({ op: 'removeElement', id: target.id, name: target.name });
        break;
      }
      case 'connectNodes': {
        const kept = mergeNodes(doc, op.a, op.b);
        applied.push({ op: 'connectNodes', kept, removed: kept === op.a ? op.b : op.a });
        break;
      }
      case 'disconnectPin': {
        const target = findElement(doc, op.id ?? op.name);
        if (!target) throw Error(`未找到元件：${op.id ?? op.name}`);
        const newNode = disconnect(doc, [{ id: target.id, pin: op.pin }]);
        applied.push({ op: 'disconnectPin', id: target.id, pin: op.pin, newNode });
        break;
      }
      case 'setReference': {
        if (!doc.nodes.some(n => n.id === op.node)) throw Error(`节点不存在：${op.node}`);
        for (const n of doc.nodes) n.reference = n.id === op.node;
        for (const g of doc.elements.filter(e => e.type === 'GND')) g.terminals.g = op.node;
        prune(doc);
        applied.push({ op: 'setReference', node: op.node });
        break;
      }
      case 'renameNode': {
        const n = doc.nodes.find(x => x.id === op.node);
        if (!n) throw Error(`节点不存在：${op.node}`);
        n.label = String(op.label || op.node).trim();
        applied.push({ op: 'renameNode', node: op.node, label: n.label });
        break;
      }
      case 'setCoupling': {
        const a = findElement(doc, op.a);
        const b = findElement(doc, op.b);
        if (!a || !b) throw Error('互感引用的电感不存在。');
        doc.couplings = doc.couplings.filter(c => !(c.a === a.id && c.b === b.id || c.a === b.id && c.b === a.id));
        if (op.k) doc.couplings.push({ a: a.id, b: b.id, k: Number(op.k) });
        applied.push({ op: 'setCoupling', a: a.id, b: b.id, k: Number(op.k) });
        break;
      }
      case 'renameCircuit': {
        doc.title = String(op.title || '未命名电路').trim();
        applied.push({ op: 'renameCircuit', title: doc.title });
        break;
      }
      case 'autoLayout': {
        const laid = autoLayout(doc, op.keepLocked ?? false);
        doc.geometry = laid.model.geometry;
        applied.push({ op: 'autoLayout', crossings: laid.crossings, overlaps: laid.overlaps });
        break;
      }
      default:
        throw Error(`不支持的编辑操作：${op.op}`);
    }
  }

  let finalDoc = assertValid(prune(doc));
  if (args.autoLayout) {
    finalDoc = autoLayout(finalDoc, args.keepLocked ?? false).model;
  }
  return {
    applied,
    summary: summarizeCircuit(finalDoc),
    circuit: finalDoc,
  };
}

export function toolCircuitValidate(args = {}) {
  const doc = resolveCircuit(args);
  const validation = validate(doc);
  const routed = route(doc);
  const routedValid = verifyRouted(doc, routed);
  const solvability = {};
  const checkSolve = args.checkSolve || 'none';
  if (checkSolve === 'dc' || checkSolve === 'both') {
    try {
      const r = solve(doc, 'dc');
      solvability.dc = { solvable: true, kcl: r.kcl, laws: r.laws };
    } catch (err) {
      solvability.dc = { solvable: false, error: err.message };
    }
  }
  if (checkSolve === 'ac' || checkSolve === 'both') {
    try {
      const r = solve(doc, 'ac', args.frequency || 50);
      solvability.ac = { solvable: true, frequency: args.frequency || 50, kcl: r.kcl, laws: r.laws, redundant: r.redundant };
    } catch (err) {
      solvability.ac = { solvable: false, error: err.message };
    }
  }
  return {
    valid: validation.errors.length === 0 && routedValid,
    errors: validation.errors,
    warnings: validation.warnings,
    routedValid,
    layoutQuality: routed.quality,
    topologies: detectTopologies(doc),
    ...(Object.keys(solvability).length ? { solvability } : {}),
  };
}

export function toolCircuitAnalyze(args = {}) {
  const doc = resolveCircuit(args);
  const mode = args.mode || 'dc';
  const frequency = args.frequency ?? 1000;
  let result;
  switch (mode) {
    case 'dc': result = solve(doc, 'dc'); break;
    case 'ac': result = solve(doc, 'ac', frequency); break;
    case 'thevenin': result = thevenin(doc, args.positive ?? args.node, args.negative ?? referenceNode(doc)); break;
    case 'acThevenin': result = acThevenin(doc, args.positive ?? args.node, args.negative ?? referenceNode(doc), frequency); break;
    case 'twoPort': result = portParameters(twoPort(doc, args.ports, args.frequency ?? 0)); break;
    case 'branch': result = branchMethod(doc, 'branch'); break;
    case 'loop': result = branchMethod(doc, 'loop'); break;
    case 'graph': result = graphEquations(doc); break;
    case 'transient': result = transient(doc, args); break;
    case 'transfer': result = transfer(doc, args); break;
    case 'periodic': result = periodic(doc, args); break;
    case 'impulse': result = impulseResponse(doc, args); break;
    case 'pulse': result = pulseResponse(doc, args); break;
    default: throw Error(`不支持的分析模式：${mode}`);
  }
  return { mode, result };
}

export function toolCircuitDetectTopology(args = {}) {
  const doc = resolveCircuit(args);
  return {
    title: doc.title,
    fingerprint: circuitFingerprint(doc, { preserveNodes: args.preserveNodes || [] }),
    ...detectTopologies(doc),
  };
}

export function toolCircuitReduceOptions(args = {}) {
  const doc = resolveCircuit(args);
  const selected = (args.selected || []).map(ref => findElement(doc, ref)?.id || ref);
  const opts = recommendations(doc, selected, {
    preserveNodes: args.preserveNodes || [],
    preserveNamed: args.preserveNamed,
  });
  const pick = selectNextReduction(doc, {
    selected,
    preserveNodes: args.preserveNodes || [],
    preserveNamed: args.preserveNamed,
  });
  const recommendedIndex = pick.option
    ? opts.findIndex(o => o.rule === pick.option.rule && o.ids.join(',') === pick.option.ids.join(','))
    : -1;
  return {
    count: opts.length,
    recommendedIndex,
    plannerReason: pick.reason,
    options: opts.map((o, index) => ({
      index,
      recommended: index === recommendedIndex,
      rule: o.rule,
      tier: o.tier,
      title: o.title,
      ids: o.ids,
      names: o.names,
      ports: o.ports,
      basis: o.basis || o.condition,
      formula: o.formula,
      calculations: o.calculations,
      relationship: o.relationship,
      eliminatedNodes: o.eliminatedNodes,
    })),
  };
}

export function toolCircuitReduceStep(args = {}) {
  const doc = resolveCircuit(args);
  const selected = (args.selected || []).map(ref => findElement(doc, ref)?.id || ref);
  const reduceOpts = {
    preserveNodes: args.preserveNodes || [],
    preserveNamed: args.preserveNamed,
  };
  const opts = recommendations(doc, selected, reduceOpts);
  let chosen = null;
  if (typeof args.index === 'number') {
    chosen = opts[args.index] || null;
    if (!chosen) throw Error(`变换序号 ${args.index} 超出范围（共 ${opts.length} 项）。`);
  } else if (args.rule || args.elementNames?.length || args.elementIds?.length) {
    const targetIds = [
      ...(args.elementIds || []),
      ...(args.elementNames || []).map(name => findElement(doc, name)?.id).filter(Boolean),
    ];
    chosen = opts.find(o =>
      (!args.rule || o.rule === args.rule)
      && (!targetIds.length || targetIds.every(id => o.ids.includes(id))),
    ) || null;
    if (!chosen) throw Error('未匹配到符合条件的局部等效变换。');
  } else {
    const pick = selectNextReduction(doc, { selected, ...reduceOpts });
    chosen = pick.option;
    if (!chosen) {
      return {
        applied: false,
        reason: pick.reason,
        cyclesAvoided: pick.cyclesAvoided,
        circuit: doc,
      };
    }
  }

  const { model, step } = applyReduction(doc, chosen, { tolerance: args.tolerance ?? 1e-8 });
  return {
    applied: true,
    step: serializeStep(step, {
      renderSvg: args.renderSvg ?? false,
      embedModel: args.embedModel ?? false,
      includeSnapshots: args.includeSnapshots ?? true,
    }),
    circuit: model,
    summary: summarizeCircuit(model),
  };
}

export function toolCircuitReduceAuto(args = {}) {
  const doc = resolveCircuit(args);
  const selected = (args.selected || []).map(ref => findElement(doc, ref)?.id || ref);
  const outcome = reduceStepByStep(doc, {
    selected,
    maxSteps: args.maxSteps ?? 30,
    preserveNodes: args.preserveNodes || [],
    preserveNamed: args.preserveNamed,
    allowBridgeBalance: args.allowBridgeBalance ?? true,
    lookaheadDepth: args.lookaheadDepth ?? 3,
    tolerance: args.tolerance ?? 1e-8,
  });
  const serializedSteps = outcome.steps.map(step => serializeStep(step, {
    renderSvg: args.renderSvg ?? false,
    embedModel: args.embedModel ?? false,
    includeSnapshots: args.includeSnapshots ?? true,
  }));
  return {
    totalSteps: outcome.totalSteps,
    cyclesAvoided: outcome.cyclesAvoided,
    stopReason: outcome.stopReason,
    steps: serializedSteps,
    markdown: formatReductionMarkdown(outcome),
    finalCircuit: outcome.model,
    finalSummary: summarizeCircuit(outcome.model),
  };
}

export function toolCircuitVerifyEquivalence(args = {}) {
  const beforeDoc = resolveCircuit({ circuit: args.before, netlist: args.beforeNetlist, example: args.beforeExample });
  const afterDoc = resolveCircuit({ circuit: args.after, netlist: args.afterNetlist, example: args.afterExample });
  return verifyEquivalence(beforeDoc, afterDoc, {
    rule: args.rule || 'general',
    removedIds: args.removedIds || [],
    addedIds: args.addedIds || [],
    ports: args.ports || [],
    tolerance: args.tolerance ?? 1e-8,
  });
}

export function toolCircuitRender(args = {}) {
  let doc = resolveCircuit(args);
  if (args.autoLayout) {
    doc = autoLayout(doc, args.keepLocked ?? false).model;
  }
  const drawing = route(doc);
  const highlight = args.highlight
    ? {
      elements: (args.highlight.elements || []).map(ref => findElement(doc, ref)?.id || ref),
      ports: args.highlight.ports || [],
      mode: args.highlight.mode || 'before',
      label: args.highlight.label || '',
    }
    : null;
  const svg = exportSvg(doc, {
    embedModel: args.embedModel ?? true,
    labels: args.labels ?? true,
    highlight,
  });
  return {
    svg,
    bounds: drawing.bounds,
    quality: drawing.quality,
    routedValid: verifyRouted(doc, drawing),
    circuit: args.includeCircuit ? doc : undefined,
  };
}

// ============================================================================
// JSON Schema Registry & Dispatcher (MCP / Function-Calling Compatible)
// ============================================================================

const CIRCUIT_INPUT_PROPERTIES = {
  circuit: { type: 'object', description: 'Circuit IR JSON 对象（version: 1）' },
  netlist: { type: 'string', description: 'CircuitLab 网表字符串' },
  description: { type: 'string', description: '中文或英文电路描述' },
  svg: { type: 'string', description: '包含 circuitlab-ir 元数据的 SVG 字符串' },
  example: { type: 'string', enum: EXAMPLES.map(e => e.id), description: '内置示例 ID' },
  title: { type: 'string', description: '可选电路标题' },
};

export const TOOL_SCHEMAS = [
  {
    name: 'circuit_read',
    description: '读取并解析电路（支持 Circuit IR JSON、网表、文字描述、含元数据的 SVG 或内置示例），返回规范 Circuit IR、拓扑识别结果（电桥/Δ/Y/三相）与校验状态。',
    inputSchema: { type: 'object', properties: CIRCUIT_INPUT_PROPERTIES },
  },
  {
    name: 'circuit_edit',
    description: '对电路执行一组确定性原子编辑操作（增删改元件、连线合并节点、断开端口、设置参考地、互感、自动排版），并返回校验后的新 Circuit IR。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        autoLayout: { type: 'boolean', description: '编辑完成后是否执行自动排版' },
        keepLocked: { type: 'boolean', description: '自动排版时是否保持已锁定元件位置' },
        operations: {
          type: 'array',
          description: '按顺序执行的编辑操作数组',
          items: {
            type: 'object',
            required: ['op'],
            properties: {
              op: { type: 'string', enum: ['addElement', 'updateElement', 'removeElement', 'connectNodes', 'disconnectPin', 'setReference', 'renameNode', 'setCoupling', 'renameCircuit', 'autoLayout'] },
            },
          },
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'circuit_validate',
    description: '验证电路模型合法性、布线连通性、布局质量（交叉/重叠/遮挡）及可选的直流/交流可解性。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        checkSolve: { type: 'string', enum: ['none', 'dc', 'ac', 'both'], default: 'none' },
        frequency: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'circuit_analyze',
    description: '调用确定性电路求解器执行直流、交流相量、戴维南/诺顿、二端口、支路/回路电流法、图矩阵、时域暂态或扫频分析。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        mode: { type: 'string', enum: ['dc', 'ac', 'thevenin', 'acThevenin', 'twoPort', 'branch', 'loop', 'graph', 'transient', 'transfer', 'periodic', 'impulse', 'pulse'], default: 'dc' },
        frequency: { type: 'number', default: 1000 },
        node: { type: 'string' },
        positive: { type: 'string' },
        negative: { type: 'string' },
        source: { type: 'string' },
        ports: { type: 'array' },
      },
    },
  },
  {
    name: 'circuit_detect_topology',
    description: '识别电路中的特殊拓扑结构：惠斯通电桥（含平衡判定）、三角形 (Δ)、星形 (Y)、三相 Δ-Y / Y-Δ / Y-Y / Δ-Δ 以及规范结构指纹。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        preserveNodes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'circuit_reduce_options',
    description: '枚举当前电路所有合法的单步局部等效变换（串并联、Δ-Y/Y-Δ、平衡电桥、电源变换、开短路），并标出路径规划器推荐的下一步。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        selected: { type: 'array', items: { type: 'string' }, description: '限定关注的元件 ID 或名称' },
        preserveNodes: { type: 'array', items: { type: 'string' }, description: '保护不被消去的节点 ID 列表' },
        preserveNamed: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'circuit_reduce_step',
    description: '严格只执行单步局部等效变换，使用独立求解器验证电气等价性、维持未参与元件的视觉连续性，并输出变换依据、公式、计算结果及变化区域高亮信息与可选 SVG。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        index: { type: 'integer', description: '指定 circuit_reduce_options 返回的规则序号（省略则由规划器自动选择最优单步）' },
        rule: { type: 'string', description: '按规则类型筛选（如 series, parallel, deltaStar, starDelta, bridgeBalance, sourceTransform）' },
        elementNames: { type: 'array', items: { type: 'string' } },
        elementIds: { type: 'array', items: { type: 'string' } },
        selected: { type: 'array', items: { type: 'string' } },
        preserveNodes: { type: 'array', items: { type: 'string' } },
        preserveNamed: { type: 'boolean', default: false },
        renderSvg: { type: 'boolean', default: false, description: '是否输出带变化区域高亮的变换前后 SVG' },
        embedModel: { type: 'boolean', default: false },
        includeSnapshots: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'circuit_reduce_auto',
    description: '执行带路径规划与循环检测的逐步自动化简。禁止跳步：严格逐一执行每次局部变换并独立验证，完整输出每一步的中间电路、变换依据、公式计算、连续性指标、验证报告及可选高亮 SVG。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        maxSteps: { type: 'integer', default: 30 },
        preserveNodes: { type: 'array', items: { type: 'string' } },
        preserveNamed: { type: 'boolean', default: false },
        allowBridgeBalance: { type: 'boolean', default: true, description: '平衡电桥是否允许直接去除零电流桥臂（设为 false 则使用 Δ-Y 逐步推导）' },
        lookaheadDepth: { type: 'integer', default: 3 },
        renderSvg: { type: 'boolean', default: false, description: '是否为每一步输出带变化区域高亮的前后 SVG' },
        embedModel: { type: 'boolean', default: false },
        includeSnapshots: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'circuit_verify_equivalence',
    description: '使用独立电路求解器（全电路 MNA + 复数多端口矩阵）验证两张电路图之间的电气等价性。',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'object', description: '变换前 Circuit IR' },
        after: { type: 'object', description: '变换后 Circuit IR' },
        beforeNetlist: { type: 'string' },
        afterNetlist: { type: 'string' },
        ports: { type: 'array', items: { type: 'string' } },
        tolerance: { type: 'number', default: 1e-8 },
      },
    },
  },
  {
    name: 'circuit_render',
    description: '渲染电路为标准 SVG，支持自动专用拓扑排版、嵌入可编辑 Circuit IR 元数据以及高亮指定元件与端口区域。',
    inputSchema: {
      type: 'object',
      properties: {
        ...CIRCUIT_INPUT_PROPERTIES,
        autoLayout: { type: 'boolean', default: false },
        keepLocked: { type: 'boolean', default: false },
        embedModel: { type: 'boolean', default: true },
        labels: { type: 'boolean', default: true },
        includeCircuit: { type: 'boolean', default: false },
        highlight: {
          type: 'object',
          properties: {
            elements: { type: 'array', items: { type: 'string' } },
            ports: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['before', 'after'], default: 'before' },
            label: { type: 'string' },
          },
        },
      },
    },
  },
];

const HANDLERS = {
  circuit_read: toolCircuitRead,
  circuit_edit: toolCircuitEdit,
  circuit_validate: toolCircuitValidate,
  circuit_analyze: toolCircuitAnalyze,
  circuit_detect_topology: toolCircuitDetectTopology,
  circuit_reduce_options: toolCircuitReduceOptions,
  circuit_reduce_step: toolCircuitReduceStep,
  circuit_reduce_auto: toolCircuitReduceAuto,
  circuit_verify_equivalence: toolCircuitVerifyEquivalence,
  circuit_render: toolCircuitRender,
};

export function invokeTool(name, args = {}) {
  const fn = HANDLERS[name];
  if (!fn) throw Error(`未知工具：${name}。可用工具：${Object.keys(HANDLERS).join(', ')}`);
  return fn(args || {});
}
