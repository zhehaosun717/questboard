// Composes the questboard HTTP server for one project.
import http from 'node:http';
import { URL } from 'node:url';
import { sendJson, routeParts } from './http.js';
import { BoardStore } from './boardStore.js';
import { createBoardRoutes } from './boardRoutes.js';
import { createQuestRoutes } from './questRoutes.js';
import { createPageRoutes } from './pages.js';
import { QuestStore } from '../core/store.js';
import { StatusLog } from '../core/status.js';
import { homePaths } from '../core/home.js';
import { createCollector } from '../lanes/collector.js';

export const HOST = '127.0.0.1';
const POLL_MS = 15000;

export function createServer({ config, home = homePaths(), runners, getLanes, evidenceWaitMs, writeDelivery, fetchImpl, webDist } = {}) {
  if (!config) throw new Error('createServer needs a project config');
  const boardStore = new BoardStore(config.paths.data);
  const store = new QuestStore(config);
  const statusLog = new StatusLog(home.status);
  const collector = createCollector(config, { fetchImpl });
  let lanesCache = null;
  const lanes = getLanes || (() => lanesCache);
  const quests = createQuestRoutes({ config, store, boardStore, statusLog, rosterFile: home.roster, getLanes: lanes, runners, evidenceWaitMs, writeDelivery });
  const routes = [createPageRoutes({ config, ...(webDist ? { webDist } : {}) }), quests, createBoardRoutes({ config, boardStore })];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    try {
      for (const route of routes) if (await route.handle(request, response, url, routeParts(url.pathname))) return;
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: error.message });
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
  Object.assign(server, { boardStore, store, statusLog, questRoutes: quests, collector });
  return server;
}

export function startServer(options) {
  const server = createServer(options);
  server.startBackground();
  const port = options.port || options.config.port;
  server.listen(port, HOST, () => {
    process.stdout.write(`questboard: ${options.config.name} at http://${HOST}:${server.address().port}\n`);
  });
  return server;
}
