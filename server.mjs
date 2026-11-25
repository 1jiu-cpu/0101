import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeTool, TOOL_SCHEMAS } from './src/tooling.js';

const root = dirname(fileURLToPath(import.meta.url));
const qa = process.argv.includes('--qa');
const MAX_API_BYTES = 8 * 1024 * 1024;
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

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_API_BYTES) {
        rejectBody(Error('请求体超过 8 MB 限制。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolveBody(text ? JSON.parse(text) : {});
      } catch {
        rejectBody(Error('请求体不是合法的 JSON。'));
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }).end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/tools' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, tools: TOOL_SCHEMAS });
      return;
    }
    if (pathname.startsWith('/api/tools/') && req.method === 'POST') {
      const toolName = pathname.slice('/api/tools/'.length);
      try {
        const body = await readJsonBody(req);
        const result = invokeTool(toolName, body);
        sendJson(res, 200, { ok: true, tool: toolName, result });
      } catch (err) {
        sendJson(res, 400, { ok: false, tool: toolName, error: err.message });
      }
      return;
    }
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
