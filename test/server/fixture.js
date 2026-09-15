// A running server over a temporary project and a temporary questboard home, with fake runners.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../src/server/server.js';
import { saveRoster } from '../../src/core/roster.js';
import { makeProject, tmpDir, CARDS } from '../helpers.js';
import { isFetchBlockedPort } from './fetchBlockedPorts.js';

const MAX_PORT_ATTEMPTS = 8;

// Windows can hand listen(0) an ephemeral port that Node's fetch() then refuses to connect to (a
// WHATWG "bad port", see fetchBlockedPorts.js) — the server is fine, fetch() just won't touch it. Close
// that one listener and ask the OS for another; never touch anyone else's socket, never force a fixed port.
export async function listenOnSafePort(server, { maxAttempts = MAX_PORT_ATTEMPTS, isBlocked = isFetchBlockedPort } = {}) {
  const tried = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const onError = (err) => { server.removeListener('error', onError); reject(err); };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(server.address().port); });
    });
    tried.push(port);
    if (!isBlocked(port)) return { port, tried };
    await new Promise((resolve) => server.close(resolve));
  }
  const error = new Error(`fixture: OS kept offering Fetch-blocked ephemeral ports, gave up after ${maxAttempts} attempts: ${tried.join(', ')}`);
  error.tried = tried;
  throw error;
}

export async function startFixture({ runResult = () => ({ code: 0 }), writeDelivery, checkLaneServers, runners } = {}) {
  const project = makeProject({ reviewPages: { dir: 'docs/art' } });
  project.write('docs/briefs/RUN-4-the-way-back.md', 'RUN-4 — the way back');
  project.write('docs/briefs/REVIEW-26-review-run-4.md', 'review');
  project.write('docs/briefs/RUN-9-not-posted.md', 'RUN-9 — nobody posted this');
  project.write('docs/art/robot/review_robot8.html', '<script type="application/json" id="review-data">{"page":"robot8","title":"机器人 8","sections":[{"id":"a"},{"id":"b"}]}</script>');
  const homeDir = tmpDir('qb-home-');
  const home = { home: homeDir, roster: path.join(homeDir, 'roster.json'), status: path.join(homeDir, 'status.jsonl') };
  saveRoster(home.roster, { adventurers: CARDS.map(({ status, ...card }) => card) });
  const calls = [];
  const holder = { lanes: null };
  const server = createServer({
    config: project.config, home, evidenceWaitMs: 0, getLanes: () => holder.lanes,
    writeDelivery: writeDelivery || (async (config, lane, name) => path.join(config.root, '.work', 'oc', `${name}.md`)),
    checkLaneServers,
    // A caller that needs to inject a native fault mid-step (a broken quests.jsonl during the session step,
    // for a diagnostics-endpoint test) passes its own `runners`; every other test keeps the default fakes.
    runners: runners || {
      run: async (step) => { calls.push(step); return runResult(step); },
      session: async (step) => { calls.push(step); return { code: 0, session: 'ses_x' }; },
    },
  });
  const portSelection = await listenOnSafePort(server);
  const base = `http://127.0.0.1:${portSelection.port}`;
  const api = async (route, method = 'GET', body, headers = {}) => {
    let response;
    try {
      response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    } catch (err) {
      throw new Error(`fixture fetch failed: ${method} ${base}${route} — cause: ${err.cause?.message ?? err.message}`, { cause: err });
    }
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  const events = () => fs.existsSync(project.config.paths.events) ? fs.readFileSync(project.config.paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const close = () => new Promise((resolve) => server.close(resolve));
  return { project, home, server, base, api, calls, holder, events, close, portSelection };
}

export const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
