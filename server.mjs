import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const qa = process.argv.includes('--qa');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};
const contained = (file, directory) => file.startsWith(resolve(root, directory) + sep);
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = pathname === '/' ? resolve(root, 'index.html') : resolve(root, '.' + pathname);
    const type = contentTypes[extname(file)];
    const testFile = qa && (file === resolve(root, 'test/browser.html') || contained(file, 'test/fixtures') ||
      file === resolve(root, '.circuitlab/published.png') || file === resolve(root, 'dist/CircuitLab.html'));
    if (!type || !(testFile || file === resolve(root, 'index.html') || contained(file, 'src') || contained(file, 'assets'))) {
      res.writeHead(404).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
const port = Number(process.env.PORT || process.argv[2] || 9128);
server.listen(port, '127.0.0.1', () => console.log(`CircuitLab  http://127.0.0.1:${server.address().port}`));
