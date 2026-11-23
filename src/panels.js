import { TYPES, formatValue, members, referenceNode, validate } from './model.js';
import { esc, scene } from './drawing.js';
import { route } from './layout.js';
import { recommendations } from './reduce.js';
import { button, tool, icon, partIcon, compact, rectangular, polar, note, table, field, input, select, componentValue, plot } from './ui.js';

const nodeOptions = doc => doc.nodes.map(n => [n.id, n.reference ? `${n.label}（参考地）` : n.label]);
export const methods = [
  ['dc', '直流稳态 · 节点电压法'], ['ac', '交流稳态 · 相量法'], ['time', '时域响应'],
  ['bode', '频率响应 · 网络函数'], ['port', '戴维南 · 诺顿（直流）'], ['portAc', '戴维南 · 最大功率（交流）'], ['two', '二端口参数'], ['graph', '拓扑矩阵 · KCL / KVL'],
  ['branch', '直流 · 支路电流法'], ['loop', '直流 · 回路电流法'], ['periodic', '非正弦周期 · 傅里叶级数'],
];

function partList(doc) {
  return `<div class="part-list">${doc.elements.map(e => `<button class="part-row" type="button" data-action="pick-part" data-id="${esc(e.id)}">
    <span class="part-icon">${partIcon(e.type, 19)}</span><span class="part-ident"><b>${esc(e.name)}</b><span>${TYPES[e.type].label}</span></span>
    <span class="part-amount">${esc(componentValue(e))}</span>${icon('right', 13)}</button>`).join('')}</div>`;
}

function issueList(evidence) {
  if (!evidence) return '';
  const issues = Object.entries(evidence.issues);
  return `<section class="panel-section">
    <div class="section-head"><h3>识别校对</h3>${button('source', '对照原图', 'image', 'small')}</div>
    ${issues.length ? note(`${issues.length} 个元件待核对。`, 'warning') : ''}
    ${issues.map(([id, s]) => `<button class="review-row" type="button" data-action="pick-part" data-id="${esc(id)}">${icon('warning', 14)}${esc(s)}${icon('right', 14)}</button>`).join('')}
    ${evidence.review ? note(esc(evidence.review), 'warning') + button('confirm-image', '已核对整张电路', 'check', 'outline wide') : ''}
  </section>`;
}

export function properties(doc, selection, pending, evidence, net) {
  const selected = doc.elements.filter(e => selection.has(e.id));
  const e = selected.length === 1 ? selected[0] : null;
  if (selected.length > 1) return `<div class="panel-heading"><h2>已选择 ${selected.length} 个元件</h2><p>可一起移动，也可应用可用的等效变换。</p></div>
    <div class="action-row">${button('rotate', '旋转', 'rotate', 'outline')}${button('copy', '复制', 'copy', 'outline')}${button('delete', '删除', 'trash', 'outline')}</div>
    ${button('reduce', '查看等效变换', 'layers', 'primary wide')}`;
  if (e) {
    const spec = TYPES[e.type];
    const g = doc.geometry[e.id];
    const currentControllers = doc.elements.filter(item => item.id !== e.id && TYPES[item.type].pins.length === 2).map(item => [item.id, item.name]);
    return `<div class="panel-heading"><div class="spec-head"><span class="part-icon large">${partIcon(e.type, 25)}</span><div><h2>${esc(e.name)}</h2><p>${spec.label}</p></div>${tool('part-menu', '元件操作', 'menu')}</div></div>
    ${evidence?.issues[e.id] ? note(esc(evidence.issues[e.id]), 'warning') + button('confirm-part', '确认此元件', 'check', 'outline wide') : ''}
    <section class="panel-section"><h3>元件参数</h3>
      <div class="field-row">${field('名称', input('name', e.name, '', 'maxlength="60"'))}${field('类型', select('type', Object.entries(TYPES).map(([key, spec]) => [key, spec.label]), e.type))}</div>
      ${componentValue(e) !== '—' ? field(e.type === 'Z' ? '电阻 R · Ω' : `数值 ${spec.unit ? '· ' + spec.unit : ''}`, input('value', e.expression && !e.expression.startsWith('{') ? e.expression : formatValue(e.value, spec.unit), '', 'inputmode="text"')) : ''}
      ${e.type === 'Z' ? field('电抗 X · Ω', input('reactance', formatValue(e.reactance, 'Ω'))) : ''}
      ${spec.initial ? field(`初始条件 · ${spec.initial}`, input('initial', formatValue(e.initial, spec.initial))) : ''}
      ${['V', 'I', 'V3'].includes(e.type) ? `<div class="field-row">${field('交流有效值', input('ac', e.ac === null ? '' : formatValue(e.ac, spec.unit), '沿用数值'))}${field('相位 · °', input('phase', e.phase))}</div>` : ''}
      ${['F', 'H'].includes(e.type) ? field('控制支路', select('control', [['', '选择支路'], ...currentControllers], e.control)) : ''}
      ${['L'].includes(e.type) ? button('couple', '编辑互感', 'inductor', 'outline wide') : ''}
    </section>
    <section class="panel-section"><div class="section-head"><h3>端口与参考方向</h3>${pending ? '<span class="accent-text">正在连线</span>' : ''}</div>
      ${Object.entries(e.terminals).map(([p, n]) => `<div class="pin-row"><code>${esc(p)}</code>
        <select data-field="pin-node" data-pin-name="${p}" aria-label="${p} 端所属节点" ${e.type === 'GND' ? 'disabled' : ''}>${nodeOptions(doc).map(([value, label]) => `<option value="${esc(value)}" ${n === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
        ${tool('pick-pin', '连线端口 ' + p, 'wire', '', `data-pin-name="${p}"`)}${e.type !== 'GND' ? tool('disconnect-pin', '断开端口 ' + p, 'split', '', `data-pin-name="${p}"`) : ''}</div>`).join('')}
      ${e.terminals.p ? `<div class="action-row tight">${button('flip-current', '电流反向', 'right', 'outline')}${button('flip-voltage', '极性反向', 'plus', 'outline')}
        ${button('swap-ports', '对调 p/n', 'wire', 'outline')}</div>` : ''}
    </section>
    <section class="panel-section"><h3>布局</h3><div class="action-row tight">${button('rotate', '旋转', 'rotate', 'outline')}${button('mirror', '镜像', 'mirror', 'outline')}${button('lock', g.locked ? '已固定' : '固定', 'lock', 'outline')}</div></section>`;
  }
  if (net && doc.nodes.some(n => n.id === net)) {
    const target = doc.nodes.find(n => n.id === net);
    return `<div class="panel-heading"><h2>节点 ${esc(target.label)}</h2><p>${members(doc, net).length} 个端口连接到此节点</p></div>
      ${field('节点标签', input('net-label', target.label))}<div class="action-row">${button('ground-net', '设为参考地', 'ground', 'outline')}${button('merge-net', '连接此节点', 'wire', 'outline')}</div>
      <section class="panel-section"><h3>已连接端口</h3>${members(doc, net).map(pin => `<div class="pin-row"><span>${esc(doc.elements.find(e => e.id === pin.id).name + '.' + pin.pin)}</span>
      ${tool('net-disconnect', '断开此端口', 'split', '', `data-id="${esc(pin.id)}" data-pin-name="${pin.pin}"`)}</div>`).join('')}</section>`;
  }
  const { errors, warnings } = validate(doc);
  return `<div class="panel-heading"><h2>电路概览</h2><p>在画布中选中元件以编辑属性。</p></div>
    <div class="stats"><div><strong>${doc.elements.filter(e => e.type !== 'GND').length}</strong><span>元件</span></div>
      <div><strong>${doc.nodes.length}</strong><span>节点</span></div><div><strong>${doc.couplings.length}</strong><span>互感</span></div></div>
    ${issueList(evidence)}<section class="panel-section"><h3>元件列表</h3>${doc.elements.length ? partList(doc) : '<p class="secondary">从元件栏添加元件，或导入电路。</p>'}</section>
    <section class="panel-section"><h3>拓扑状态</h3>
      ${errors.length || warnings.length ? (errors.length ? errors : warnings).slice(0, 4).map(s => note(esc(s), 'warning')).join('') : doc.elements.length ? note('端口和节点引用均有效。') : '<p class="secondary">连接元件后可检查拓扑。</p>'}
      ${doc.nodes.length ? field('参考节点', select('reference', [['', '选择节点'], ...nodeOptions(doc)], doc.nodes.find(n => n.reference)?.id)) : ''}
    </section>`;
}

function matrixTable(A, names) {
  if (A.length > 24 || names.length > 32) return '<p class="secondary">矩阵较大，可在报告中查看完整数据。</p>';
  return table(['', ...names.map(esc)], A.map((row, i) => [`<b>${i + 1}</b>`, ...row.map(compact)]));
}

const textPhasor = (value, unit) => `<strong>${esc(polar(value, unit))}</strong><span class="result-sub">${esc(rectangular(value))}</span>`;

function phasorDiagram(nodes) {
  const vectors = nodes.filter(n => n.voltage.magnitude > 1e-12).slice(0, 8);
  if (!vectors.length) return '';
  const maximum = Math.max(...vectors.map(n => n.voltage.magnitude));
  const colors = ['#ad5c45', '#476b62', '#7865a0', '#a38033', '#5d7096', '#4d463d'];
  return `<svg class="phasor" role="img" viewBox="0 0 280 176" aria-label="节点电压相量">
    <circle cx="140" cy="86" r="60" fill="none" stroke="#e2dacf"/><circle cx="140" cy="86" r="30" fill="none" stroke="#e2dacf" stroke-dasharray="3 3"/>
    <path d="M48 86h184M140 8v155" stroke="#c8c0b5"/><g font-size="10" fill="#776c60"><text x="235" y="89">实轴</text><text x="145" y="13">虚轴</text></g>
    ${vectors.map((n, i) => {
      const dx = n.voltage.re / maximum;
      const dy = -n.voltage.im / maximum;
      const x = 140 + 60 * dx;
      const y = 86 + 60 * dy;
      return `<g fill="${colors[i % colors.length]}" stroke="${colors[i % colors.length]}"><path d="M140 86L${x} ${y}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="3"/><text x="${x + (dx > -.2 ? 7 : -7)}" y="${y + (dy > 0 ? 15 : -6)}" text-anchor="${dx > -.2 ? 'start' : 'end'}" stroke="none" font-size="11">${esc(n.label)}</text></g>`;
    }).join('')}</svg>`;
}

function scalarResults(result) {
  const ac = result.mode === 'ac';
  const fixedImpedance = result.branches.some(b => b.type === 'Z');
  return `<section class="panel-section result-section"><h3>节点电压</h3>
    ${table(['节点', ac ? '电压相量 · 有效值' : '电压'], result.nodes.map(n => [`${esc(n.label)}${n.reference || result.reference === n.id ? ' <small>参考</small>' : ''}`, ac ? textPhasor(n.voltage, 'V') : esc(formatValue(n.voltage.re, 'V'))]))}
    ${ac ? phasorDiagram(result.nodes) : ''}
  </section><section class="panel-section"><h3>支路电流与功率</h3>
    ${result.redundant ? note('理想源闭环约束相容。环流无法唯一确定，表中保留可确定的电压与电流。', 'warning') : ''}
    ${table(['支路', '电流', ac ? 'P / Q' : '功率'], result.branches.map(b => [esc(b.name),
      !b.current ? '不唯一' : ac ? textPhasor(b.current, 'A') : esc(formatValue(b.current.re, 'A')),
      !b.power ? '不唯一' : ac ? `${esc(formatValue(b.power.re, 'W'))}<span class="result-sub">${esc(formatValue(b.power.im, 'var'))}</span>` : esc(formatValue(b.power.re, 'W'))]))}
    ${ac ? `<details><summary>视在功率与功率因数</summary>${table(['支路', '|S|', 'PF'], result.branches.map(b => [esc(b.name), esc(formatValue(b.power?.magnitude, 'VA')), b.power?.magnitude ? compact(b.power.re / b.power.magnitude) : '—']))}</details>` : ''}
  </section><section class="panel-section"><h3>推导与验证</h3>
    <p class="secondary">按节点 KCL 和元件约束建立修正节点方程。支路电压由端点电位相减，电流按元件本构关系或辅助未知量得到。</p>
    <div class="formula">${fixedImpedance ? '(G + j(ωE + J)) x = b' : ac ? '(G + jωE) x = b' : 'G x = b'}</div>
    <details><summary>矩阵 G 和右端项</summary>${matrixTable(result.G.map((row, i) => [...row, result.rhs[i].re]), [...result.names, 'Re(b)'].map(String))}</details>
    ${ac ? `<details><summary>动态矩阵 E 与虚部激励</summary>${matrixTable(result.E.map((row, i) => [...row, result.rhs[i].im]), [...result.names, 'Im(b)'])}</details>` : ''}
    ${fixedImpedance ? `<details><summary>固定电抗系数矩阵 J</summary>${matrixTable(result.J, result.names)}</details>` : ''}
    ${note(`KCL 残差 ${esc(formatValue(result.kcl, 'A'))} · 元件约束残差 ${compact(result.laws)}`, result.kcl > 1e-7 || result.laws > 1e-7 ? 'warning' : 'neutral')}
    <p class="secondary">功率平衡 ΣP = ${esc(formatValue(result.power.re, 'W'))}${ac ? `，ΣQ = ${esc(formatValue(result.power.im, 'var'))}` : ''}</p></section>`;
}

function polynomial(coeffs) {
  return coeffs.map((v, i) => [v, i]).reverse().filter(([v]) => v !== 0).map(([v, i], j) =>
    `${j === 0 ? v < 0 ? '−' : '' : v < 0 ? ' − ' : ' + '}${Math.abs(v) === 1 && i ? '' : compact(Math.abs(v))}${i ? 's' + (i === 2 ? '²' : '') : ''}`).join('') || '0';
}

function analysisOutput(mode, r) {
  if (mode === 'dc' || mode === 'ac') return scalarResults(r);
  if (mode === 'time' && r.kind === 'pulse') return `<section class="panel-section result-section"><h3>矩形脉冲 · 卷积响应</h3>
    ${plot(r.samples, { label: '单位矩形脉冲的输出电压', unit: 'V' })}
    <div class="formula">v(t) = ∫ₜ₋ₜwᵗ h(τ) dτ</div>
    <p class="secondary">宽度为 ${esc(formatValue(r.width, 's'))} 的单位矩形输入与冲激响应卷积。连续部分按图中采样步长积分，直通项按输入波形叠加。</p></section>`;
  if (mode === 'time' && r.kind === 'impulse') return `<section class="panel-section result-section"><h3>单位冲激响应</h3>
    ${plot(r.samples, { label: '冲激响应的连续部分', unit: r.unit ? 'Ω/s' : 's⁻¹' })}
    <div class="formula">H(s) = (${polynomial(r.rational.numerator)}) / (${polynomial(r.rational.denominator)})</div>
    <p class="secondary">从所选源到指定输出求 H(s)，分解为有理式后做拉普拉斯反变换。${r.feedthrough ? `零时刻冲激项为 ${compact(r.feedthrough)} δ(t)，曲线显示连续部分。` : ''}</p></section>`;
  if (mode === 'time') return `<section class="panel-section result-section"><h3>节点电压随时间变化</h3>${plot(r.samples, { label: '节点电压时域响应', unit: 'V' })}
    ${table(['初值', '末值', '时间步长'], [[esc(formatValue(r.samples[0].y, 'V')), esc(formatValue(r.samples.at(-1).y, 'V')), esc(formatValue(r.step, 's'))]])}
    <p class="secondary">由电容电压连续和电感电流连续确定初始状态，再对修正节点方程使用梯形积分。</p><div class="formula">E ẋ + G x = b(t)</div>
    ${table(['储能元件', '初始条件'], r.initial.map(e => [esc(e.name), esc(formatValue(e.value, e.type === 'C' ? 'V' : 'A'))]))}
    ${note(`离散方程最大残差 ${compact(r.residual)}`, r.residual > 1e-7 ? 'warning' : 'neutral')}</section>`;
  if (mode === 'bode') return `<section class="panel-section result-section"><h3>幅频响应</h3>${plot(r.samples, { label: '幅频响应', unit: r.unit ? 'dBΩ' : 'dB', log: true, labelX: 'f · Hz' })}
    <h3>相频响应</h3>${plot(r.samples, { label: '相频响应', unit: '°', log: true, key: 'phase', color: '#54746c', labelX: 'f · Hz' })}
    <p class="secondary">将所选源置为单位激励，其他独立源置零。逐频点求解 H(jω)。</p>
    ${r.rational ? `<div class="formula">H(s) = (${polynomial(r.rational.numerator)}) / (${polynomial(r.rational.denominator)})</div>
      ${table(['特征', '复频率 · rad/s'], [['零点', r.rational.zeros.map(rectangular).join('<br>') || '—'], ['极点', r.rational.poles.map(rectangular).join('<br>') || '—']])}` : ''}</section>`;
  if (mode === 'port') return `<section class="panel-section result-section"><h3>直流端口等效</h3>
    ${table(['量', '计算值'], [['开路电压 Vₜₕ', esc(formatValue(r.voltage, 'V'))], ['等效电阻 Rₜₕ', esc(formatValue(r.resistance, 'Ω'))], ['诺顿电流 Iₙ', esc(formatValue(r.norton, 'A'))], ['最大负载功率', esc(formatValue(r.maxPower, 'W'))]])}
    <p class="secondary">计算端口电压后，将独立源置零并注入 1 A，所得端口电压即等效电阻。测量开路参数前，可在画布中移除外接负载。</p><div class="formula">V = Vₜₕ − I·Rₜₕ</div>
    <h3>叠加定理</h3>${table(['独立源', '端口电压贡献'], r.contributions.map(v => [esc(v.name), esc(formatValue(v.value, 'V'))]))}${note('叠加残差 ' + esc(formatValue(r.residual, 'V')))}</section>`;
  if (mode === 'portAc') return `<section class="panel-section result-section"><h3>交流端口等效</h3>
    ${table(['量', '计算值'], [['开路电压 Vₜₕ', textPhasor(r.voltage, 'V')], ['等效阻抗 Zₜₕ', textPhasor(r.impedance, 'Ω')],
      ['诺顿电流 Iₙ', r.norton ? textPhasor(r.norton, 'A') : '—'], ['共轭匹配 Z 负载', r.load ? textPhasor(r.load, 'Ω') : '—'],
      ['最大有功功率', esc(formatValue(r.maxPower, 'W'))]])}
    <p class="secondary">将独立源置零后注入单位电流相量，求驱动点复阻抗。当等效电阻为正，负载阻抗取其共轭时有功功率最大。</p>
    <div class="formula">Pₘₐₓ = |Vₜₕ|² / (4 Re(Zₜₕ))</div></section>`;
  if (mode === 'two') return `<section class="panel-section result-section"><h3>开路阻抗矩阵</h3><div class="formula">[V₁, V₂]ᵀ = Z [I₁, I₂]ᵀ</div>
    ${table(['Ω', 'I₁', 'I₂'], r.z.map((row, i) => [`V${i + 1}`, ...row.map(rectangular)]))}
    <p class="secondary">逐一施加单位测试电流，保持另一个端口开路和独立激励置零。</p>
    ${[['y', 'Y 参数（S）', '[I₁, I₂]ᵀ = Y [V₁, V₂]ᵀ'], ['h', 'h 参数', '[V₁, I₂]ᵀ = h [I₁, V₂]ᵀ'], ['abcd', 'ABCD 参数', '[V₁, I₁]ᵀ = ABCD [V₂, −I₂]ᵀ']].map(([key, label, definition]) => `
      <details><summary>${label}</summary><div class="formula">${definition}</div>${r[key] ? table(['', '列 1', '列 2'], r[key].map((row, i) => [i + 1, ...row.map(rectangular)])) : '<p>该参数转换的分母为零。</p>'}</details>`).join('')}</section>`;
  if (mode === 'branch' || mode === 'loop') return `<section class="panel-section result-section"><h3>${mode === 'branch' ? '支路电流' : '回路电流'}</h3>
    <p class="secondary">${mode === 'branch' ? '用基本割集写独立 KCL 方程，用基本回路写 KVL 方程。' : '以生成树的基本回路为变量，用回路叠加求支路电流。含电流源时同时满足其支路约束。'}</p>
    <div class="formula">${mode === 'branch' ? 'Q i = 0，B u = 0' : 'i = Bᵀ iₗ，B u = 0'}</div>
    ${table(['变量', '解'], r.names.map((n, i) => [esc(n), esc(formatValue(r.x[i], n.startsWith('v(') ? 'V' : 'A'))]))}
    <details><summary>系数矩阵与右端项</summary>${matrixTable(r.A.map((row, i) => [...row, r.rhs[i]]), [...r.names, 'b'])}</details>
    ${table(['支路', '电流', '电压'], r.branches.map(b => [esc(b.name), esc(formatValue(b.current, 'A')), esc(formatValue(b.voltage, 'V'))]))}
    ${note(`KCL 残差 ${compact(r.kcl)} A · KVL 残差 ${compact(r.kvl)} V`)}</section>`;
  if (mode === 'periodic') return `<section class="panel-section result-section"><h3>周期稳态输出</h3>
    ${plot(r.samples, { label: '输入周期信号', key: 'input', unit: r.inputUnit, color: '#54746c' })}
    ${plot(r.samples, { label: '输出周期电压', unit: 'V' })}
    <p class="secondary">把单位源响应乘各奇次谐波的峰值，再把各频点的输出实部叠加回时域。</p>
    <div class="formula">v(t) = Σ Re{aₖ H(jkω₀) eʲᵏω₀ᵗ}</div>
    ${table(['谐波', '输入系数', '输出峰值相量'], r.harmonics.map(h => [h.order, esc(formatValue(h.input, r.inputUnit)), textPhasor(h.output, 'V')]))}</section>`;
  return `<section class="panel-section result-section"><h3>基本回路 · KVL</h3>
    ${r.loopsText.length ? r.loopsText.map((formula, i) => `<div class="formula">${esc(formula)}${r.loopResiduals ? ` <small>(残差 ${compact(r.loopResiduals[i])} V)</small>` : ''}</div>`).join('') : '<p class="secondary">当前双端支路不存在闭合基本回路。</p>'}
    <p class="secondary">沿支路正端到负端计方向。图矩阵仅包含双端输出支路，完整多端器件方程见节点法。</p>
    <details><summary>节点-支路关联矩阵 A</summary>${matrixTable(r.incidence, r.branches)}</details><details><summary>基本回路矩阵 B</summary>${matrixTable(r.loops, r.branches)}</details>
    <details><summary>基本割集矩阵 Q</summary>${matrixTable(r.cutsets, r.branches)}</details></section>`;
}

export function analysisPanel(doc, options, state) {
  const mode = options.mode;
  const nodes = nodeOptions(doc);
  const sources = doc.elements.filter(e => ['I', 'V'].includes(e.type)).map(e => [e.id, e.name]);
  const nodeFields = `<div class="field-row">${field('输出正端', select('a-node', nodes, options.node))}${field('输出负端', select('a-negative', nodes, options.negative || referenceNode(doc)))}</div>`;
  return `<div class="panel-heading"><h2>电路分析</h2><p>使用当前画布中的电路参数。</p></div>
    ${field('分析方法', select('analysis-mode', methods, mode))}
    ${['time', 'bode', 'port', 'portAc', 'two', 'periodic'].includes(mode) ? nodeFields : ''}
    ${mode === 'two' ? `<div class="field-row">${field('端口 2 正端', select('a-second', nodes, options.second))}${field('端口 2 负端', select('a-secondNeg', nodes, options.secondNeg || referenceNode(doc)))}</div>` : ''}
    ${mode === 'bode' ? field('输入源', select('a-source', sources, options.source)) + `<div class="field-row">${field('起始频率', input('a-start', options.start))}${field('终止频率', input('a-stop', options.stop))}</div>` : ''}
    ${['ac', 'portAc', 'two', 'periodic'].includes(mode) ? field(mode === 'two' ? '频率 · Hz（0 为直流）' : mode === 'periodic' ? '基波频率 · Hz' : '频率 · Hz', input('a-frequency', options.frequency)) : ''}
    ${mode === 'ac' && doc.elements.some(e => e.type === 'Z') ? '<p class="secondary">固定复阻抗按题给数值使用。频率只改变电容和电感的阻抗。</p>' : ''}
    ${mode === 'time' ? field('仿真时长 · s', input('a-duration', options.duration)) + field('响应类型', select('a-response', [['full', '全响应'], ['zeroState', '零状态 · 阶跃响应'], ['zeroInput', '零输入'], ['impulse', '单位冲激响应'], ['pulse', '矩形脉冲 · 卷积']], options.response))
      + (['impulse', 'pulse'].includes(options.response) ? field('输入源', select('a-source', sources, options.source)) : '')
      + (options.response === 'pulse' ? field('脉冲宽度 · s', input('a-width', options.width)) : '') : ''}
    ${mode === 'periodic' ? field('输入源', select('a-source', sources, options.source)) + field('周期信号', select('a-waveform', [['square', '对称方波'], ['triangle', '对称三角波']], options.waveform))
      + `<div class="field-row">${field('输入峰值', input('a-amplitude', options.amplitude))}${field('奇次谐波项数', input('a-terms', options.terms))}</div>` : ''}
    <div class="analysis-actions">${button('run', '计算', 'bolt', 'primary')}${state.result ? button('report', '导出报告', 'download', 'outline') : ''}</div>
    ${state.error ? note(esc(state.error), 'warning') : state.result ? analysisOutput(mode, state.result) : ''}`;
}

function mini(doc, title) {
  const result = route(doc);
  const { x, y, bottom, right } = result.bounds;
  return `<figure class="mini-schematic"><figcaption>${title}</figcaption><svg role="img" aria-label="${title}" viewBox="${x - 20} ${y - 20} ${right - x + 40} ${bottom - y + 40}">${scene(doc, result)}</svg></figure>`;
}

export function reductionPanel(doc, selection, index, cache = recommendations(doc, [...selection])) {
  const step = doc.history[index];
  return `<div class="panel-heading"><h2>等效化简</h2><p>${selection.size ? '在选中元件中匹配可用变换。' : '选择规则，查看等效关系与验证结果。'}</p></div>
    <div class="action-row">${button('auto-reduce', '自动化简', 'layers', 'primary', cache.some(r => !['sourceTransform', 'deltaStar'].includes(r.rule)) ? '' : 'disabled')}
      ${button('next-reduce', '应用首项', 'right', 'outline', cache.length ? '' : 'disabled')}</div>
    <section class="panel-section"><h3>可用规则</h3>${cache.length ?
      cache.slice(0, 30).map((r, i) => `<button class="rule-row" data-action="apply-rule" data-index="${i}"><span><b>${esc(r.title)}</b><small>${esc(r.names.join('、'))}</small></span>${icon('right', 15)}</button>`).join('') :
      '<p class="secondary">当前选择没有可安全应用的变换。</p>'}</section>
    ${doc.history.length ? `<section class="panel-section"><div class="section-head"><h3>步骤 ${index + 1} / ${doc.history.length}</h3><div class="action-row tiny">
      ${button('step-prev', '上一步', null, 'outline small', index > 0 ? '' : 'disabled')}
      ${button('step-next', '下一步', null, 'outline small', index + 1 < doc.history.length ? '' : 'disabled')}</div></div>
      ${step ? `<h3>${esc(step.title)}</h3><p class="secondary">${esc(step.condition)}</p><div class="formula">${esc(step.formula)}</div>
        <p>${esc(step.relationship)}</p>${note(`${esc(step.verification.label)} · ${compact(step.verification.residual)}`)}
        ${mini(step.before, '变换前')}${mini(step.after, '变换后')}` : ''}</section>` : ''}`;
}
