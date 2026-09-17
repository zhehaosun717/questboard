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

function hostName(host) {
  const value = String(host || '');
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']') > 0 ? value.indexOf(']') : undefined).toLowerCase();
  return value.split(':')[0].toLowerCase();
}

// Every request enters through server.js, including reads and methods no route currently handles. A missing
// Host is allowed for the CLI's plain local HTTP requests; an explicit rebinding host is not.
export function localHostRefusal(request) {
  const host = request.headers.host;
  if (host === undefined || host === null || host === '') return null;
  if (!LOCAL_HOSTS.has(hostName(host))) return `主机 ${host} 不是本机，拒绝读取`;
  return null;
}

export function routeParts(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch (error) {
    const malformed = new Error('地址编码不正确');
    malformed.code = 'malformed_path_encoding';
    malformed.cause = error;
    throw malformed;
  }
}

export function readJsonBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error('请求内容太大');
        error.code = 'request_too_large';
        fail(error);
        // Consume the rest so the response can be written before the request socket closes.
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const value = text.trim() ? JSON.parse(text) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
        settled = true;
        resolve(value);
      } catch (error) {
        fail(error);
      }
    });
    request.on('error', fail);
  });
}

// Writes here can start paid workers. Any web page the owner visits can send a no-preflight POST to
// 127.0.0.1, so a write must be JSON (forcing a preflight this server never answers), same-origin, and
// addressed to a local host name (DNS rebinding).
export function writeRefusal(request) {
  return crossSiteRefusal(request)
    || (String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json') ? null : 'content-type must be application/json');
}

// The same-origin part alone, for GETs with side effects (a refresh that calls providers or runs a CLI): a
// web page elsewhere cannot read the answer, but it should not be able to trigger the work either.
export function crossSiteRefusal(request) {
  const host = String(request.headers.host || '');
  const [hostname, port] = host.split(':');
  if (!LOCAL_HOSTS.has(hostname)) return `host ${host || '(none)'} is not local`;
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return `cross-site request refused (${site})`;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed = null;
    try { parsed = new URL(origin); } catch { parsed = null; }
    // Fixed text only: the request's own Origin is never echoed back into the response body — that would
    // hand a cross-site caller (or anything reading this response) whatever it put in the header.
    if (!parsed || !LOCAL_HOSTS.has(parsed.hostname) || (parsed.port || '80') !== (port || '80')) return 'origin refused';
  }
  return null;
}

// Resolves a request path under a root, or null when it would escape the root — lexically, or through a
// symlink or junction inside the root that points outside it.
export function safeJoin(root, relative) {
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(file)) return file;
  try {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(file);
    return real.startsWith(realBase + path.sep) ? real : null;
  } catch {
    return null;
  }
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
