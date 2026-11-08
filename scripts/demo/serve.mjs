// Serves dist-demo/ on http://127.0.0.1:4180 the way its .htaccess does on the host: the same
// CSP and noindex headers, every unknown path answered with index.html, and 404 for /api.
// For checking the demo before a deploy: npm run build:demo && npm run demo:serve
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../dist-demo/', import.meta.url));
const htaccess = readFileSync(join(root, '.htaccess'), 'utf8');
const header = (name) => new RegExp(`Header always set ${name} "([^"]+)"`).exec(htaccess)?.[1];
const headers = {
  'Content-Security-Policy': header('Content-Security-Policy'),
  'X-Robots-Tag': header('X-Robots-Tag'),
  'X-Content-Type-Options': 'nosniff',
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (/^\/api(\/|$)/.test(path)) {
    res.writeHead(404, headers).end('Not found');
    return;
  }
  const asked = normalize(join(root, path));
  const file = asked.startsWith(root) && isFile(asked) ? asked : join(root, 'index.html');
  res.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(4180, '127.0.0.1', () => console.log('The demo is on http://127.0.0.1:4180'));
