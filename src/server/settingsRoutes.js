// GET /api/settings — a read-only summary of where this board reads and writes: the project config, the
// machine roster and status log, where usage keys would come from (present or not, never the key), and the
// OMO file. Paths are local facts, so only local host names get an answer.
import fs from 'node:fs';
import { LOCAL_HOSTS, sendJson } from './http.js';
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
      serialize: lane.serialize,
      defaultModel: lane.defaultModel || null,
    })),
    policy: config.policy,
  };
}

export function createSettingsRoutes({ config, home, env = process.env, homedir, omoFile = omoConfigFile() }) {
  const credentials = createCredentials({ env, ...(homedir ? { homedir } : {}) });

  async function handle(request, response, url) {
    if (url.pathname !== '/api/settings') return false;
    const hostname = String(request.headers.host || '').split(':')[0];
    if (!LOCAL_HOSTS.has(hostname)) { sendJson(response, 403, { error: `host ${hostname || '(none)'} is not local` }); return true; }
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'GET only' }); return true; }
    sendJson(response, 200, {
      project: describeProject(config),
      home: { dir: home.home, roster: home.roster, rosterExists: fs.existsSync(home.roster), status: home.status },
      usageKeys: PROVIDERS.filter((p) => p.keys).map((p) => ({ id: p.id, name: p.name, sources: credentials.presence(p.keys) })),
      openCodeAuthFile: { file: openCodeAuthFile({ env, ...(homedir ? { homedir } : {}) }), exists: fs.existsSync(openCodeAuthFile({ env, ...(homedir ? { homedir } : {}) })) },
      omo: { file: omoFile, exists: fs.existsSync(omoFile) },
    });
    return true;
  }

  return { handle };
}
