import { writeFile } from 'node:fs/promises';

const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const stroke = 'stroke="#292522" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const line = path => `<path d="${path}" ${stroke}/>`;
const terminal = ([x,y], dot = false) => `<circle cx="${x}" cy="${y}" r="${dot ? 4 : 4.5}" fill="${dot ? '#292522' : 'white'}" stroke="#292522" stroke-width="2"/>`;
const text = ([x,y], value, font, size = 21) => `<text x="${x}" y="${y}" style="font:${size}px ${font}">${xml(value)}</text>`;

function branch(p, n, type, arrowOffset = 31, position = .5) {
  const dx = n[0] - p[0], dy = n[1] - p[1];
  const len = Math.hypot(dx, dy);
  const x = p[0] + dx * position, y = p[1] + dy * position;
  const turn = Math.atan2(dy, dx) * 180 / Math.PI;
  const half = type === 'V' ? 17 : 23;
  const lead = line(`M${-len*position} 0H${-half} M${half} 0H${len*(1-position)}`);
  const shape = type === 'V' ?
    `<circle r="17" ${stroke}/>${line('M-9 1Q-5 -6 0 0t9-1')}
    ${line(`M25 ${arrowOffset}H-25`)}<path d="M-27 ${arrowOffset}l11 -5v10z" fill="#292522"/>` :
    `<rect x="-23" y="-8" width="46" height="16" ${stroke}/>`;
  return `<g transform="translate(${x} ${y}) rotate(${turn})">${lead}${shape}</g>`;
}

const wrap = (bits, w = 1020, h = 530) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#fff"/>${bits.join('')}</svg>`;

const serif = "'Times New Roman', serif";
const sans = 'Arial, sans-serif';
function label(points, descriptions, font) {
  return points.map((p,i) => text(p, descriptions[i], font));
}
const to = (a,b) => line(`M${a.join(' ')}L${b.join(' ')}`);

function ySource(left, center, offsets) {
  return left.map((p, i) => branch(p, center, 'V', offsets[i]));
}

const load = ['Z1 = 40+j30 Ω','Z2 = 40+j30 Ω','Z3 = 40+j30 Ω'];
const yyLeft = [[250,105],[250,275],[250,445]];
const yyRight = [[660,105],[660,275],[660,445]];
const yyN1 = [92,275], yyN2 = [900,275];
const yy = [
  ...ySource(yyLeft, yyN1, [32, -29, 35]),
  ...yyLeft.map((p,i) => to(p,yyRight[i])),
  ...yyRight.map(p => branch(p,yyN2,'Z')),
  line('M92 275H39V495H964V275H900'),
  ...[...yyLeft,...yyRight].map(p => terminal(p)),
  terminal(yyN1,true), terminal(yyN2,true),
  ...label([[264,168],[264,258],[264,390]], ['Va = 240∠0° V','Vb = 240∠−120° V','Vc = 240∠+120° V'], serif),
  ...label([[764,140],[688,248],[764,416]], load, serif),
];

const dyLeft = [[217,105],[220,445],[360,275]];
const dyRight = [[660,105],[660,445],[660,275]];
const dyN = [900,275];
const dy = [
  ...dyLeft.map((p,i) => branch(p,dyLeft[(i+1)%3],'V',[30,-37,33][i])),
  ...dyLeft.map((p,i) => to(p,dyRight[i])),
  ...dyRight.map(p => branch(p,dyN,'Z')),
  ...[...dyLeft,...dyRight].map(p => terminal(p,true)),
  terminal(dyN,true),
  ...label([[20,271],[375,365],[375,190]], ['Va = 230∠0° V','Vb = 230∠−120° V','Vc = 230∠120° V'], sans),
  ...label([[764,140],[764,416],[688,248]], ['Z1 = 200∠0° Ω','Z2 = 200∠0° Ω','Z3 = 200∠0° Ω'], sans),
];

const ydLeft = [[250,105],[250,275],[250,445]];
const ydN = [91,275];
const ydRight = [[660,105],[927,275],[665,445]];
const ydWires = [
  ...ySource(ydLeft, ydN, [35,32,-34]),
  ...ydLeft.map((p,i)=>to(p,ydRight[i])),
  ...ydRight.map((p,i)=>branch(p,ydRight[(i+1)%3],'Z',0,i===2?.26:.5)),
  ...[...ydLeft,...ydRight].map(p=>terminal(p,true)),
  terminal(ydN,true),
  ...label([[264,168],[264,258],[264,390]], ['Va = 100∠0° V','Vb = 100∠−120° V','Vc = 100∠+120° V'], serif),
  ...label([[820,172],[830,408],[488,334]], load, serif),
];

for (const [name, bits] of [['fiore-wye-wye',yy],['fiore-delta-wye',dy],['fiore-wye-delta',ydWires]]) {
  await writeFile(new URL('../test/fixtures/' + name + '.svg', import.meta.url), wrap(bits));
}
