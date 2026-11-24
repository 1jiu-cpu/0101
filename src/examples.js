import { addElement, empty } from './model.js';
import { parseNetlist } from './input.js';

export const EXAMPLES = [
  { id: 'rc', name: 'RC 低通滤波器', type: '一阶动态电路', icon: 'capacitor' },
  { id: 'divider', name: '电阻分压电路', type: '直流稳态', icon: 'resistor' },
  { id: 'rlc', name: 'RLC 串联谐振', type: '二阶动态电路', icon: 'inductor' },
  { id: 'bridge', name: '惠斯通电桥', type: '多回路网络', icon: 'nodes' },
  { id: 'op', name: '理想反相放大器', type: '受控线性网络', icon: 'opamp' },
  { id: 'three', name: '星形三相负载', type: '正弦稳态', icon: 'ac' },
];

export function example(id = 'rc') {
  const meta = EXAMPLES.find(e => e.id === id);
  if (!meta) return empty();
  if (id === 'rc' || id === 'divider') {
    const model = empty(meta.name);
    addElement(model, 'V', { name: 'V1', value: id === 'rc' ? 5 : 12, ac: 1, terminals: { p: 'in', n: '0' }, pose: { x: 140, y: 280, rotation: 90 } });
    addElement(model, 'R', { name: 'R1', value: 1000, terminals: { p: 'in', n: 'out' }, pose: { x: 370, y: 140 } });
    addElement(model, id === 'rc' ? 'C' : 'R', { name: id === 'rc' ? 'C1' : 'R2', value: id === 'rc' ? 1e-7 : 2000, terminals: { p: 'out', n: '0' }, pose: { x: 600, y: 280, rotation: 90 } });
    addElement(model, 'GND', { pose: { x: 370, y: 448 } });
    model.nodes.find(n => n.id === 'in').label = 'Vin';
    model.nodes.find(n => n.id === 'out').label = 'Vout';
    return model;
  }
  const listings = {
    rlc: 'V1 in 0 DC 5 AC 1\nR1 in a 100\nL1 a b 10m\nC1 b 0 100u',
    bridge: 'V1 in 0 10\nR1 in a 1k\nR2 a 0 2k\nR3 in b 1k\nR4 b 0 3k\nR5 a b 1k',
    op: 'V1 in 0 DC 1 AC 1\nR1 in minus 1k\nR2 minus out 4k\nU1 0 minus out 0\nR3 out 0 10k',
    three: 'V3_1 A B C 0 220\nR1 A 0 20\nR2 B 0 30\nR3 C 0 40',
  };
  return parseNetlist(listings[id], meta.name);
}
