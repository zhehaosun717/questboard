// OMO model assignments: GET /api/omo, POST /api/omo (save), GET /api/omo/models (from `opencode models`).
import { LOCAL_HOSTS, readJsonBody, sendJson, writeRefusal } from './http.js';
import { omoConfigFile, parseModelList, readOmo, saveOmo } from '../integrations/omo.js';
import { runCommand } from '../usage/common.js';

const MODELS_CACHE_MS = 5 * 60 * 1000;

export function createOmoRoutes({ file = omoConfigFile(), exec = runCommand, now = () => Date.now() } = {}) {
  let models = null;

  async function handle(request, response, url) {
    if (url.pathname !== '/api/omo' && url.pathname !== '/api/omo/models') return false;
    const hostname = String(request.headers.host || '').split(':')[0];
    if (!LOCAL_HOSTS.has(hostname)) { sendJson(response, 403, { error: `host ${hostname || '(none)'} is not local` }); return true; }
    try {
      if (url.pathname === '/api/omo/models' && request.method === 'GET') {
        if (url.searchParams.get('refresh') === '1' || !models || now() - models.at > MODELS_CACHE_MS) {
          models = { at: now(), list: parseModelList(await exec('opencode', ['models'], { timeoutMs: 90000 })) };
        }
        sendJson(response, 200, { models: models.list });
      } else if (url.pathname === '/api/omo' && request.method === 'GET') {
        sendJson(response, 200, readOmo(file));
      } else if (url.pathname === '/api/omo' && request.method === 'POST') {
        const refusal = writeRefusal(request);
        if (refusal) { sendJson(response, 403, { error: refusal }); return true; }
        const body = await readJsonBody(request, 256 * 1024);
        sendJson(response, 200, saveOmo(file, body.items));
      } else {
        sendJson(response, 405, { error: 'method not allowed' });
      }
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  return { handle };
}
