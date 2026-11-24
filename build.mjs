import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const encode = (content, mime) => `data:${mime};base64,${Buffer.from(content).toString('base64')}`;
const files = await readdir(new URL('./src/', import.meta.url));
const mark = encode(await read('./assets/mark.svg'), 'image/svg+xml');
const imports = {};
for (const name of files.filter(file => file.endsWith('.js'))) {
  const code = (await read('./src/' + name)).replace(/from '\.\/([\w-]+\.js)'/g, "from 'circuitlab/$1'").replaceAll('/assets/mark.svg', mark);
  imports['circuitlab/' + name] = encode(code, 'text/javascript');
}
const css = await read('./src/styles.css');
const html = (await read('./index.html'))
  .replace('/assets/mark.svg', mark)
  .replace('<link rel="stylesheet" href="/src/styles.css">', `<style>${css}</style>`)
  .replace('<script type="module" src="/src/app.js"></script>', `<script type="importmap">${JSON.stringify({ imports })}</script>
  <script type="module">import 'circuitlab/app.js';</script>`);
const dist = new URL('./dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await writeFile(new URL('CircuitLab.html', dist), html);
console.log(fileURLToPath(new URL('CircuitLab.html', dist)));
