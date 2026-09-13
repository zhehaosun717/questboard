// GET /api/usage — quota and balance per provider. Read-only, but it reveals balances, so it answers only
// requests addressed to a local host name (a DNS-rebound page cannot read it).
import { LOCAL_HOSTS, crossSiteRefusal, sendJson } from './http.js';

export function createUsageRoutes({ usage }) {
  async function handle(request, response, url) {
    if (url.pathname !== '/api/usage') return false;
    const hostname = String(request.headers.host || '').split(':')[0];
    if (!LOCAL_HOSTS.has(hostname)) { sendJson(response, 403, { error: `host ${hostname || '(none)'} is not local` }); return true; }
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'GET only' }); return true; }
    const refresh = url.searchParams.get('refresh') === '1';
    // A refresh calls every provider with its key; only the board page itself may ask for that.
    const refusal = refresh ? crossSiteRefusal(request) : null;
    if (refusal) { sendJson(response, 403, { error: refusal }); return true; }
    sendJson(response, 200, await usage.report({ refresh }));
    return true;
  }
  return { handle };
}
