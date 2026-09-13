// Small HTTP helpers shared by every route module.
import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

export function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(body);
}

export function routeParts(pathname) {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

export function readJsonBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('request body is too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const value = text.trim() ? JSON.parse(text) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

// Writes here can start paid workers. Any web page the owner visits can send a no-preflight POST to
// 127.0.0.1, so a write must be JSON (forcing a preflight this server never answers), same-origin, and
// addressed to a local host name (DNS rebinding).
export function writeRefusal(request) {
  const host = String(request.headers.host || '');
  const [hostname, port] = host.split(':');
  if (!LOCAL_HOSTS.has(hostname)) return `host ${host || '(none)'} is not local`;
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return `cross-site request refused (${site})`;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed = null;
    try { parsed = new URL(origin); } catch { parsed = null; }
    if (!parsed || !LOCAL_HOSTS.has(parsed.hostname) || (parsed.port || '80') !== (port || '80')) return `origin ${origin} refused`;
  }
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return 'content-type must be application/json';
  return null;
}

// Resolves a request path under a root, or null when it would escape the root.
export function safeJoin(root, relative) {
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  return file.startsWith(base + path.sep) ? file : null;
}

export function sendFile(response, file, { csp } = {}) {
  const type = file && TYPES[path.extname(file).toLowerCase()];
  if (!file || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  const body = fs.readFileSync(file);
  const headers = { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  if (csp) headers['content-security-policy'] = csp;
  response.writeHead(200, headers);
  response.end(body);
}
