// GET /api/settings — a read-only summary of where this board reads and writes: the project config, the
// machine roster and status log, where usage keys would come from (present or not, never the key), and the
// OMO file. Paths are local facts, so only local host names get an answer.
import fs from 'node:fs';
import { LOCAL_HOSTS, readJsonBody, sendJson, writeRefusal } from './http.js';
import { readRawConfig, saveProjectConfig } from '../core/config.js';
import { laneServers, startLaneServer } from '../core/laneServer.js';
import { createCredentials, openCodeAuthFile } from '../usage/credentials.js';
import { PROVIDERS } from '../usage/providers.js';
import { omoConfigFile } from '../integrations/omo.js';

export function describeProject(config) {
  return {
    name: config.name,
    root: config.root,
    port: config.port,
    paths: config.paths,
    briefs: { dispatchDirs: config.briefs.dispatchDirs, ownerDirs: config.briefs.ownerDirs, recentDays: config.briefs.recentDays },
    reviewPagesDir: config.reviewPages ? config.reviewPages.dir : null,
    lanes: Object.entries(config.lanes).map(([id, lane]) => ({
      id,
      run: lane.run,
      outputDir: lane.outputDir || null,
      api: lane.api || null,
      serve: lane.serve || null,
      serialize: lane.serialize,
      defaultModel: lane.defaultModel || null,
    })),
    policy: config.policy,
  };
}

export function createSettingsRoutes({ config, home, env = process.env, homedir, omoFile = omoConfigFile(), fetchImpl = fetch, spawnImpl }) {
  const credentials = createCredentials({ env, ...(homedir ? { homedir } : {}) });

  // GET /api/settings/lanes — which server lanes answer now. POST /api/settings/lanes/<id>/start — start one from
  // its configured serve command. The command comes from the project config, never from the request.
  async function handleLaneServers(request, response, parts) {
    if (parts.length === 3 && request.method === 'GET') {
      sendJson(response, 200, { lanes: await laneServers(config, { fetchImpl }) });
      return;
    }
    if (parts.length === 5 && parts[4] === 'start' && request.method === 'POST') {
      const refusal = writeRefusal(request);
      if (refusal) { sendJson(response, 403, { error: refusal }); return; }
      const result = await startLaneServer({ config, laneId: parts[3], fetchImpl, ...(spawnImpl ? { spawnImpl } : {}) });
      sendJson(response, result.status, result.body);
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  }

  async function handle(request, response, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const isLanes = parts[0] === 'api' && parts[1] === 'settings' && parts[2] === 'lanes';
    if (url.pathname !== '/api/settings' && !isLanes) return false;
    const hostname = String(request.headers.host || '').split(':')[0];
    if (!LOCAL_HOSTS.has(hostname)) { sendJson(response, 403, { error: `host ${hostname || '(none)'} is not local` }); return true; }
    if (isLanes) { await handleLaneServers(request, response, parts); return true; }
    if (request.method === 'POST') {
      const refusal = writeRefusal(request);
      if (refusal) { sendJson(response, 403, { error: refusal }); return true; }
      const body = await readJsonBody(request, 256 * 1024);
      if (!body.raw || typeof body.raw !== 'object' || Array.isArray(body.raw)) { sendJson(response, 400, { error: 'raw must be the whole questboard.config.json object' }); return true; }
      try {
        const next = saveProjectConfig(config.root, body.raw);
        // The running server captured its config at startup, so nothing here takes effect until it restarts.
        sendJson(response, 200, { ok: true, restartRequired: true, project: describeProject(next), raw: body.raw });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return true;
    }
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'GET or POST' }); return true; }
    sendJson(response, 200, {
      project: describeProject(config),
      raw: readRawConfig(config.root),
      home: { dir: home.home, roster: home.roster, rosterExists: fs.existsSync(home.roster), status: home.status },
      usageKeys: PROVIDERS.filter((p) => p.keys || p.oauth).map((p) => ({
        id: p.id,
        name: p.name,
        sources: credentials.presence({ ...(p.keys || {}), oauthIds: p.oauth ? p.oauth.openCodeIds : [] }),
      })),
      openCodeAuthFile: { file: openCodeAuthFile({ env, ...(homedir ? { homedir } : {}) }), exists: fs.existsSync(openCodeAuthFile({ env, ...(homedir ? { homedir } : {}) })) },
      omo: { file: omoFile, exists: fs.existsSync(omoFile) },
    });
    return true;
  }

  return { handle };
}
