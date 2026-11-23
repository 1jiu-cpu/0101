import { addElement, addNode, assertValid, empty, parseValue, TYPES } from './model.js';
import { autoLayout } from './layout.js';

const netId = name => /^(gnd|地|接地|0)$/i.test(name) ? '0' : name;
const terminalSpec = {
  R: ['p', 'n'], Z: ['p', 'n'], C: ['p', 'n'], L: ['p', 'n'], V: ['p', 'n'], I: ['p', 'n'],
  E: ['p', 'n', 'cp', 'cn'], G: ['p', 'n', 'cp', 'cn'], F: ['p', 'n'], H: ['p', 'n'],
  OP: ['plus', 'minus', 'out', 'ref'], T: ['p1', 'n1', 'p2', 'n2'], V3: ['A', 'B', 'C', 'N'],
  OPEN: ['p', 'n'], SHORT: ['p', 'n'],
};

function readNumber(token, unit, parameters) {
  const identifier = token?.match(/^\{([\w]+)\}$/)?.[1];
  if (identifier && !parameters.has(identifier)) throw Error(`未定义参数：${identifier}`);
  return parseValue(identifier ? parameters.get(identifier) : token, unit);
}

export function parseNetlist(text, title = '网表电路') {
  const result = empty(title);
  const coupling = [];
  const controls = [];
  const parameters = new Map();
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const raw = line.split(/[;#]/)[0].trim();
    if (!raw || raw.startsWith('*')) continue;
    try {
      const [name, ...args] = raw.split(/\s+/);
      if (name.toLowerCase() === '.end') break;
      if (name.toLowerCase() === '.param') {
        for (const pair of args) {
          const match = pair.match(/^(\w+)=([^=]+)$/);
          if (!match) throw Error('参数格式为 .param Rload=1k。');
          parameters.set(match[1], match[2]);
        }
        continue;
      }
      if (/^K/i.test(name)) {
        if (args.length !== 3) throw Error('互感格式为 K1 L1 L2 0.9。');
        coupling.push({ line: i + 1, a: args[0], b: args[1], k: readNumber(args[2], '', parameters) });
        continue;
      }
      const type = /^V3(?:_|\.)/i.test(name) ? 'V3' : /^U/i.test(name) ? 'OP' : /^O/i.test(name) ? 'OPEN' : /^S/i.test(name) ? 'SHORT' : name[0].toUpperCase();
      const pins = terminalSpec[type];
      if (!pins) throw Error(`不支持的网表元件：${name}。`);
      if (args.length < pins.length) throw Error(`${name} 缺少端口节点。`);
      const terminals = Object.fromEntries(pins.map((pin, j) => [pin, netId(args[j])]));
      const values = args.slice(pins.length);
      const options = { name, terminals };
      if (['OP', 'OPEN', 'SHORT'].includes(type)) {
        if (values.length) throw Error(`${name} 的端口数为 ${pins.length}。`);
      } else if (['V', 'I', 'V3'].includes(type)) {
        if (type === 'V3') {
          options.value = readNumber(values.shift(), 'V', parameters);
          if (values.length) options.phase = readNumber(values.shift(), '', parameters);
        } else {
          const unit = TYPES[type].unit;
          if (values[0]?.toLowerCase() === 'dc') values.shift();
          if (values[0]?.toLowerCase() === 'ac') options.value = 0;
          else {
            options.expression = values[0] || '';
            options.value = readNumber(values.shift(), unit, parameters);
          }
          if (values[0]?.toLowerCase() === 'ac') {
            values.shift();
            options.ac = readNumber(values.shift(), unit, parameters);
            if (values.length) options.phase = readNumber(values.shift(), '', parameters);
          }
        }
        if (values.length) throw Error('电源支持 DC 数值和 AC 幅值 相位。');
      } else {
        if (['F', 'H'].includes(type)) controls.push({ name, controller: values.shift() });
        options.expression = values[0] || '';
        options.value = readNumber(values.shift(), TYPES[type].unit, parameters);
        if (type === 'Z') options.reactance = readNumber(values.shift(), 'Ω', parameters);
        if (['L', 'C'].includes(type) && /^ic=/i.test(values[0])) options.initial = readNumber(values.shift().slice(3), TYPES[type].initial, parameters);
        if (values.length) throw Error(`无法识别参数：${values.join(' ')}。`);
      }
      addElement(result, type, options);
    } catch (error) { throw Error(`第 ${i + 1} 行 · ${error.message}`); }
  }
  if (!result.elements.length) throw Error('请输入至少一行元件网表。');
  const byName = new Map(result.elements.map(e => [e.name, e]));
  for (const { name, controller } of controls) {
    if (!byName.has(controller)) throw Error(`${name} 的控制支路 ${controller ?? '未指定'} 不存在。`);
    byName.get(name).control = byName.get(controller).id;
  }
  for (const { line, a, b, k } of coupling) {
    if (!byName.has(a) || !byName.has(b)) throw Error(`第 ${line} 行的互感支路不存在。`);
    result.couplings.push({ a: byName.get(a).id, b: byName.get(b).id, k });
  }
  if (result.nodes.some(n => n.reference)) addElement(result, 'GND');
  return autoLayout(assertValid(result), false).model;
}

export function parseDescription(text) {
  const input = text.normalize('NFKC').replace(/Ω/g, 'Ω').trim();
  if (!input) throw Error('请描述元件数值与串联、并联或节点连接关系。');
  if (/^(?:[RZCLVIEFGHKUTOS]\w+\s+[\w.\-]+\s+[\w.\-]+(?:\s|$)|[.*])/m.test(input) && !/[，。；;]/u.test(input)) return parseNetlist(input);
  const value = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?\\s*(?:皮|纳|微|毫|千|兆|[pnuµμmkKMG])?\\s*(?:Ω|欧姆?|ohms?|伏特?|伏|安培?|法拉?|亨利?|[VFHA]))';
  const types = [
    ['V', /(?:电压源|供电|直流电源|电池|voltage source)/i],
    ['I', /(?:电流源|current source)/i],
    ['R', /(?:^R\d|R\d+$|电阻|resistor)/i],
    ['C', /(?:^C\d|C\d+$|电容|capacitor)/i],
    ['L', /(?:^L\d|L\d+$|电感|inductor)/i],
  ];
  const result = empty('新建电路');
  const entries = [];
  for (const match of input.matchAll(new RegExp(value, 'gi'))) {
    const raw = match[1].trim();
    const unit = raw.match(/(?:Ω|欧姆?|ohms?|伏特?|伏|安培?|法拉?|亨利?|[VFHA])$/i)?.[0].toUpperCase();
    const type = /Ω|OHM|欧/.test(unit) ? 'R' : /V|伏/.test(unit) ? 'V' : /A|安/.test(unit) ? 'I' : /F|法/.test(unit) ? 'C' : 'L';
    const before = input.slice(Math.max(0, match.index - 32), match.index);
    const after = input.slice(match.index + match[0].length);
    const name = before.match(/(?:^|[^a-z0-9])([RCLVI]\d+)\s*(?:[=:：]|为|是|取)?\s*$/i)?.[1]
      || after.match(/^\s*(?:的?(?:电阻|电容|电感|电压源|电流源)\s*)?([RCLVI]\d+)\b/i)?.[1];
    const exact = after.match(/^\s*(?:的?(?:电阻|电容|电感|电压源|电流源)\s*)?(?:接在|连接|位于|接)\s*([\w\u4e00-\u9fff]+?)\s*(?:与|和|到|至|—|-)\s*([\w\u4e00-\u9fff]+?)\s*(?:之间|，|；|。|,|;|\n|$)/u);
    entries.push({ type, name: name?.toUpperCase(), value: parseValue(raw, TYPES[type].unit), expression: raw,
      pair: exact ? [netId(exact[1]), netId(exact[2])] : null });
  }
  if (!entries.length) throw Error('没有找到带单位的元件值，例如 5 V、1 kΩ 和 10 µF。');
  if (/运放|变压器|受控|三相|并联.*串联|串联.*并联|桥式|手绘/.test(input) && !entries.every(e => e.pair)) {
    throw Error('请为混合或多端口电路给出节点网表。文本描述支持单一串联、并联及逐支路指定节点。');
  }
  const explicit = entries.every(e => e.pair);
  const source = entries.filter(e => ['V', 'I'].includes(e.type));
  const passive = entries.filter(e => !source.includes(e));
  const parallel = /并联|parallel/i.test(input);
  const series = /串联|series|回路|分压|低通|高通/i.test(input);
  if (!explicit && (entries.some(e => e.pair) || source.length > 1 || !parallel && !series && passive.length > 1)) {
    throw Error('无法唯一确定连接。请注明串联、并联，或逐支路写明「R1 1kΩ 接在 in 与 out 之间」。');
  }
  if (!explicit && !passive.length && source.length) throw Error('请补充负载，或直接指定电源的两个节点。');
  if (!explicit && entries.some(e => !types.some(([type, rx]) => e.type === type && rx.test(input)) && !e.name) && !series && !parallel && passive.length) {
    throw Error('请补充元件名称和连接方式。');
  }
  let from = 'in';
  const built = explicit ? entries : [...source, ...passive].map((entry, i) => {
    if (source.includes(entry)) return { ...entry, pair: entry.type === 'I' ? ['0', 'in'] : ['in', '0'] };
    const last = i === entries.length - 1;
    const to = last || parallel ? '0' : i === entries.length - 2 ? 'out' : `n${i + 1}`;
    const pair = [parallel ? 'in' : from, to];
    from = to;
    return { ...entry, pair };
  });
  for (const { type, pair, ...options } of built) addElement(result, type, { ...options, terminals: { p: pair[0], n: pair[1] } });
  if (result.nodes.some(n => n.reference)) addElement(result, 'GND');
  result.title = /低通/.test(input) ? '低通电路' : /高通/.test(input) ? '高通电路' : '文本生成电路';
  return autoLayout(assertValid(result), false).model;
}

export function exportNetlist(doc) {
  assertValid(doc);
  const node = id => doc.nodes.find(n => n.id === id)?.reference ? '0' : id;
  const used = new Set();
  const exportName = new Map(doc.elements.filter(e => e.type !== 'GND').map(e => {
    const prefix = TYPES[e.type].prefix;
    let candidate = e.name.startsWith(prefix) && /^[\w.]+$/.test(e.name) ? e.name : prefix + e.id.replace(/\W/g, '_');
    while (used.has(candidate)) candidate += '_';
    used.add(candidate);
    return [e.id, candidate];
  }));
  const lines = doc.elements.filter(e => e.type !== 'GND').map(e => {
    const base = [exportName.get(e.id), ...terminalSpec[e.type].map(pin => node(e.terminals[pin]))];
    if (['OP', 'OPEN', 'SHORT'].includes(e.type)) return base.join(' ');
    if (e.type === 'V3') return [...base, e.ac ?? e.value, e.phase].join(' ');
    if (['V', 'I'].includes(e.type)) return [...base, 'DC', e.value, 'AC', e.ac ?? e.value, e.phase].join(' ');
    if (['F', 'H'].includes(e.type)) {
      if (!exportName.has(e.control)) throw Error(`${e.name} 需要指定电流控制支路。`);
      base.push(exportName.get(e.control));
    }
    base.push(e.value);
    if (e.type === 'Z') base.push(e.reactance);
    if (['C', 'L'].includes(e.type) && e.initial) base.push(`IC=${e.initial}`);
    return base.join(' ');
  });
  return [`* ${doc.title.replace(/[\r\n]/g, ' ')}`, '* CircuitLab netlist · use project JSON to preserve drawing and references', ...lines,
    ...doc.couplings.map((k, i) => `K${i + 1} ${exportName.get(k.a)} ${exportName.get(k.b)} ${k.k}`), '.end'].join('\n');
}

export function retype(doc, id, type) {
  const element = doc.elements.find(e => e.id === id);
  const { pins, value } = TYPES[type];
  const previous = element.terminals;
  element.terminals = Object.fromEntries(pins.map((key, i) => [key,
    type === 'GND' ? addNode(doc, doc.nodes.find(n => n.reference)?.id ?? '0')
      : previous[key] ?? Object.values(previous)[i] ?? addNode(doc)]));
  Object.assign(element, { type, value, expression: '', ac: null, initial: 0, phase: 0 });
  delete element.control;
  if (type === 'Z') element.reactance = 0;
  else delete element.reactance;
  if (type !== 'L') doc.couplings = doc.couplings.filter(c => c.a !== id && c.b !== id);
  return element;
}
