// GET /api/usage — quota and balance per provider. It reveals balances and, on a cache miss, actually calls
// the providers with stored keys, so the answer only goes to requests addressed to a local host name (no DNS
// rebinding) and only from same origin: a foreign web page must not be able to trigger paid reads either,
// refresh or not. The optional provider= narrows a request to one known id, but never forces a read by
// itself — only refresh=1 does that; provider= alone just narrows which single id a plain cache-miss read (or
// a refresh=1) may touch. An unknown or malformed id is a clear 400 that runs nothing.
import { LOCAL_HOSTS, crossSiteRefusal, sendJson } from './http.js';
import { PROVIDER_ID_PATTERN } from '../usage/service.js';

export function createUsageRoutes({ usage }) {
  async function handle(request, response, url) {
    if (url.pathname !== '/api/usage') return false;
    const hostname = String(request.headers.host || '').split(':')[0];
    if (!LOCAL_HOSTS.has(hostname)) { sendJson(response, 403, { error: `host ${hostname || '(none)'} is not local` }); return true; }
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'GET only' }); return true; }
    const refusal = crossSiteRefusal(request);
    if (refusal) { sendJson(response, 403, { error: refusal }); return true; }
    // crossSiteRefusal only weighs Sec-Fetch-Site and Origin; a request that carries only a cross-site
    // Referer (no fetch metadata, no Origin — a plain cross-site <img>/<script> load from an older browser)
    // would otherwise pass. This is a route-local check, not a change to the shared same-origin helper.
    const referer = request.headers.referer;
    if (typeof referer === 'string') {
      let parsed = null;
      try { parsed = new URL(referer); } catch { parsed = null; }
      const [, port] = String(request.headers.host || '').split(':');
      if (!parsed || !LOCAL_HOSTS.has(parsed.hostname) || (parsed.port || '80') !== (port || '80')) {
        // Fixed text only: the request's own Referer is never echoed back into the response body — that
        // would hand a cross-site caller (or anything reading this response) whatever it put in the header.
        sendJson(response, 403, { error: 'referer refused' });
        return true;
      }
    }
    const refresh = url.searchParams.get('refresh') === '1';
    const wanted = url.searchParams.get('provider');
    if (wanted !== null && !PROVIDER_ID_PATTERN.test(wanted)) {
      sendJson(response, 400, { error: 'provider id 只能是小写字母开头的短名（字母、数字、- 或 _，最长 32 位）' });
      return true;
    }
    // A usage service that does not implement listProviderIds cleanly (a broken or incomplete stub) must
    // still fail with a clean 400 for a provider= request, never an uncaught exception surfacing as a 500.
    let known = [];
    if (wanted !== null) {
      try { known = typeof usage.listProviderIds === 'function' ? usage.listProviderIds() : []; } catch { known = []; }
      if (!Array.isArray(known)) known = [];
      if (!known.includes(wanted)) {
        sendJson(response, 400, { error: `未知的用量来源：${wanted}` });
        return true;
      }
    }
    sendJson(response, 200, await usage.report({ refresh, provider: wanted }));
    return true;
  }
  return { handle };
}

