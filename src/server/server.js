// Composes the questboard HTTP server for one project.
import http from 'node:http';
import { URL } from 'node:url';
import { localHostRefusal, sendJson, routeParts } from './http.js';
import { BoardStore } from './boardStore.js';
import { createBoardRoutes } from './boardRoutes.js';
import { createQuestRoutes } from './questRoutes.js';
import { createPageRoutes } from './pages.js';
import { QuestStore } from '../core/store.js';
import { StatusLog } from '../core/status.js';
import { homePaths } from '../core/home.js';
import { createCollector } from '../lanes/collector.js';
import { createUsageRoutes } from './usageRoutes.js';
import { createOmoRoutes } from './omoRoutes.js';
import { createSettingsRoutes } from './settingsRoutes.js';
import { createUsageService } from '../usage/service.js';
import { validateBoardPort } from '../core/config.js';

export const HOST = '127.0.0.1';
const POLL_MS = 15000;

// The default usage service reads the project config (usage.manualProviders and the Alibaba choices), so a
// manual card enabled in settings reaches the running board; an injected `usage` still wins for tests.
export function createServer({ config, home = homePaths(), runners, getLanes, evidenceWaitMs, writeDelivery, fetchImpl, webDist, usage = createUsageService({ config }), omo = createOmoRoutes(), settingsEnv, checkLaneServers } = {}) {
  if (!config) throw new Error('createServer needs a project config');
  const boardStore = new BoardStore(config.paths.data);
  const store = new QuestStore(config);
  const statusLog = new StatusLog(home.status);
  const collector = createCollector(config, { fetchImpl });
  let lanesCache = null;
  const lanes = getLanes || (() => lanesCache);
  const quests = createQuestRoutes({ config, store, boardStore, statusLog, rosterFile: home.roster, getLanes: lanes, runners, evidenceWaitMs, writeDelivery, ...(checkLaneServers ? { checkLaneServers } : {}) });
  const routes = [createPageRoutes({ config, ...(webDist ? { webDist } : {}) }), quests, createBoardRoutes({ config, boardStore }), createUsageRoutes({ usage }), omo, createSettingsRoutes({ config, home, ...(settingsEnv ? { env: settingsEnv } : {}) })];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    const hostRefusal = localHostRefusal(request);
    if (hostRefusal) { sendJson(response, 403, { error: hostRefusal }); return; }
    try {
      const parts = routeParts(url.pathname);
      for (const route of routes) if (await route.handle(request, response, url, parts)) return;
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      if (!response.headersSent) {
        if (error.code === 'malformed_path_encoding') sendJson(response, 400, { error: '地址编码不正确' });
        else if (error.code === 'request_too_large') sendJson(response, 413, { error: '请求内容太大' });
        else sendJson(response, 500, { error: error.message });
      }
      else response.destroy();
    }
  });

  let pollTimer = null;
  // Background work starts only when asked, so tests that create a server never hang on timers.
  server.startBackground = () => {
    quests.start();
    if (getLanes) return;
    const poll = async () => {
      try { lanesCache = await collector.collect(); } catch (error) { process.stderr.write(`questboard: lane collector failed: ${error.message}\n`); }
    };
    poll();
    pollTimer = setInterval(poll, POLL_MS);
    pollTimer.unref();
  };
  server.on('close', () => { quests.stop(); if (pollTimer) clearInterval(pollTimer); });
  Object.assign(server, { boardStore, store, statusLog, questRoutes: quests, collector, refreshLaneHealth: quests.refreshLaneHealth });
  return server;
}

// `options.port` is an override on top of the project's own configured port (already validated when the
// config loaded); this is the one place that override reaches a real bind, so it gets the same board-port
// validation before anything starts. `options.port || options.config.port` used to fall back on a falsy
// override (0, NaN) instead of refusing it — every caller now either omits `port` (the default) or passes
// an already-valid one (src/cli/commands.js does), but this checks it again so no caller of this exported
// function can bind an unvalidated override just by skipping the CLI.
export function startServer(options) {
  const port = options.port === undefined ? options.config.port : validateBoardPort(options.port, '--port');
  const server = createServer(options);
  server.startBackground();
  server.listen(port, HOST, () => {
    process.stdout.write(`questboard: ${options.config.name} at http://${HOST}:${server.address().port}\n`);
  });
  return server;
}
